// 单测 proxy.js 的核心 handle 逻辑：模拟 Cloudflare Pages Function 运行环境。
// 用法: node test-proxy.mjs
import { onRequest } from "./functions/proxy.js";

function fakeContext(request) {
  return { request, env: {}, waitUntil() {} };
}
async function check(name, cond) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) process.exitCode = 1;
}

// 1) 缺 u 参数 -> 400
{
  const r = new Request("https://radio-web.example/proxy");
  const res = await onRequest(fakeContext(r));
  await check("missing u -> 400", res.status === 400);
}

// 2) 非 http(s) 目标 -> 400
{
  const r = new Request("https://radio-web.example/proxy?u=ftp%3A%2F%2Fx");
  const res = await onRequest(fakeContext(r));
  await check("ftp target -> 400", res.status === 400);
}

// 3) 内网 IP -> 400
{
  const r = new Request("https://radio-web.example/proxy?u=http%3A%2F%2F127.0.0.1%2Fstream");
  const res = await onRequest(fakeContext(r));
  await check("loopback -> 400", res.status === 400);
}

// 4) 真实 http 电台流 -> 200 + audio/mpeg + 流式 body 头几字节
{
  const target = encodeURIComponent("http://jking.cdnstream1.com/b22139_128mp3");
  const r = new Request("https://radio-web.example/proxy?u=" + target);
  const res = await onRequest(fakeContext(r));
  await check("http stream -> " + res.status, res.status === 200);
  await check("content-type audio/mpeg", (res.headers.get("content-type") || "").includes("audio/mpeg"));
  const ct = res.headers.get("cache-control");
  await check("cache-control no-store", ct === "no-store");
  if (res.body) {
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const head = new TextDecoder().decode(value).slice(0, 2);
    // MP3 frame 同步字 0xFF 0xFB / 0xFF 0xF3 等
    await check("streamed bytes start with MP3 sync (0xff 0x" + head.charCodeAt(1).toString(16) + ")", value && value[0] === 0xff);
    await reader.cancel();
  }
}
console.log("done");
