# 字词练习线上部署

本项目沿用“GitHub Pages 静态页面 + 独立阿里云 FC Web 函数”结构。云函数只运行本项目的 `server.js` 和 `data/word-bank.json`；不与作文批改台或看图写话工作台共用函数、数据或密钥。当前函数为 `word-practice-generator-api`，地址为 `https://word-prator-api-qfrffnhhwu.cn-shanghai.fcapp.run`。

## 1. 生成部署包

```bash
npm run test:online
npm run package:fc
```

上传 `dist/word-practice-generator-fc.zip`。部署包不包含浏览器配置、API Key、网页或其他项目文件。

## 2. 创建 FC Web 函数

- 地域：华东 2（上海），函数名建议 `word-practice-generator-api`。
- 自定义运行时：Node.js 22（Debian 12），启动命令 `npm run start:fc`，监听端口 `9000`。
- 内存至少 512 MB，执行超时至少 180 秒，最小实例数 0，函数弹性实例配额 1。
- 配置 HTTPS 公网 HTTP 触发器。当前触发器无需认证，这是用户明确选择的匿名访问模式；函数有运行费用，不能把来源限制当成身份验证。
- 可选环境变量 `ALLOWED_MODEL_HOSTS`：额外允许的模型 API 域名，多个域名用逗号分隔。默认只允许 `api.deepseek.com` 和 `api.openai.com`。
- 可选环境变量 `RATE_LIMIT_MAX`：单实例每分钟最多接受的生成请求数，默认 20。

云函数的 `HOSTED_MODE=1` 会关闭静态文件服务、自签名证书绕过和 HTTP/内网模型地址。线上访问者仍在网页里填写自己的 API Key；云函数不保存密钥。函数本身会产生调用和运行费用，模型费用由填写密钥的账户承担。

## 3. 接入 Pages

1. 访问函数 HTTPS 地址的 `/api/health`，确认返回 `"service":"word-practice-generator"` 和 `"mode":"hosted"`。
2. 将 `runtime-config.js` 的 `apiBaseUrl` 填为该函数的 HTTPS 根地址，不要带末尾斜杠。
3. 提交并推送 `main`；本仓库的 Pages 使用 `main` 根目录自动发布。
4. 从 `https://hanroots.github.io/word-practice-generator/` 打开页面，检查生成请求到独立函数，而不是 Pages 的 `/api/generate`。

当前线上 API 仅接受 `https://hanroots.github.io` 的浏览器来源；这不是用户身份认证。如果要改成由平台统一支付模型费用、对外开放给更多家长，应先增加登录、配额和服务端密钥管理，不能直接在公开函数中放共享模型密钥。
