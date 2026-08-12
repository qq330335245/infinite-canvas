# Infinite Canvas — local dev preview

Day-to-day UI work must use **Vite HMR**, not production `build`.
A full `vite build` on this lab host takes ~15–17 minutes and is only for Pages deploy.

## Prerequisites

```bash
cd /root/work/infinite-canvas/web
# node_modules already installed — do not reinstall unless broken
test -x node_modules/.bin/vite
```

## Start dev server (incremental)

```bash
cd /root/work/infinite-canvas/web
npm run dev
# equivalent: npm run dev:local
```

- URL: `http://127.0.0.1:3000` (also on LAN via `0.0.0.0:3000`)
- Edit any file under `src/` → hot update in seconds
- Grok2API Base URL / API Key: configure in the app UI (point at local or HTTPS tunnel)

## Point at local grok2api

In the canvas config dialog:

| Field | Example |
|-------|---------|
| Base URL | `http://127.0.0.1:18000/v1` or `https://<trycloudflare>/v1` |
| API Key  | contents of `/root/work/grok2api-local-runtime/client.key` |

Browser pages on plain HTTP can call local HTTP API.
If you open canvas via HTTPS production domain, Base URL **must** be HTTPS (Mixed Content).

## 发版一条龙：GitHub Actions build → Cloudflare Pages（**不要在 p30 build**）

Workflow：`.github/workflows/deploy-infinite-canvas.yml`

```text
push main (web/**) 或手动 Run workflow
        ↓
  ubuntu runner: bun install + vite build (VITE_BASE=/)
        ↓
  artifact: infinite-canvas-web-dist
        ↓
  wrangler pages deploy → project **infinite-canvas**
        ↓
  https://i-canvas.konsin.de5.net  （及 *.pages.dev）
```

### 一次性配置（仓库 Secrets）

GitHub → `basketikun/infinite-canvas` → **Settings → Secrets and variables → Actions** 增加：

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | API Token，权限至少 **Cloudflare Pages — Edit**（建议 Account 级 Pages 写） |
| `CLOUDFLARE_ACCOUNT_ID` | CF 账户 ID（Dashboard 右侧） |

可选：创建 **Environment** `cloudflare-pages`（workflow 已引用），把上述 secrets 绑在 environment 上更稳。

**Token 不要写进 git / DEV / memory / 聊天记录。** 只放在 GitHub Secrets。

### 日常怎么发

1. 本机改 UI：`npm run dev` 看效果（HMR）。
2. 满意后 **commit + push `main`**（或 Actions 里 **Deploy Infinite Canvas → Run workflow**）。
3. 等绿色 → 打开 `https://i-canvas.konsin.de5.net` 强刷验证。
4. 本机 **不需要** `npm run build` / 本机 wrangler。

PR 只会 **build + 上传 artifact**，不会 deploy 生产。

### 只要 dist、不部署

Actions → **Build web dist**（手动）或从 Deploy 工作流下载 artifact `infinite-canvas-web-dist`。

### 本机 build（不推荐，应急）

```bash
npm run build          # ~15–17 min on p30 — 尽量避免
npx wrangler pages deploy dist --project-name infinite-canvas
```

## Access via 盒子 frpc (LAN)

**Do not put raw `npm run dev` behind frpc for daily browsing.**  
Vite dev serves *thousands* of unbundled modules; frp + many parallel tiny requests → blank spinner / empty reply / multi‑minute loads.

For remote LAN open, use **preview of `dist/`** (few large files). **`dist` 来自 GitHub artifact**，不要为了 frp 在 p30 上 build：

```bash
cd /root/work/infinite-canvas/web
# dist 已从 Actions 解压到位后：
npx vite preview --host 0.0.0.0 --port 3000
```

Local iteration on the phone itself: still use `npm run dev` at `http://127.0.0.1:3000` (HMR).

After frpc maps are live (p30 → frps on `192.168.15.144`):

| Service | URL |
|---------|-----|
| Canvas Vite dev | `http://192.168.15.144:22300` |
| Local grok2api API | `http://192.168.15.144:22226` |

In the app config dialog set Base URL to:

```text
http://192.168.15.144:22226/v1
```

Optional HMR when opening via frp host/port (restart `npm run dev` after export):

```bash
export VITE_HMR_HOST=192.168.15.144
export VITE_HMR_CLIENT_PORT=22300
npm run dev
```

If HMR WebSocket is flaky through frp, just refresh the page after edits — still far faster than production build.

### CORS / HTTPS notes

- **Canvas frp HTTP + API frp HTTP** (different ports = different origins): grok2api must allow Origin `http://192.168.15.144:22300` (lab CORS defaults include this after the middleware update + backend rebuild/restart).
- **Production HTTPS canvas** (`https://i-canvas.konsin.de5.net`) **cannot** call plain `http://192.168.15.144:22226` (Mixed Content). Keep using HTTPS API tunnel for that case.
- frp TCP here is **not HTTPS**; it is for LAN/dev only.

## Do not

- Run `npm run build` after every small UI tweak
- Delete `node_modules` “to be safe”
- Use 阿里云 / Armbian boxes as build hosts
