/* Radio Web · 纯前端电台播放器
 * 数据源: radio-browser.info 开放 API（浏览器直连，CORS 已放行）
 * 播放策略:
 *   - https 流 -> 直连 <audio>
 *   - http  流 -> 走本站 /proxy?u=...（Cloudflare Pages Function 中转，规避 mixed-content）
 * 收藏: localStorage 持久化
 */
"use strict";

// ---------- 常量 ----------
const API_HOSTS = [
  "https://de1.api.radio-browser.info",
  "https://de2.api.radio-browser.info",
  "https://at1.api.radio-browser.info",
];
const MAX_FETCH = 500; // 单次搜索最多从 API 拉取条数（API 不返回总条数，取回后本地分页展示）
const PAGE_SIZE = 20;  // 每页展示条数
const FAV_KEY = "radio-web-favs";
const VOL_KEY = "radio-web-vol";
const MAX_FAVS = 300;

// ---------- 状态 ----------
let results = [];       // 当前搜索结果（含 fav 状态补全）
let favs = loadFavs();  // 收藏列表
let current = null;     // { ...station, fav:bool }
let audio = null;       // HTMLAudioElement
let playing = false;
let view = "search";
let lastQuery = "";
let curPage = 0;            // 当前页（0 起，本地分页）
let totalPages = 1;         // 本地总页数

// ---------- DOM ----------
const $ = (s) => document.querySelector(s);
const tabSearch = document.querySelector('.tab[data-view="search"]');
const tabFavs = document.querySelector('.tab[data-view="favs"]');
const viewSearch = $("#view-search");
const viewFavs = $("#view-favs");
const favCount = $("#favCount");
const player = $("#player");
const nowTitle = $("#nowTitle");
const nowSub = $("#nowSub");
const liveDot = $("#liveDot");
const btnPlay = $("#btnPlay");
const btnFav = $("#btnFav");
const volume = $("#volume");
const toastEl = $("#toast");
const searchInput = $("#searchInput");
const searchStatus = $("#searchStatus");
const searchCount = $("#searchCount");
const resultList = $("#resultList");
const favList = $("#favList");
const favEmpty = $("#favEmpty");
const pager = $("#pager");
const pgPrev = $("#pgPrev");
const pgNext = $("#pgNext");
const pgNums = $("#pgNums");

// ---------- localStorage ----------
function loadFavs() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); }
  catch { return []; }
}
function saveFavs() {
  localStorage.setItem(FAV_KEY, JSON.stringify(favs));
  favCount.textContent = favs.length ? String(favs.length) : "";
  favEmpty.hidden = favs.length > 0;
}
function isFav(url) { return favs.some((f) => f.url === url); }

// ---------- 工具 ----------
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, ms);
}

// 把一条 API 记录规整为内部 station 对象
function norm(s) {
  const url = (s.url_resolved || s.url || "").trim();
  const name = (s.name || "").trim();
  const codec = (s.codec || "").toUpperCase();
  const bitrate = s.bitrate ? s.bitrate + "k" : "";
  const country = (s.countrycode || s.country || "").toString();
  const lang = (s.language || "").toString();
  const tags = (s.tags || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 3);
  const parts = [];
  if (bitrate) parts.push(bitrate);
  if (codec) parts.push(codec);
  const geo = [country, lang].filter(Boolean).join(" · ");
  const meta = (parts.length ? parts.join(" ") + "  ·  " : "") + geo;
  const hls = /\.m3u8(\?|$)/i.test(url);
  return { name, url, codec, bitrate, country, lang, tags, meta, hls, fav: isFav(url) };
}

// 可播放地址：http 走本地中转
function playableUrl(st) {
  if (/^https:\/\//i.test(st.url)) return st.url;
  // http:// 或其它 -> 经 /proxy 中转（Cloudflare Pages Function）
  return "proxy?u=" + encodeURIComponent(st.url);
}

// ---------- 播放器 ----------
function ensureAudio() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = "none";
  // 挂载到 DOM（无 controls 不可见）：保证 iOS Safari 后台播放、媒体键
  // 控制与系统锁屏“正在播放”正常工作；同时便于状态检查。
  document.body.appendChild(audio);
  audio.addEventListener("playing", () => { playing = true; paintPlay(); });
  audio.addEventListener("pause", () => { playing = false; paintPlay(); });
  audio.addEventListener("waiting", () => { liveDot.hidden = false; nowSub.textContent = "缓冲中…"; });
  audio.addEventListener("error", () => {
    const st = current;
    if (!st) return;
    playing = false; paintPlay();
    liveDot.hidden = true;
    nowSub.textContent = "播放失败";
    const note = /^http:\/\//i.test(st.url)
      ? "连接失败（http 流经中转仍不可达，可能电台已失效或地域限制）"
      : "连接失败：电台可能已失效、防盗链或地域限制";
    toast(note, 4000);
  });
  // 直播流：duration 无限 -> 不显示时长，统一 LIVE
  audio.addEventListener("loadedmetadata", () => {
    if (isFinite(audio.duration) && audio.duration > 0) {
      liveDot.hidden = true;
      nowSub.textContent = current ? current.meta : "";
    }
  });
  return audio;
}

function playStation(st) {
  if (!st || !st.url) return toast("该电台没有可用地址");
  current = st;
  const a = ensureAudio();
  nowTitle.textContent = st.name || "未命名电台";
  if (!/^https:\/\//i.test(st.url)) {
    nowSub.textContent = "http 流 · 经中转连接…";
    liveDot.hidden = true;
  } else {
    nowSub.textContent = st.meta || "连接中…";
    liveDot.hidden = true;
  }
  player.hidden = false;
  // 收藏按钮状态
  btnFav.classList.toggle("on", st.fav);
  paintListHighlight();
  a.src = playableUrl(st);
  a.play().catch((e) => {
    // 自动播放被策略拦截（首次需用户手势）——此处均由点击触发，正常不会走到
    toast("播放被浏览器拦截，请再次点击条目");
  });
}

function togglePlay() {
  if (!current) return;
  const a = ensureAudio();
  if (playing) a.pause();
  else a.play().catch(() => toast("播放失败"));
}
function paintPlay() {
  // 图标显隐交给 CSS 的 #btnPlay.playing 双态规则（不用 hidden：WebKit 对 SVG 的
  // hidden 属性支持不稳，会导致播放/暂停两个图标同时显示）
  btnPlay.classList.toggle("playing", playing);
  if (playing && current && current.hls) {
    liveDot.hidden = false;
  }
}

// ---------- 收藏 ----------
function toggleFav(st) {
  if (!st) return;
  if (st.fav) {
    favs = favs.filter((f) => f.url !== st.url);
    st.fav = false;
  } else {
    if (favs.length >= MAX_FAVS) return toast("收藏已满");
    favs.push({ name: st.name, url: st.url, meta: st.meta, codec: st.codec });
    st.fav = true;
  }
  // 同步搜索结果列表里同 URL 行的收藏标志
  for (const r of results) if (r.url === st.url) r.fav = st.fav;
  saveFavs();
  syncFavButtons(st.url, st.fav); // 立即点亮/熄灭两列表中同 URL 行的星号（不重绘，保持滚动位置）
  if (current && current.url === st.url) {
    current.fav = st.fav;
    btnFav.classList.toggle("on", st.fav);
  }
  paintListHighlight();
  if (view === "favs") {
    // 从收藏视图移除后重绘
    renderFavs();
    if (!st.fav) toast("已取消收藏");
  } else {
    toast(st.fav ? "已加入收藏 ⭐" : "已取消收藏");
  }
}

// 同 URL 行（搜索结果/收藏两列表）的收藏星号立即切换，不做整表重绘（保持滚动位置）
function syncFavButtons(url, fav) {
  const star = fav ? "★" : "☆";
  [resultList, favList].forEach((ul) => {
    ul.querySelectorAll("li").forEach((li) => {
      if (li.dataset.url !== url) return;
      const b = li.querySelector("[data-act=fav]");
      if (b) {
        b.classList.toggle("on", fav);
        b.textContent = star;
      }
    });
  });
}

// ---------- 列表渲染 ----------
function rowHTML(st) {
  const playIcon = `
    <span class="play-icon">
      <svg class="ic-pl" viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      <svg class="ic-pa" viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
    </span>`;
  const tags = (st.tags || []).map((t) => `<span class="tag plain">${esc(t)}</span>`).join("");
  const httpBadge = /^http:\/\//i.test(st.url) ? `<span class="tag">http·中转</span>` : "";
  const hlsBadge = st.hls ? `<span class="tag">HLS</span>` : "";
  return `
    ${playIcon}
    <div class="info">
      <div class="name">${esc(st.name) || "(未命名)"}</div>
      <div class="meta">${tags}${httpBadge}${hlsBadge}${esc(st.meta)}</div>
    </div>
    <button class="fav ${st.fav ? "on" : ""}" data-act="fav" aria-label="收藏">${st.fav ? "★" : "☆"}</button>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function stationAt(ul, li) {
  const i = +li.dataset.i;
  if (ul === favList) {
    const f = favs[i];
    return f ? { ...f, fav: true, tags: [], hls: /\.m3u8/i.test(f.url), meta: f.meta || "" } : null;
  }
  return results[i] || null;
}

function renderResults() {
  const start = curPage * PAGE_SIZE;
  const slice = results.slice(start, start + PAGE_SIZE);
  resultList.innerHTML = slice.map((st, i) =>
    `<li data-i="${start + i}" data-url="${esc(st.url)}">${rowHTML(st)}</li>`
  ).join("");
  paintListHighlight(); // 重绘后恢复“正在播放”行的高亮
  const n = results.length;
  searchCount.hidden = n === 0;
  searchCount.textContent = n
    ? `共 ${n} 个电台${n >= MAX_FETCH ? "（仅显示前 " + MAX_FETCH + " 条，建议缩小关键词）" : ""} · 点击或双击播放`
    : "";
  renderPager();
}

// ---- 页码条：上一页/下一页 + 数字页码（首尾固定、当前页附近展开，间隔用省略号） ----
function pagerNums() {
  const n = totalPages, c = curPage + 1;
  if (n <= 7) return Array.from({ length: n }, (_, i) => i + 1);
  const want = new Set([1, n, c - 1, c, c + 1]);
  const pages = [...want].filter((p) => p >= 1 && p <= n).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    if (i && pages[i] - pages[i - 1] > 1) out.push("…");
    out.push(pages[i]);
  }
  return out;
}
function renderPager() {
  totalPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  pager.hidden = totalPages <= 1;
  if (pager.hidden) return;
  pgPrev.disabled = curPage === 0;
  pgNext.disabled = curPage >= totalPages - 1;
  pgNums.innerHTML = pagerNums().map((p) =>
    p === "…"
      ? `<span class="pg-ell">…</span>`
      : `<button class="pg-num${p === curPage + 1 ? " on" : ""}" data-p="${p}">${p}</button>`
  ).join("");
}
function goPage(p) {
  if (p < 0 || p >= totalPages || p === curPage) return;
  curPage = p;
  renderResults();
  // 回到结果区顶部（页码条贴视口上沿，便于连续翻页）
  pager.scrollIntoView({ block: "start" });
}

function renderFavs() {
  favList.innerHTML = favs.map((f, i) => {
    const st = { ...f, fav: true, tags: [], hls: /\.m3u8/i.test(f.url), meta: f.meta || "" };
    return `<li data-i="${i}" data-url="${esc(st.url)}">${rowHTML(st)}</li>`;
  }).join("");
}

// 高亮正在播放的行：纯 class 切换，不重绘（保持滚动位置）
function paintListHighlight() {
  [resultList, favList].forEach((ul) => {
    ul.querySelectorAll("li").forEach((li) => {
      li.classList.toggle("playing", !!(current && li.dataset.url === current.url));
      const favBtn = li.querySelector("[data-act=fav]");
      if (favBtn && current && li.dataset.url === current.url) {
        favBtn.classList.toggle("on", !!current.fav);
        favBtn.textContent = current.fav ? "★" : "☆";
      }
    });
  });
}

// 条目点击：整行播放；右侧 ☆ 收藏
function bindList(ul) {
  ul.addEventListener("click", (e) => {
    const favBtn = e.target.closest("[data-act=fav]");
    const li = e.target.closest("li");
    if (!li) return;
    const st = stationAt(ul, li);
    if (!st) return;
    if (favBtn) { toggleFav(st); return; }
    playStation(st);
  });
}
bindList(resultList);
bindList(favList);

// ---------- 搜索 ----------
async function search(q) {
  q = q.trim();
  if (!q) return;
  lastQuery = q;
  curPage = 0;
  searchStatus.hidden = false;
  searchStatus.textContent = "正在搜索…";
  searchCount.hidden = true;
  pager.hidden = true;
  resultList.innerHTML = "";
  // API 不返回匹配总数：一次取回上限 MAX_FETCH 条，之后本地按 PAGE_SIZE 分页
  const params = new URLSearchParams({
    name: q, limit: MAX_FETCH, offset: 0,
    order: "clickcount", reverse: "true", hidebroken: "false",
  });
  for (const host of API_HOSTS) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(`${host}/json/stations/search?${params}`, {
        signal: ctl.signal,
        headers: { "User-Agent": "RadioWeb/1.0 (+https://github.com/yourname/radio-web)" },
      });
      clearTimeout(t);
      if (!r.ok) continue;
      const arr = await r.json();
      results = (Array.isArray(arr) ? arr : []).map(norm);
      searchStatus.hidden = true;
      renderResults();
      syncHash(q);
      return;
    } catch (e) { /* 尝试下一镜像 */ }
  }
  searchStatus.textContent = "搜索失败：所有 API 镜像都不可达，请检查网络后重试";
}

// ---------- URL hash 直达 ----------
function parseHash() {
  const m = location.hash.match(/^#q=(.+)$/);
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch { return ""; }
}
function syncHash(q) {
  const target = "#q=" + encodeURIComponent(q);
  if (location.hash !== target) history.replaceState(null, "", target);
}
window.addEventListener("hashchange", () => {
  const q = parseHash();
  if (q && q !== lastQuery) { searchInput.value = q; search(q); }
});

// ---------- 视图切换 ----------
function setView(v) {
  view = v;
  tabSearch.classList.toggle("active", v === "search");
  tabFavs.classList.toggle("active", v === "favs");
  viewSearch.classList.toggle("active", v === "search");
  viewFavs.classList.toggle("active", v === "favs");
  if (v === "favs") { saveFavs(); renderFavs(); }
}
tabSearch.addEventListener("click", () => setView("search"));
tabFavs.addEventListener("click", () => setView("favs"));

$("#searchForm").addEventListener("submit", (e) => { e.preventDefault(); search(searchInput.value); });

// 页码条：上一页 / 下一页 / 数字页码
pager.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b === pgPrev) goPage(curPage - 1);
  else if (b === pgNext) goPage(curPage + 1);
  else if (b.dataset.p) goPage(+b.dataset.p - 1);
});

// 启动时若 URL 带 #q=...，直接打开并搜索该关键词（用于分享）
const initQ = parseHash();
if (initQ) { searchInput.value = initQ; search(initQ); }

// 收藏数徽标
favCount.textContent = favs.length ? String(favs.length) : "";

// 播放/暂停与音量
btnPlay.addEventListener("click", togglePlay);
btnFav.addEventListener("click", () => toggleFav(current));
volume.addEventListener("input", () => {
  ensureAudio().volume = +volume.value;
  localStorage.setItem(VOL_KEY, String(volume.value));
});

// 音量恢复
const savedVol = parseFloat(localStorage.getItem(VOL_KEY));
if (!isNaN(savedVol)) { volume.value = savedVol; ensureAudio().volume = savedVol; }
