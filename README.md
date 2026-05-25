# anything-2api

把 `anything.com` 的账号注册、登录和会话托管成一个本地/远程 2api 代理。

## 功能

- TypeScript 实现
- Razmail (`mail.razkord.top`) 批量注册
- Puppeteer + stealth 登录
- 每账号稳定指纹
- 账号池/负载均衡
- 失败自动切号
- cooldown 12h，连续失败 2 次删除
- OpenAI 兼容：
  - `GET /v1/models`
  - `POST /v1/chat/completions`
  - `POST /v1/completions`
  - `POST /v1/responses`
- Anthropic 兼容：
  - `POST /v1/messages`
- 基础 streaming 支持
- best-effort `tool_calls` / `tool_use`
- 自动清洗站内 reasoning UI 块，并把提取结果放进 `reasoning`

## 当前模型

当前代理接受这些模型名：

- `anything-auto`
- `openai`
- `openai-gpt-4.1`
- `gpt-5.4`
- `gpt-5.2`
- `gpt-4.1`
- `claude-sonnet-4`
- `anthropic-sonnet-4.6`
- `claude-sonnet-4.6`
- `claude-sonnet-4-6`
- `claude-opus-4-6`
- `opus-46`
- `claude-3.7-sonnet`
- `claude-3.5-sonnet`
- `claude-haiku`
- `gemini-2.5-pro`
- `gemini-1.5`
- `gemini-31-pro`
- `gemini-3`

说明：

- 这份列表优先按 Anything 当前前端启动配置里真实暴露的 provider / feature flag 对齐
- 代理会把常见别名映射到 Anything 当前使用的 provider 名

### 一键抓当前 Anything 模型暴露

```powershell
npm run discover-models
```

这个脚本会抓 `https://www.anything.com` 当前下发的：

- `portkey-providers`
- 若干模型 feature flags

然后输出建议模型清单。

## 安装

```powershell
npm install
npm run build
```

## 常用命令

### 单独注册/登录一个号

```powershell
npm run login
```

### 预填充账号池

```powershell
$env:POOL_SIZE=5
npm run pool:fill -- 5
```

### 查看账号池

```powershell
npm run pool:status
```

### 启动代理

```powershell
$env:PORT=8790
$env:POOL_SIZE=5
$env:MAX_POOL_SIZE=1024
npm run serve
```

## 环境变量

- `PORT`：监听端口，默认 `8787`
- `POOL_SIZE`：目标可用账号数，默认 `3`
- `MAX_POOL_SIZE`：账号池上限，默认 `1024`
- `ACCOUNT_COOLDOWN_HOURS`：失败 cooldown 小时数，默认 `12`
- `ACCOUNT_MAX_STRIKES`：连续失败上限，默认 `2`
- `HEADLESS`：`true/false`
- `DATA_DIR`：数据目录，默认 `./data`
- `ANYTHING_BASE_URL`：默认 `https://www.anything.com`
- `RAZMAIL_BASE_URL`：默认 `https://mail.razkord.top`

## 账号池策略

- 启动后后台持续补货
- 可用账号不足时自动继续注册
- 账号失败后：
  - 第 1 次：`cooldown 12h`
  - 第 2 次：从可用池删除
- 请求期间账号失败会自动切到别的号继续

## OpenAI 示例

```powershell
$body = @{
  model = 'gpt-5.4'
  messages = @(
    @{ role = 'user'; content = '你好' }
  )
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri 'http://127.0.0.1:8790/v1/chat/completions' `
  -Method Post `
  -ContentType 'application/json' `
  -Body $body
```

## Anthropic 示例

```powershell
$body = @{
  model = 'claude-sonnet-4'
  messages = @(
    @{ role = 'user'; content = '你好' }
  )
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri 'http://127.0.0.1:8790/v1/messages' `
  -Method Post `
  -ContentType 'application/json' `
  -Body $body
```

## Streaming

- `chat.completions`：支持 `stream=true`
- `completions`：支持 `stream=true`
- `responses`：支持 `stream=true`
- `messages`：支持 `stream=true`

当前 streaming 是代理层轮询 revision 并转成 SSE。

## Reasoning 清洗

站内有时会把 reasoning 以类似下面的 UI 块混进正文：

```html
<file-based-block ... thinkingType="reasoning">...</file-based-block>
```

代理会：

- 自动把这类块从 `content` / `text` 中剥离
- 把提取到的内容放到扩展字段 `reasoning`

## Tool calls

当前 `tool_calls` / `tool_use` 是 best-effort 兼容：

- 先让模型按固定 JSON 格式输出
- 支持从 reasoning 前缀中截断，尽量从第一个结构化 JSON 开始识别
- 若 `tool_choice=required` 且模型仍不配合，会走启发式 fallback，尽量返回一个工具调用

## 测试

```powershell
npm test
```

## systemd 部署思路

服务名示例：`anything-2api.service`

工作目录：

```text
/opt/anything-2api
```

启动命令：

```text
/usr/bin/npm run serve
```

建议环境：

- `PORT=8790`
- `POOL_SIZE=32`
- `MAX_POOL_SIZE=1024`
- `HEADLESS=true`
- `DATA_DIR=/var/lib/anything-2api`

## Cloudflare Worker 反代

已提供 worker 工程：

```text
worker/anything2api
```

特点：

- worker 名字：`anything2api`
- 普通请求直接反代到源站
- `stream=true` / `text/event-stream` 请求走 Durable Object
- Durable Object 按 shard 转发流式响应，避免所有 streaming 都直接打源站

关键文件：

- `worker/anything2api/wrangler.jsonc`
- `worker/anything2api/src/index.ts`

### Worker 环境变量

- `UPSTREAM_BASE_URL`
- `STREAM_SHARDS`
- `MAX_CONCURRENT_STREAMS_PER_SHARD`
- `WORKER_AUTH_TOKEN`（可选）

### 部署示例

```bash
cd worker/anything2api
wrangler deploy
```

如果要改成你的正式域名，建议把：

```text
UPSTREAM_BASE_URL=http://122.51.245.211:8790
```

保留为当前源站地址，然后给 worker 配 route 即可。

## Metrics / Prometheus / Grafana

服务现在暴露：

```text
GET /metrics
```

Prometheus 指标包括：

- `anything2api_http_requests_total`
- `anything2api_http_request_duration_seconds`
- `anything2api_http_inflight_requests`
- `anything2api_generation_requests_total`
- `anything2api_generation_failovers_total`
- `anything2api_tool_calls_total`
- `anything2api_prompt_chars_total`
- `anything2api_completion_chars_total`
- `anything2api_estimated_prompt_tokens_total`
- `anything2api_estimated_completion_tokens_total`
- `anything2api_pool_active_accounts`
- `anything2api_pool_cooldown_accounts`
- `anything2api_pool_deleted_accounts`
- `anything2api_pool_total_accounts`
- `anything2api_pool_busy_accounts`

### Prometheus / Grafana 部署文件

已提供：

- `deploy/prometheus/prometheus.yml`
- `deploy/prometheus/prometheus.service`
- `deploy/grafana/provisioning/datasources/prometheus.yaml`
- `deploy/grafana/provisioning/dashboards/dashboards.yaml`
- `deploy/grafana/dashboards/anything2api-overview.json`

说明：

- Prometheus 监听建议端口：`19090`
- Grafana 默认可监听：`3000`
- Dashboard 已包含：
  - RPM
  - Estimated TPM
  - Pool active/busy/cooldown/deleted
  - request p95
  - failover rate
  - `up{job="anything2api"}`
  - `up{job="gitlab_workhorse"}`
  - `up{job="traefik"}`
