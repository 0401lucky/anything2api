# 部署到 Zeabur

## 前置条件
- Zeabur 账号（注意 2026-03-15 起共享集群停止接新项目，需要付费集群）
- 至少能在本地或服务器上跑一次登录（云上无图形界面则用容器内 noVNC）

## 步骤

1. 把仓库推到 Git 服务（GitHub / GitLab）。
2. Zeabur Project → Add Service → Git Source → 选本仓库。
3. Service Settings → Variables：
   - `API_KEYS=<你的 key>`
   - `WEB_CONSOLE_PASSWORD=<强密码>`
   - `STREAMING_MODE=fake`（强烈推荐，Cloudflare/Tunnel 长连接友好）
   - `TZ=Asia/Shanghai`
4. Service Settings → Storage → Add Volume，挂到 `/app/data`，至少 1 GB。
5. Networking → Expose Port 7860 → 生成域名。
6. Build → Use Dockerfile（自动检测）。
7. 部署完成后访问 `https://<your-zeabur-domain>/admin/login`，输入 WEB_CONSOLE_PASSWORD。
8. 点「添加账号」→ 在弹出的 noVNC 页面里完成 Google 登录。
9. 账号添加成功后 `/v1/*` 即可使用。
