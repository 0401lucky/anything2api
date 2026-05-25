# anything2api：自带账号改造设计（BYO Account）

- 日期：2026-05-25
- 状态：草案，待用户复核
- 作者：brainstorming 会话产出
- 关联报告：[`report-2026-05-25-claude-opus-4-7-thinking.md`](../../../report-2026-05-25-claude-opus-4-7-thinking.md)

---

## 1. 背景与动机

当前的 `anything2api` 通过 Razmail 临时邮箱 + GraphQL `SignUpWithAppPrompt` + Magic Link 自动批量注册 anything.com 账号，再由 puppeteer 维护浏览器会话来转发请求。

anything.com 已经限制了批量注册（注册接口被风控或限流），这条路径不再可持续。但其余基础设施仍然有效：

- 浏览器内 fetch 调 `/api/graphql` 的 `GenerateProjectGroupRevisionFromChat` / `GetLatestRevisionForProxy` 仍是当前生成生成的可用通道。
- `lS_authToken` (15 分钟) + `refresh_token` (≈1 年滑动续期) 的鉴权机制不变，浏览器持久 cookie 即可长期工作。
- 账号池、负载均衡、失败 cooldown 都是有价值的工程能力。

目标：把"批量自动注册"换成"用户自带账号"，并允许在 Zeabur 这类只能跑容器的平台上完成 Google 登录与账号管理。

## 2. 目标 & 非目标

### 2.1 目标

1. 移除所有自动注册逻辑（Razmail / `SignUpWithAppPrompt` / Magic Link 邮件轮询 / 自动补货 worker）。
2. 用户通过 **Web 控制台 + 容器内 noVNC** 把自己的 Google 账号登录到 anything.com，让系统接管这个 session。
3. 同时支持本地登录后 **打包导出 → 上传导入** 到云端容器。
4. 保留 OpenAI / Anthropic 兼容的 2api 层，行为不变。
5. 保留多账号池、失败切号、cooldown、deleted 策略；新增基于 HTTP 状态码的立即切号。
6. 加 API_KEYS 鉴权与控制台密码鉴权，避免裸奔。
7. 提供 Dockerfile 与 Zeabur 部署文档，使云端登录与日常使用闭环。
8. 保留 Cloudflare Worker 反代（`worker/anything2api`），作为可选的源站前置。
9. 保留 `/metrics` + Prometheus / Grafana 工程。

### 2.2 非目标

1. 不在 Cloudflare Workers / Pages 上跑主服务（Workers 没有 Node、文件系统、Chromium，根本跑不动）。
2. 不实现"账密 + TOTP 自动填充"登录（anything.com 走 Google OAuth，没意义）。
3. 不实现"同时登录多个账号"——同时只允许一个 VNC 登录会话进行。日常服务请求当然可以多账号并发使用。
4. 不重写 `/v1/*` 路由的 OpenAI/Anthropic 协议适配（output-cleaning / tool-calls / streaming 保持原样）。
5. 不引入前端构建工具链（React/Vue/Vite）。控制台用 vanilla JS + 单页 HTML 实现。

## 3. 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│ 容器（本地 / Zeabur / VPS / 其他 Docker host）                     │
│                                                                   │
│  HTTP :7860                                                       │
│  ├ /v1/*           API_KEYS 鉴权 → AnythingProxyBackend           │
│  ├ /v1/models      （同上）                                       │
│  ├ /v1/messages    （同上）                                       │
│  ├ /v1/responses   （同上）                                       │
│  ├ /metrics        METRICS_TOKEN 可选鉴权                          │
│  ├ /healthz        无鉴权                                          │
│  └ /admin/*        WEB_CONSOLE_PASSWORD（cookie session）          │
│      ├ /admin/             控制台首页（静态）                      │
│      ├ /admin/api/accounts CRUD                                   │
│      ├ /admin/api/login/*  VNC 登录会话                            │
│      ├ /admin/api/auth/*   tar.gz 导入导出                         │
│      ├ /admin/api/usage    usage-stats.jsonl 聚合                  │
│      └ /admin/vnc/<sid>    websockify 反代到容器内 :6080           │
│                                                                   │
│  AnythingProxyBackend                                             │
│  ├ AccountPool        持有 data/account-pool.json                  │
│  ├ BrowserSupervisor  每账号一个 headless puppeteer 长跑           │
│  ├ VncSupervisor      按需 spawn Xvfb/x11vnc/websockify + head-ful │
│  ├ UsageTracker       追加 data/usage-stats.jsonl                  │
│  └ MetricsRegistry    Prometheus exporter                          │
└──────────────────────────────────────────────────────────────────┘
              ▲                                            │
              │ 反代（可选）                                │ GraphQL
              │                                            ▼
       Cloudflare Worker                          https://www.anything.com
       (worker/anything2api)                            /api/graphql
```

## 4. 文件结构改动

### 4.1 删除

| 文件 | 原因 |
| --- | --- |
| `src/register.ts` | Razmail 邮箱 + signupAnything + Magic Link 全部废弃 |
| `test/register.test.ts` | 对应测试 |
| `src/pool-expander.ts` | 后台自动补货线程 |
| `src/pool-expander-worker.ts` | 同上 worker_threads |

> 注意：`register.ts` 里 `formatError` / `formatLocalTimestamp` 这两个工具函数仍在多处被引用，迁移到 `src/util/error.ts` 与 `src/util/time.ts`（见 §4.3）。

### 4.2 改造

| 文件 | 主要改动 |
| --- | --- |
| `src/account.ts` | `registerAndLogin` → `loginInteractive(options)`：负责申请 VNC display、启 head-ful puppeteer、轮询登录完成、抓 userId/projectGroupId、落盘 session。`loadOrCreateSession` 删除（不再"找不到就自动注册"）。 |
| `src/account-pool.ts` | 删 `ensureMinimumAccountsUnlocked` 里的自动注册分支；保留 acquire / markSuccess / markFailure / addPreparedSession / listAccounts / getSummary；新增 `removeAccount(accountId)`、`reactivateAccount(accountId)`。删 `bootstrapPromise` / `warmInBackground` / `ensureReady`。`MAX_POOL_SIZE` 默认调低（如 32，避免无意义占内存）。 |
| `src/browser.ts` | `openBrowserSession` 增加 `headless: boolean` 与 `display?: string` 参数；`launchAndLoginWithMagicLink` 删；新增 `runInteractiveLogin(handle)`：在 head-ful 浏览器里轮询 page.url 与 cookie，直到检测到登录完成。GraphQL helper 保持原样。 |
| `src/api-server.ts` | `startApiServer` 调整：注册控制台路由 + 鉴权中间件；`AnythingProxyBackend` 删 warm-up / expander 相关字段；`generateOnce` 抓到 HTTP 401/403/429 时按策略切号；接 UsageTracker。 |
| `src/cli.ts` | `register` 命令彻底删；`login` 命令本地可继续用（要求 `HEADLESS=false` 且本机有图形界面），跑同样的 `loginInteractive`；新增 `accounts list` / `accounts remove <id>` / `accounts import <tar.gz>` / `accounts export <id> <out.tar.gz>`；`serve` 不变。 |
| `package.json` | scripts 调整（删 `register` / `pool:fill`，加 `accounts:*`）；依赖加 `tar`（导入导出用）；不引入 express，仍用原生 http + 极简路由。 |
| `src/fingerprint.ts` | 不变（仍为每账号生成稳定指纹） |
| `src/model-catalog.ts` | 校验现有模型 ID 是否与 2026-05-25 报告一致，按需补 `claude-opus-4-7` 等。属于次要可选改动。 |
| `README.md` | 大改：移除"批量注册"叙事；新增"自带账号 / Web 控制台 / Docker / VNC 登录"。`worker/` 与 `deploy/prometheus|grafana/` 章节保留。 |
| `worker/anything2api/*` | 不动。`UPSTREAM_BASE_URL` 改成 Zeabur 域名即可。 |

### 4.3 新增

| 路径 | 用途 |
| --- | --- |
| `src/console/server.ts` | 控制台 HTTP 路由（/admin/* 静态 + REST + websocket 反代到 noVNC） |
| `src/console/static/index.html` | 主页（账号列表、状态、动作按钮） |
| `src/console/static/app.js` | 主页脚本（fetch + 简单事件绑定） |
| `src/console/static/style.css` | 朴素样式 |
| `src/console/static/vnc.html` | 内嵌 noVNC client 的页面（iframe target） |
| `src/console/static/login.html` | 控制台密码登录页 |
| `src/vnc/supervisor.ts` | spawn / kill Xvfb、x11vnc、websockify、head-ful puppeteer；端口/display 分配；超时与清理 |
| `src/auth/api-key.ts` | API_KEYS 鉴权中间件；启动时强制校验非空 |
| `src/auth/console-session.ts` | 控制台密码登录、cookie 签发、限流、CSRF |
| `src/auth/packager.ts` | tar.gz 打包/解包 `data/accounts/<id>/` |
| `src/usage/tracker.ts` | jsonl 追加、按需 rotate、聚合查询 |
| `src/util/error.ts` | 从 register.ts 迁过来的 `formatError` |
| `src/util/time.ts` | 从 register.ts 迁过来的 `formatLocalTimestamp` |
| `Dockerfile` | 见 §9 |
| `docker-compose.yml` | 本地 + Zeabur 模板 |
| `.dockerignore` | 排除 node_modules / dist / data |
| `docs/deploy-zeabur.md` | 一步步部署指南 |
| `docs/admin-console.md` | 控制台使用说明 |
| `test/auth/api-key.test.ts` | 鉴权中间件单测 |
| `test/auth/packager.test.ts` | tar.gz 打包解包单测 |
| `test/usage/tracker.test.ts` | jsonl 写入与 rotate 单测 |
| `test/console/routes.test.ts` | mock VncSupervisor 后的路由单测 |

## 5. 数据模型

### 5.1 `data/account-pool.json`

继续使用 `AccountPoolState`，无 schema 变更。`accounts[].status` 取值仍为 `active | cooldown | deleted`。

### 5.2 `data/accounts/<email>-<hash>/`

```
session.json          AccountSessionRecord（保持原结构）
user-data/            Chromium userDataDir（cookie + indexed-db 等）
fingerprint.json      StableFingerprint（如已存在则继续复用）
```

### 5.3 `data/usage-stats.jsonl`

每行一个 JSON 对象：

```json
{
  "ts": "2026-05-25T10:23:45.123Z",
  "accountId": "abc123def456",
  "model": "gpt-5.4",
  "route": "/v1/chat/completions",
  "promptChars": 342,
  "completionChars": 1820,
  "status": "ok",
  "latencyMs": 12450
}
```

- 失败时 `status="error"` + 加 `errorKind` 字段。
- 启动时若文件 > 50 MB，rotate 为 `usage-stats.jsonl.1`，再新建一个空文件。
- `GET /admin/api/usage?range=7d` 流式读取并按 (model, accountId) 聚合。

## 6. 账号登录流程详解

### 6.1 状态机

```
[idle]
  │ POST /admin/api/login/start
  ▼
[provisioning]
  │ Xvfb / x11vnc / websockify / puppeteer head-ful 都拉起
  ▼
[waiting-google]
  │ 用户在 noVNC 里点 Google 登录
  ▼
[detecting]
  │ 后端轮询 page.url() 与 cookie；调 Me() 验证
  ▼
[finalizing]
  │ 抓 userId/projectGroupId → tar 整个 userDataDir 到 data/accounts/<id>/
  │ AccountPool.addPreparedSession()
  ▼
[done]   或   [failed]   或   [timeout]
```

### 6.2 登录完成判定

满足全部条件即视为登录完成：

1. `page.url()` 主机为 `www.anything.com`（或配置的 `ANYTHING_BASE_URL`）；
2. URL 路径不属于 `/login`、`/signup`、`/auth/*` 这些登录中转页；
3. 页面 cookie 中存在非空 `lS_authToken`；
4. 通过浏览器内 fetch 调 GraphQL `Me` 成功，返回 `me.id` 与 `me.email`；
5. 通过 GraphQL `GetProjectGroups(orgId)` 至少能拿到一个 projectGroup。若组织里没有任何 projectGroup（新账号未建项目），前端展示提示：「请到 anything.com 主页随便新建一个项目后回到本页继续」；后端继续轮询，直到拿到非空 projectGroup 才落盘。

### 6.3 失败/超时清理

- 10 分钟（`VNC_LOGIN_TIMEOUT_MS=600000`）内未达成判定 → kill 进程链 + 删临时 userDataDir。
- 用户主动点「取消」→ 同上。
- puppeteer 异常崩溃 → 同上 + 前端展示错误。
- 任意情况下都不能残留 Xvfb / websockify 子进程（用 dumb-init 兜底）。

### 6.4 端口与并发约束

| 资源 | 值 | 说明 |
| --- | --- | --- |
| Xvfb display | `:99` | 固定 |
| x11vnc port | `5900` | 容器内 |
| websockify port | `6080` | 容器内，不暴露给外 |
| 同时登录会话数 | 1 | 串行化，第二次 start 返回 409 |
| 容器对外端口 | `7860` | 只暴露这个 |

`/admin/vnc/<sessionId>` 由 Node 端反代到 `ws://127.0.0.1:6080/websockify`，sessionId 通过控制台 cookie session 校验，**不允许匿名连接**。

## 7. 日常生成调用链（不变）

```
client → /v1/chat/completions
       → API_KEY middleware
       → AnythingProxyBackend.generateStreaming(...)
       → AccountPool.acquireAccount(...)
       → BrowserSupervisor.ensureBrowser(account)
           (headless=true, userDataDir=account.accountDir/user-data/)
       → generateProjectGroupRevisionViaGraphql(...)
       → SSE 回客户端
       → AccountPool.markSuccess / markFailure
       → UsageTracker.record
```

唯一新增的判定：`generateOnce` 抓到底层 fetch 抛出的 GraphQL response 时，检查 HTTP 状态码或 GraphQL `errors`：

- HTTP 401 / 403 → 该账号 cookie 失效，标记 cooldown 并 failover。
- HTTP 429 → 立即 cooldown（不算 strike，因为不是账号本身坏掉）。
- 其它 5xx / 网络错误 → 走原 strike 流程。

具体策略由 `IMMEDIATE_SWITCH_STATUS_CODES` 控制。

## 8. 鉴权

### 8.1 `/v1/*` API 鉴权

- 配置：`API_KEYS=key1,key2,key3`（逗号分隔）。
- 检查头：先看 `Authorization: Bearer <key>`，没有再看 `x-api-key: <key>`。
- 命中任一 key → 通过；否则 401。
- 启动时若 `API_KEYS` 为空 / 未设 → **强制 process.exit(1) 并打印明确报错**，避免裸奔。

### 8.2 `/admin/*` 控制台鉴权

- 登录页 `/admin/login`：POST `{password}`。
- `WEB_CONSOLE_PASSWORD` 必填，未设则禁用控制台（启动时打印警告 + 路由 503）。
- `WEB_CONSOLE_USERNAME` 可选；设了就要双因子输入。
- 成功后下发 HttpOnly + SameSite=Lax cookie：`a2a_console=<random 32 bytes hex>`，服务端内存 Map 维护到期时间（默认 24h，可配 `CONSOLE_SESSION_TTL_HOURS`）。
- `RATE_LIMIT_MAX_ATTEMPTS=5` + `RATE_LIMIT_WINDOW_MINUTES=15`：失败次数超限按 IP 拉黑该窗口。
- 反代到 noVNC 的 `/admin/vnc/<sid>` 也走 cookie 校验。

### 8.3 `/metrics` 鉴权

- 默认开放（习惯做法）。
- 设了 `METRICS_TOKEN=xxx` 后必须 `?token=xxx` 或 `Authorization: Bearer xxx` 才能访问。

### 8.4 `/healthz`

- 永远开放，永远返回 200 + JSON `{ok:true, accounts:{active,cooldown,deleted}}`。

## 9. Docker / 部署

### 9.1 Dockerfile

```dockerfile
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-cjk fonts-noto-color-emoji \
      xvfb x11vnc fluxbox \
      novnc websockify \
      ca-certificates dumb-init procps \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NOVNC_DIR=/usr/share/novnc \
    NODE_ENV=production \
    PORT=7860 \
    HEADLESS=true

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@5 \
 && npx tsc -p tsconfig.json \
 && rm -rf src node_modules/typescript

RUN useradd -m -s /bin/bash app \
 && mkdir -p /app/data \
 && chown -R app:app /app
USER app

VOLUME ["/app/data"]
EXPOSE 7860
ENTRYPOINT ["dumb-init","--"]
CMD ["node","dist/src/cli.js","serve"]
```

要点：
- chromium 来自 Debian，不走 puppeteer 自带下载。
- novnc 是 Debian 包的位置 `/usr/share/novnc`；`vnc.html` 用相对路径 iframe 它。
- `dumb-init` 兜底子进程清理（x11vnc / websockify 不能成为僵尸）。

### 9.2 docker-compose.yml

```yaml
services:
  anything2api:
    build: .
    image: anything2api:latest
    container_name: anything2api
    ports:
      - "127.0.0.1:7860:7860"
    restart: unless-stopped
    environment:
      API_KEYS: "your-api-key"
      WEB_CONSOLE_PASSWORD: "change-me"
      STREAMING_MODE: "real"
      ACCOUNT_COOLDOWN_HOURS: "12"
      FAILURE_THRESHOLD: "3"
      IMMEDIATE_SWITCH_STATUS_CODES: "429,403,401"
      TZ: "Asia/Shanghai"
    volumes:
      - ./data:/app/data
```

### 9.3 Zeabur 部署

- 创建 Project → Service → Deploy from Git（推送本仓库）或 Deploy from Image（GHCR）。
- Storage：挂 Volume 到 `/app/data`（持久化账号 cookie 与统计）。
- Network：暴露 7860，分配域名。
- Variables：设 `API_KEYS`、`WEB_CONSOLE_PASSWORD`、`STREAMING_MODE=fake`（推荐，下文说明）、`TZ`。
- 部署完毕后访问 `https://<your-zeabur-domain>/admin`，输入控制台密码，点「添加账号」→ 在 noVNC 里完成 Google 登录。

### 9.4 Cloudflare Worker 反代

- `worker/anything2api/wrangler.jsonc` 不动。
- 在 Cloudflare 控制台把 `UPSTREAM_BASE_URL` 改成 `https://<your-zeabur-domain>`。
- 给 Worker 配自定义域名 / Route。
- 客户端只看到 Worker 域名。
- 由于真流式响应 Worker 一端可能超时（CF Free 100s），所以建议源站 `STREAMING_MODE=fake`，让 Worker 看到的是一次性返回，再由 Worker 端 Durable Object 重新切流给客户端。

### 9.5 推荐拓扑总结

```
                 (公网)
                    │
                    ▼
        Cloudflare Worker     <- 客户端配置的 base URL
        (your-domain.com)
                    │ fetch
                    ▼
        Zeabur Service :7860  <- 源站，跑 puppeteer + 账号池 + 控制台
                    │  /admin (人) ←──── 你的浏览器（管账号）
                    ▼  /v1/*  (机)
        www.anything.com /api/graphql
```

## 10. 错误处理 & 切号策略

立即切号（cooldown + failover）：

| 触发条件 | cooldown 时长 |
| --- | --- |
| GraphQL HTTP 401 / 403 | `ACCOUNT_COOLDOWN_HOURS`（cookie 失效，等用户重新登录或自动续期） |
| GraphQL HTTP 429 | min(`ACCOUNT_COOLDOWN_HOURS`, `Retry-After` 头) |
| GraphQL `errors[].extensions.code = "UNAUTHENTICATED"` | 同 401 |

按 strike 累计：

| 触发条件 | 行为 |
| --- | --- |
| GraphQL 业务错误（生成失败 / 余额不足等） | strike +1，failover；如果 strike < `FAILURE_THRESHOLD` 进 cooldown，≥ 则标 deleted |
| 网络超时 / DNS 失败 | 同上 |
| puppeteer 崩溃 | dispose 浏览器实例 + 同上 |

deleted 状态的账号留在 `data/accounts/<id>/`（不删 disk），等用户在控制台手动 `reactivate` 或 `remove`。

`MAX_FAILOVER_ATTEMPTS` 沿用 4。所有可用账号都失败 → 返回客户端 `503 service_unavailable`。

### 10.1 主动轮转

`SWITCH_ON_USES=40`：单个账号被连续选中 40 次后强制轮转下一个，避免单号被打死。AccountPool 在 `acquireAccount` 时记账。

## 11. 流式

- 默认 `STREAMING_MODE=real`：维持当前轮询 + SSE 增量推送。
- `STREAMING_MODE=fake`：服务端先把整个生成跑完，再以 SSE 包装一次性吐出（按 ~30 token 一段切片，避免客户端等到空闲超时）。Cloudflare Workers / Tunnel 等中间层友好。
- `STREAM_TIMEOUT_MS=60000`：真流式相邻 chunk 间最大等待，超时视为失败。
- `FAKE_STREAM_TIMEOUT_MS=300000`：假流式整体超时。
- `/v1/messages`、`/v1/chat/completions`、`/v1/responses`、`/v1/completions` 共用同一套 streaming 引擎。
- 客户端可通过 model 名末尾追加 `-fake` / `-real` 单次覆盖（参考 AIStudioToAPI 的做法）。优先级高于全局 `STREAMING_MODE`，但仅在 `stream:true` 时生效。

## 12. 环境变量总表

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `7860` | HTTP 监听 |
| `API_KEYS` | 必填 | 逗号分隔；未设拒启动 |
| `WEB_CONSOLE_PASSWORD` | 可选 | 未设则控制台关闭 |
| `WEB_CONSOLE_USERNAME` | 可选 | 设了就要双因子 |
| `METRICS_TOKEN` | 可选 | 设了就需要带 token |
| `CONSOLE_SESSION_TTL_HOURS` | `24` | 控制台 cookie 有效期 |
| `RATE_LIMIT_MAX_ATTEMPTS` | `5` | |
| `RATE_LIMIT_WINDOW_MINUTES` | `15` | |
| `HEADLESS` | `true` | 容器内强制 true；本地 `npm run login` 时手动设 false |
| `DATA_DIR` | `data` | |
| `MAX_POOL_SIZE` | `32` | |
| `ACCOUNT_COOLDOWN_HOURS` | `12` | |
| `ACCOUNT_MAX_STRIKES` | 同义于 `FAILURE_THRESHOLD`，保留向后兼容 | |
| `FAILURE_THRESHOLD` | `3` | |
| `IMMEDIATE_SWITCH_STATUS_CODES` | `429,403,401` | |
| `SWITCH_ON_USES` | `40` | 0 表示禁用 |
| `MAX_FAILOVER_ATTEMPTS` | `4` | |
| `STREAMING_MODE` | `real` | `real` / `fake` |
| `STREAM_TIMEOUT_MS` | `60000` | |
| `FAKE_STREAM_TIMEOUT_MS` | `300000` | |
| `VNC_LOGIN_TIMEOUT_MS` | `600000` | 10 分钟 |
| `ENABLE_USAGE_STATS` | `true` | |
| `ANYTHING_BASE_URL` | `https://www.anything.com` | |
| `TRACE_DIR` | `data/traces` | 调试追踪开关，可保留可关 |
| `TZ` | 系统时区 | |

## 13. 测试策略

### 13.1 单元测试

| 模块 | 重点 |
| --- | --- |
| `account-pool` | acquire/markFailure/markSuccess/removeAccount/reactivateAccount；strike 与 cooldown 边界；deleted 不被 acquire 选中；excludedAccountIds 工作 |
| `auth/api-key` | header 缺失 / 错误 / 命中；启动时 API_KEYS 必填校验 |
| `auth/console-session` | 密码校验、cookie 签发、限流计数、CSRF token |
| `auth/packager` | tar.gz 打包 `data/accounts/<id>/` 与解包到指定目录；路径越界（`..`）拒绝 |
| `usage/tracker` | jsonl 追加；rotate 阈值；聚合查询 |
| `console/routes` | mock VncSupervisor 与 AccountPool 后验证 5 个核心路由的输入输出 |
| `model-catalog`, `output-cleaning`, `tool-calls`, `metrics` | 不动 |

### 13.2 集成 / 手动验证（不在 CI）

| 项 | 方式 |
| --- | --- |
| 本地 Docker build → run | `docker compose up`，访问 `/admin`，登录、加号、走一次 `/v1/chat/completions` |
| Zeabur 部署 | 同上，但 build & deploy 在 Zeabur 端 |
| Cloudflare Worker 反代 | 把 wrangler 指到 zeabur 域名后跑 client SDK 验通 |
| 假流式 vs 真流式 | curl `-N` 看 SSE chunk 时间 |

## 14. 兼容性 & 迁移

- 旧 `data/account-pool.json` 与 `data/accounts/<email>-<hash>/` 仍可读，不需要 schema 迁移。
- `signupResult` / `mailbox` / `MagicLoginMail` 等类型整体删除。
- 已部署的旧版用户：跑 `npm run accounts:list` 看到现有账号仍存在；新增 / 重新登录走新流程。
- worker 不需要改。
- README 单独写一段「升级到 BYO 版本」。

## 15. 安全注意事项

1. `data/accounts/<id>/user-data/` 含 Google OAuth cookie，相当于账号密码。需要：
   - 容器内文件权限 0700，所有者 app:app。
   - 导出 tar.gz 时强烈建议加密（暂不实现自动加密，文档提示用户自己 gpg）。
2. `/admin/vnc/<sid>` ws 端点必须校验控制台 cookie；不允许通过 query 参数公开 sessionId 来匿名连接。
3. 限制 `Origin` / `Referer` 防止从恶意站点 fetch `/admin/api/*`。
4. API_KEYS 与 WEB_CONSOLE_PASSWORD 任意一个未设都明确报错，避免管理员遗漏。

## 16. 实施顺序建议（高层次）

仅作为后续 writing-plans 的输入参考，不是最终顺序。

1. 抽离 `util/error.ts`、`util/time.ts`，让 `register.ts` 删除后其他模块不会断。
2. 删除 `src/register.ts`、`test/register.test.ts`、`src/pool-expander*.ts`，让构建仍能过。
3. 改 `src/account-pool.ts`：删自动注册；加 `removeAccount` / `reactivateAccount`；调整测试。
4. 改 `src/account.ts`：`loginInteractive` 雏形（先用本地 head-ful 实现，不上 VNC）。
5. 改 `src/browser.ts` / `src/api-server.ts`：接入新策略，旧 `register` import 全清。
6. 加 `src/auth/api-key.ts` 并接到 `/v1/*`；启动校验 API_KEYS。
7. 加 `src/usage/tracker.ts` 并接到生成结果路径。
8. 加 `src/vnc/supervisor.ts`：spawn Xvfb / x11vnc / websockify；本机 Linux 测通（macOS/Windows 可暂跳过）。
9. 加 `src/console/server.ts` + 静态文件；接 `loginInteractive` + `VncSupervisor`。
10. Dockerfile + docker-compose.yml + .dockerignore；本地 `docker compose up` 跑通完整流程。
11. 写 `docs/deploy-zeabur.md` + 更新 README。
12. 加各模块单测。
13. 收尾 + smoke：本地登录 → 跑 `/v1/chat/completions` → 看 metrics 与 usage-stats。

## 17. 风险与未决问题

| 风险 | 处理 |
| --- | --- |
| Google 风控识别 puppeteer + Debian Chromium，登录被拦 | 沿用 stealth plugin；必要时切到 Firefox + Camoufox（如 AIStudioToAPI） |
| Zeabur 共享集群已于 2026-03-15 停止新项目（参考 AIStudioToAPI README） | 文档明确说明：需用付费 / 专属集群，或换 Fly.io / Render |
| anything.com 风控直接封 IP | 文档建议自备 HTTP_PROXY（继承 AIStudioToAPI 的 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 设计） |
| websockify 与 Cloudflare Worker 不兼容 | `/admin/*` 不应该走 Worker，建议 Worker 只反代 `/v1/*`（在 worker 端 path 过滤） |
| Volume 在 Zeabur 重启后是否真的保留 | 部署文档里写明：必须用 Zeabur 的 Volume Storage，而不是默认临时存储 |

---

**审阅请求**：本文档为 brainstorming 产出的设计草案，下一步将在用户确认后调用 writing-plans skill 生成实施计划。
