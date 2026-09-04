// Radio Web Service Worker：缓存应用外壳，实现"安装后可离线启动 + 秒开"
// 说明：只缓存站内静态资源；直播流(/proxy)与跨域的电台 API 一律走网络，绝不缓存。
const CACHE = "radio-web-v1";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./vendor/hls.min.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})            // 单个资源失败不阻塞安装
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                       // 非 GET 交给浏览器
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // 跨域(电台 API / 音频流)不介入
  // 直播流中转：必须实时，不能缓存
  if (url.pathname.endsWith("/proxy") || url.pathname.endsWith("/proxy/")) return;

  // stale-while-revalidate：先给缓存秒开，同时后台更新
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit || (req.mode === "navigate"
          ? caches.match("./index.html")
          : new Response("离线且无可用缓存", {
              status: 503,
              headers: { "content-type": "text/plain; charset=utf-8" },
            })));
      return hit || net;
    })
  );
});
