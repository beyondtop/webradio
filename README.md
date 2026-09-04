# Radio Web · 网络电台播放器（纯前端）

一个极简的 Web 电台播放器：搜索全球网络电台、双击收听、收藏管理。零框架、零构建、零后端依赖，可直接部署到 Cloudflare Pages。

![radio-web](./preview.png)

## 功能

- 🔍 **电台搜索**：调 [radio-browser.info](https://www.radio-browser.info) 开放 API（全球最大开源电台数据库，无需 key），支持中文关键词，按社区点击量排序，一次最多取回 500 条
- 📄 **页码分页**：每页展示 20 条，底部「上一页/下一页 + 数字页码」可跳页；接口不返回总条数，故用"取满上限才提示仅显示前 500 条"兜底
- 🔗 **#q= 直达**：URL 带 `#q=lofi%20hip%20hop` 直接打开即自动搜索，方便分享
- ▶️ **即点即播**：点击条目立即播放；正在播放的行高亮
- 🌐 **http 流也能播**：页面是 https，浏览器会拦 http:// 音频流——本仓库内置一个 Cloudflare Pages Function 做音频中转，http 台自动走 `/proxy?u=…` 服务端拉流再以 https 返回（列表中标 `http·中转`）
- ⭐ **收藏**：localStorage 本地持久化，不依赖账号
- 📱 **移动端适配**：触屏友好、底部播放条含刘海安全区；audio 挂载 DOM，iOS 支持锁屏/媒体键
- 🌙 **深浅色**：跟随系统 `prefers-color-scheme`

## 目录结构

```
radio-web/
├── index.html          # 单页结构
├── style.css           # 全部样式（无框架）
├── app.js              # 全部逻辑：搜索/播放/收藏/中转判定
├── functions/
│   └── proxy.js        # Cloudflare Pages Function：http→https 音频中转
└── test-proxy.mjs      # 中转函数的本地单测（node test-proxy.mjs）
```

## 播放策略（核心设计）

| 电台流协议 | 处理方式 |
|---|---|
| `https://…` | `<audio>` 直接播放 |
| `http://…` | 自动改写为同源 `/proxy?u=<原始URL>`，由 Pages Function 在服务端拉流 |
| `.m3u8` (HLS) | 列表中标注 `HLS`；仅 Safari 原生支持，Chrome/Edge 无法播放 |

`functions/proxy.js` 要点：仅放行 http/https 且拒绝内网目标（防开放代理滥用）；透传 `Range`（支持流式/续传）与 UA；流式转发不落盘；`no-store` 不缓存直播流。

## 本地运行

```bash
python3 -m http.server 8000     # 任意静态服务器即可
# 打开 http://127.0.0.1:8000
```

> 注意：本地纯静态下 **http 电台的中转不可用**（`/proxy` 只存在于 Cloudflare 环境）。本地验证请搜 https 台；http 台的中转逻辑用 `node test-proxy.mjs` 单独测。

## 部署到 Cloudflare Pages

### 方式 A：GitHub 自动部署（推荐）

1. 推到 GitHub：
   ```bash
   git init && git add -A && git commit -m "radio web player"
   git remote add origin https://github.com/<你的用户名>/radio-web.git
   git push -u origin main
   ```
2. Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect to Git**，选这个仓库
3. 构建配置：
   - **Framework preset**：None
   - **Build command**：（留空）
   - **Build output directory**：`/`
4. 保存即部署，`functions/proxy.js` 会被自动识别为 Pages Function，`/proxy` 路由开箱即用

### 方式 B：本地 wrangler 上传（无 GitHub）

```bash
npm i -g wrangler            # 或用 npx wrangler
wrangler login
wrangler pages deploy . --project-name radio-web
```

## 数据源与致谢

- 电台数据：**[radio-browser.info](https://www.radio-browser.info)** 开源社区数据库（API 免费、无 key、CORS 全放行，镜像服务器多）
- 本项目代码基于个人 macOS 播放器 [macos-music](https://github.com/你的用户名/macos-music) 的电台搜索模块移植（Rust/AppKit → Web）

## License

MIT
