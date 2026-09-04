// Cloudflare Pages Function：HTTP 音频流中转
// 用法: /proxy?u=https%3A%2F%2F...  或 /proxy?u=http%3A%2F%2F...
//
// 为什么需要它：页面部署在 Cloudflare Pages 是 https，浏览器会拦截 https 页面里的
// http:// 音频流（mixed content）。此函数在服务端拉取 http 流，再以 https 流式返回，
// 从而让纯 http 电台也能播放。https 电台前端直连，不经过这里。
//
// 安全：仅放行 http/https；阻止内网/本机目标（防 SSRF / 开放代理滥用）。

const ALLOWED = new Set(["http:", "https:"]);
const UPSTREAM_TIMEOUT_MS = 15000;
const BLOCKED_HOSTS = new Set([
  "localhost", "127.0.0.1", "::1", "0.0.0.0",
  "metadata.google.internal",
]);
// 常见内网/保留网段前缀（IPv4 前 3 段判断即可覆盖 CGNAT 与私网）
function isBlockedIp(hostname) {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [+m[1], +m[2]];
  if (a === 10) return true;                    // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;      // 192.168/16
  if (a === 169 && b === 254) return true;      // link-local
  if (a === 127) return true;                   // loopback
  return false;
}

export async function onRequestGet(context) {
  return handle(context.request);
}
// POST 也放行（某些客户端以 POST 拉流），其余方法拒绝
export async function onRequestPost(context) {
  return handle(context.request);
}
export async function onRequest(context) {
  return handle(context.request);
}

async function handle(request) {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("u");
  if (!target) {
    return json({ error: "missing ?u=" }, 400);
  }
  let up;
  try {
    up = new URL(target);
  } catch {
    return json({ error: "bad url" }, 400);
  }
  if (!ALLOWED.has(up.protocol)) {
    return json({ error: "only http/https allowed" }, 400);
  }
  if (BLOCKED_HOSTS.has(up.hostname) || isBlockedIp(up.hostname)) {
    return json({ error: "target not allowed" }, 400);
  }

  // 透传关键请求头（Range 支持拖动/续传、UA/Referer 帮助绕过部分服务器默认拦截）
  const headers = { "User-Agent": "RadioWeb/1.0 (proxy)" };
  const fwd = ["range", "accept", "accept-language", "icecast-auth-user", "referer"];
  for (const h of fwd) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }

  // 上游 15s 内拉不到响应即放弃——慢到这种程度的流基本不可播，
  // 快速失败让前端给出明确提示，而不是让 <audio> 无限缓冲/超时
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(up.href, { headers, redirect: "follow", signal: ctl.signal });
  } catch (e) {
    const timeout = e.name === "AbortError";
    return json({ error: timeout ? "upstream timeout" : "upstream unreachable: " + String(e) }, timeout ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok && resp.status !== 206 && resp.status !== 200) {
    // 404/403 等：原样透传状态码与正文给前端 audio，便于错误提示
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // 流式返回；清除 hop-by-hop 头
  const out = new Response(resp.body, {
    status: resp.status,
    headers: {
      "content-type": resp.headers.get("content-type") || "application/octet-stream",
      "cache-control": "no-store",
      "x-proxy": "radio-web",
    },
  });
  const range = resp.headers.get("content-range");
  if (range) out.headers.set("content-range", range);
  const acceptRanges = resp.headers.get("accept-ranges");
  if (acceptRanges) out.headers.set("accept-ranges", acceptRanges);
  return out;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
