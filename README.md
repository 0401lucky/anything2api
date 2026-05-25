# anything-2api

把 `anything.com` 包装成兼容 OpenAI / Anthropic 的本地/远程 2api 代理。**自带 Google 账号**版本（不再批量注册）。

## 功能

- OpenAI 兼容：`/v1/chat/completions`、`/v1/completions`、`/v1/responses`、`/v1/models`
- Anthropic 兼容：`/v1/messages`
- API_KEYS 鉴权
- 真流式 + 假流式可切换（Cloudflare Worker 长连接友好）
- 多账号池 + LRU 轮询 + 失败 cooldown + 主动轮转
- 自动清洗站内 reasoning UI 块
- best-effort `tool_calls` / `tool_use`
- Web 控制台 + 容器内 noVNC 登录账号（直接在浏览器里完成 Google 登录）
- usage-stats.jsonl 持久化
- Prometheus `/metrics`
- Cloudflare Worker 反代（隐藏源站 IP）

## 快速开始（Docker）

```bash
cp docker-compose.yml my.yml
# 改 API_KEYS / WEB_CONSOLE_PASSWORD
docker compose -f my.yml up -d
```

打开 `http://127.0.0.1:7860/admin/login` → 输入 `WEB_CONSOLE_PASSWORD` → 点「添加账号」→ 在弹出的 noVNC 页面里完成 Google 登录。

如果云端 noVNC 被 Vercel Security Checkpoint 拦截，可在本机真实浏览器登录 `https://www.anything.com`，用 Cookie-Editor 一类工具导出 `anything.com` 的 Cookie JSON，然后在控制台点「导入 Cookie」。最好同时包含 `lS_authToken` 和 `refresh_token`；如果只能导出到 `refresh_token`，系统会先请求 anything 页面收集服务端补发的 `Set-Cookie`，再尝试直连 GraphQL。导入成功后不再依赖云端浏览器打开登录页。

之后客户端就可以用：

```bash
curl -X POST http://127.0.0.1:7860/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"你好"}]}'
```

## 快速开始（本地开发，需要图形界面）

```bash
npm install
npm run build
HEADLESS=false API_KEYS=dev WEB_CONSOLE_PASSWORD=dev npm run login   # 弹出浏览器让你登录
API_KEYS=dev WEB_CONSOLE_PASSWORD=dev npm run serve
```

## 控制台

详见 [docs/admin-console.md](docs/admin-console.md)。

## API 鉴权

`/v1/*` 必须带 `Authorization: Bearer <key>` 或 `x-api-key: <key>`，key 与 `API_KEYS` 环境变量逗号分隔列表匹配即可。未设 `API_KEYS` 时管理控制台仍会启动，API 路由返回 503。

## 环境变量参考

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `7860` | HTTP 端口 |
| `API_KEYS` | 必填 | 逗号分隔的可用 key 列表 |
| `WEB_CONSOLE_PASSWORD` | 可选 | 未设则禁用控制台 |
| `WEB_CONSOLE_USERNAME` | 可选 | 设了就要双因子 |
| `METRICS_TOKEN` | 可选 | 设了 `/metrics` 也要鉴权 |
| `CONSOLE_SESSION_TTL_HOURS` | `24` | 控制台 cookie 有效期 |
| `RATE_LIMIT_MAX_ATTEMPTS` | `5` | 控制台登录失败次数 |
| `RATE_LIMIT_WINDOW_MINUTES` | `15` | 失败窗口 |
| `HEADLESS` | `true` | 服务运行时浏览器是否无头 |
| `BROWSER_ENGINE` | Docker 为 `firefox`，本地未设则 `chromium` | `firefox`/`camoufox` 或 `chromium` |
| `CAMOUFOX_EXECUTABLE_PATH` | Docker 内 `/app/camoufox-linux/camoufox` | Camoufox 可执行文件路径 |
| `PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH` | 可选 | 自定义 Firefox 可执行文件路径 |
| `DATA_DIR` | `data` | 数据目录 |
| `MAX_POOL_SIZE` | `32` | 账号上限 |
| `ACCOUNT_COOLDOWN_HOURS` | `12` | cooldown 时长 |
| `FAILURE_THRESHOLD` | `3` | 连续失败到此进入 deleted |
| `ACCOUNT_MAX_STRIKES` | 同义于 `FAILURE_THRESHOLD` | 向后兼容 |
| `IMMEDIATE_SWITCH_STATUS_CODES` | `429,403,401` | 立即 cooldown 的 HTTP 状态 |
| `SWITCH_ON_USES` | `40` | 单号被连续使用上限，到了主动轮转 |
| `MAX_FAILOVER_ATTEMPTS` | `4` | 单次请求允许切几次号 |
| `STREAMING_MODE` | `real` | `real` / `fake` |
| `STREAM_TIMEOUT_MS` | `60000` | 真流式 chunk 间最大间隔 |
| `FAKE_STREAM_TIMEOUT_MS` | `300000` | 假流式整体超时 |
| `VNC_LOGIN_TIMEOUT_MS` | `600000` | noVNC 登录会话超时 |
| `ENABLE_USAGE_STATS` | `true` | 是否写 usage-stats.jsonl |
| `USAGE_MAX_BYTES` | `52428800` | usage-stats rotate 阈值（50MB） |
| `ANYTHING_BASE_URL` | `https://www.anything.com` | 上游 |
| `TZ` | 系统时区 | |
| `NOVNC_DIR` | `/usr/share/novnc` | 可选的系统 noVNC 资源 fallback；默认优先使用内置资源 |

## 部署方案矩阵

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| 本地电脑 | ✅ | 直接 `npm run serve`，本机能 Google 登录 |
| VPS / 云服务器 | ✅ 推荐 | 用 Docker；或本机登录后上传 `data/` 到 VPS |
| Docker（Render/Fly.io/Railway/Zeabur） | ✅ | 通过容器内 noVNC 登录 |
| Cloudflare Workers | ❌ | 无 Node、无浏览器，不能跑主服务；但 worker/anything2api 仍可做反代 |

详细 Zeabur 部署见 [docs/deploy-zeabur.md](docs/deploy-zeabur.md)。

## Cloudflare Worker 反代

仓库内 `worker/anything2api` 是现成反代工程：

```bash
cd worker/anything2api
# 把 wrangler.jsonc 里 UPSTREAM_BASE_URL 改成你的源站
wrangler deploy
```

特点：
- 普通请求直接反代
- `stream=true` 走 Durable Object 分片
- 可选 `WORKER_AUTH_TOKEN` 二次鉴权

## Metrics / Prometheus / Grafana

`GET /metrics` 暴露 Prometheus 文本格式，包含：

- `anything2api_http_requests_total`
- `anything2api_generation_requests_total`
- `anything2api_generation_failovers_total`
- `anything2api_tool_calls_total`
- `anything2api_pool_active_accounts` / `cooldown` / `deleted` / `busy`
- 等等

Prometheus / Grafana 部署文件在 `deploy/` 目录。

## CLI

- `npm run serve`：启动 2api
- `npm run login`：本地图形界面登录（要求 `HEADLESS=false`）
- `npm run accounts:list`：列出账号
- `npm run accounts:remove -- <accountId>`：删账号
- `npm run accounts:reactivate -- <accountId>`：把账号从 cooldown / deleted 拉回 active
- `npm run accounts:export -- <accountId> <out.tar.gz>`：导出账号包
- `npm run accounts:import -- <archive.tar.gz>`：导入账号包
- `npm run accounts:import-cookies -- <cookies.json> [finalUrl]`：从本机浏览器导出的 Cookie JSON 导入账号

## 测试

```bash
npm test
```

## 升级到 BYO Account 版本

如果你从批量注册版本升级：

1. 现有 `data/accounts/<id>/` 与 `data/account-pool.json` 保留可用。
2. 旧的 `registered_emails.txt` / `registered_results.jsonl` 不再被读，可以删掉。
3. `npm run register` / `npm run pool:fill` 已废弃，启动时不会再自动注册。
4. 必须设置 `API_KEYS` 与 `WEB_CONSOLE_PASSWORD` 才能启动。
