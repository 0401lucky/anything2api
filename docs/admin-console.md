# 控制台使用

## 登录
访问 `/admin/login`，输入 `WEB_CONSOLE_PASSWORD`（如配置了 `WEB_CONSOLE_USERNAME` 则同时输用户名）。

## 账号管理
- **添加账号**：点「添加账号」按钮，会弹出新窗口加载 noVNC，在容器内浏览器里用 Google 登录 anything.com。Docker 默认使用 Camoufox/Firefox，降低 Vercel 检测自动化浏览器的概率。登录成功后自动落盘并加入账号池。
- **导入 Cookie**：云端 noVNC 被 Vercel 拦截时，在本机真实浏览器登录 anything.com，导出 Cookie JSON 后粘贴到控制台。建议同时包含 `lS_authToken` 和 `refresh_token`；只有 `refresh_token` 时会先请求页面收集服务端补发的 Cookie，再尝试直连 GraphQL。
- **导入账号**：点「导入 tar.gz」上传从其他实例 export 出来的账号包。
- **导出账号**：表格里点「导出」下载 tar.gz。
- **重新激活**：账号被标记为 cooldown / deleted 后，可手动激活回 active。
- **删除**：从池子里移除（不删 disk，重新导入即可恢复）。

## 使用统计
右侧栏展示当前 `data/usage-stats.jsonl` 的聚合（按模型 / 按账号）。每 15 秒自动刷新。
