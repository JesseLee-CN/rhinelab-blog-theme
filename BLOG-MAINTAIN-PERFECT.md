# BLOG-MAINTAIN-PERFECT.md — 维护与完善手册

适用仓库：RhineLab Blog Theme 模板。本手册面向日常写作、构建、发布、回滚、备份、监控与排障。

示例值约定：站点 origin 为 `https://example.com`，主机为 `203.0.113.10`（RFC 5737 文档网段），
用户为 `root`，部署根为 `/srv/example-blog`。**这些都不是真实主机**，按自己的环境替换。

---

## 0. 速查（TL;DR）

```bash
# 1) 写文章：content/posts/<id>.md（frontmatter 见 §4.1）
# 2) 本地校验与预览
npm run check:content
npm run test:blog
npm run dev:blog                 # 默认 http://127.0.0.1:4321
# 3) 构建 + 打包 + 发布 + 验证
npm run build
ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
npm run release -- --id "$ID"
bash ops/upload-release.sh --id "$ID" --activate
node ops/smoke-test.mjs https://example.com
# 4) 提交源码
git add -A && git commit -m "post: <标题>" && git push
```

回滚一个静态版本：

```bash
ssh root@203.0.113.10 "DEPLOY_ROOT=/srv/example-blog bash /srv/example-blog/ops/rollback-release.sh <旧release-id>"
```

---

## 1. 系统全景

```text
本机（写作 / 构建）
  ├─ git push ──────────────► 远端仓库（源码真源、换机用）
  └─ npm run build ─► dist/ ─► npm run release ─► release/<id>/site.tar.gz
                                   │
                                   └─ ops/upload-release.sh --activate
                                          │  scp + 校验 + 解包
                                          ▼
服务器（只接收与激活，不构建）
  /srv/example-blog/{releases,incoming,state,ops}
  /srv/example-blog/active -> releases/<id>
  nginx 静态站点 + 认证服务（可选）unix socket
```

要点：构建只在本机或 CI 完成；服务器接收不可变 release 后原子切换 `active` 软链并 reload nginx。

---

## 2. 环境与访问

### 2.1 本机

- Node.js ≥ 22.12（开发环境 24.14.0），npm 11.x。
- 依赖安装：`npm ci --ignore-scripts`。
- 部署配置放在被 Git 忽略的 `ops/upload.env`（从 `ops/upload.env.example` 复制）。

### 2.2 服务器（自备）

| 项目 | 说明 |
| --- | --- |
| 部署根 | `/srv/example-blog`（`releases/`、`incoming/`、`state/`、`ops/`） |
| Web 服务 | nginx；站点 vhost 见 `ops/nginx/production.conf` |
| 认证服务 | `services/lab-auth/` 构建的 Go 二进制，监听 unix socket |
| 定时任务 | unit 模板见 `ops/systemd/`（备份、健康检查） |
| TLS | 自行申请与续期；证书路径在 vhost 中配置 |

### 2.3 部署配置（不要入库）

- `ops/upload.env`：`SSH_HOST` / `SSH_USER` / `SSH_PORT` / `SSH_IDENTITY` / `DEPLOY_ROOT`。
- 服务器 `$DEPLOY_ROOT/ops/deploy.env`：`HEALTHCHECK_URL`、`CONFIG_TEST_CMD`、`RELOAD_CMD`、`KEEP_RELEASES`。
- **不要把私钥、密码、token 写入仓库、文档或命令日志。**

---

## 3. 日常写作与发布

### 3.1 新建文章

在 `content/posts/` 新建 `<id>.md`，frontmatter 字段见 §4.1。`id` 一旦发布不要改动。

### 3.2 本地预览

```bash
npm run dev:blog     # 博客
npm run dev:lab      # 三维入口
```

### 3.3 构建

```bash
npm run check:content     # 内容契约
npm run test:blog         # 内容单元测试
npm run build             # 校验 → Astro → /lab/ → Pagefind → 站点检查
npm run preview           # 静态预览，未知路径真实 404
```

### 3.4 打包与发布

```bash
ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
npm run release -- --id "$ID"
bash ops/upload-release.sh --id "$ID" --activate
```

Windows 可用 `ops/upload-release.ps1 -HostName <host> -UserName root -ReleaseId <id> -Activate`。

### 3.5 线上验证

```bash
node ops/smoke-test.mjs https://example.com
curl -sI https://example.com/ | head
curl -s https://example.com/release.json
```

### 3.6 提交

```bash
git add -A && git commit -m "post: <标题>" && git push
```

---

## 4. 内容维护

### 4.1 frontmatter 字段

以 [content/README.md](content/README.md) 为准。要点：`id` 是稳定身份；`path` 唯一且不与系统路由
冲突；`draft: true` 与未来时间的内容不进入任何公开产物；`cover` 必须是真实存在的站内文件。

### 4.2 分类与标签

`categories` 驱动分类页与三维主题展示；`tags` 只影响标签页与搜索。改名会产生新路径，旧路径按 §4.4 处理。

### 4.3 媒体

图片等静态资源放在 `apps/blog/public/` 下并提交到 Git；正文使用站内绝对路径引用。

### 4.4 修改/删除文章与 URL 变化

规范路径变化时，保留原文章 ID，并在新路径保留旧地址的永久重定向；未知路径必须返回真实 404。

### 4.5 三维主题配置

`content/lab-collections.json` 固定五个主题，每主题最多八个槽位，`postIds` 只能引用已公开文章的 `id`。

---

## 5. 三维入口维护

三维应用的视觉与行为基线见 [DESIGN.md](DESIGN.md)；`/lab/` 由 `vite.lab.config.ts` 单独构建到
`dist/lab/`，读取 `.generated/lab-content.json` 的文章摘要。

### 5.1 沉浸式全文阅读（reader）

窗口、控件、目录导航与 markdown 参数的现行说明见 [docs/READER.md](docs/READER.md)，
实现为功能模块 `src/features/reader/`（入口与边界见 [docs/FEATURES.md](docs/FEATURES.md)）。
单元与端到端检查：

```bash
npm run test:reader
npm run test:reader-e2e -- --browser chromium
```

---

## 6. 命令参考

```bash
npm ci --ignore-scripts
npm run check:content        # 内容 schema、路径、草稿、封面、主题引用
npm run check:features       # 功能模块边界（入口唯一、无跨功能穿透、无孤儿文件）
npm run test:blog            # 内容契约单元测试
npm run check:viewport       # 视口/布局检查
npm run typecheck            # 三维 TypeScript 检查
npm run test:reader          # 阅读层单元测试
npm run test:reader-e2e      # 阅读层端到端总门（Playwright）
npm run check:render-updates # 渲染复用与失效条件
npm run check:boot-baseline  # 开场基线检查
npm run test:identity        # 身份与用户名规则
npm run test:entry           # 身份时间线
npm run test:login-e2e       # 登录/注册端到端
npm run check:account        # 账号端到端：CLI 建号 → 博客登录 → /lab/ 同一会话（需 Go）
npm run bench:auth           # 认证服务容量压测
npm run check:site           # 构建后产物、泄露与 lab 边界检查
npm run build                # 完整构建
npm run preview              # 静态预览
npm run release -- --id <id> # 打包不可变 release
node ops/smoke-test.mjs <url>
```

### 6.1 账号管理命令（`lab-auth` CLI）

账号库的日常操作优先走 CLI（也可用 `/api/auth/admin/*` 管理 API，字段与语义一致）。
flag 写在位置参数之前，`-json` 输出与 API 字段一致：

```bash
lab-auth user list    -db <path>                    # 账号列表（-search/-enabled/-limit/-offset）
lab-auth user show    -db <path> -json <用户名>
lab-auth user create  -db <path> <用户名>            # 密码从终端隐藏输入两次
lab-auth user disable -db <path> <用户名>            # 停用并撤销该账号会话
lab-auth user enable  -db <path> <用户名>
lab-auth user reset-password -db <path> <用户名>     # 重置并撤销会话
lab-auth user delete  -db <path> [-force] <用户名>   # 删账号；最后一个可用账号需 -force
lab-auth session list -db <path> [-user <ref>] [-state active]
lab-auth session revoke -db <path> <用户名|user-id>
lab-auth audit list   -db <path> [-action user.disable] [-limit 50]
lab-auth db status    -db <path>                    # schema 版本、账号/会话/审计计数
lab-auth db verify    -db <path>                    # 额外跑 PRAGMA integrity_check
lab-auth db backup    -db <path> -out <file>
lab-auth db restore   -src <file> -db <path>
```

- 每次变更都会写一条审计（actor `cli:<系统用户>`）；删除账号**不会**删除它的审计记录。
- 已发布的迁移文件不可修改（`schema_migrations` 校验 SHA-256），只能追加 `000N_*.sql`。
- 管理 API 需要 `LAB_AUTH_ADMIN_TOKEN`（≥32 字符），未设置时该接口返回 503 而非裸奔。

---

## 7. 部署架构与 release 生命周期

1. `npm run release -- --id <id>` 在 `release/<id>/` 生成站点 tarball、清单与校验和。
2. `ops/upload-release.sh --id <id>` 上传到 `incoming/`，服务器侧校验后解包到 `releases/<id>/`。
3. `--activate` 原子切换 `active` 软链、执行 `nginx -t` 后 reload，并写入 `state/`。
4. 任意步骤失败都不替换线上；`releases/` 按 `KEEP_RELEASES` 保留最近若干版本。

---

## 8. 回滚手册

```bash
ssh root@203.0.113.10 "DEPLOY_ROOT=/srv/example-blog bash /srv/example-blog/ops/rollback-release.sh <旧release-id>"
# 或直接激活指定版本
ssh root@203.0.113.10 "DEPLOY_ROOT=/srv/example-blog bash /srv/example-blog/ops/activate-release.sh <release-id>"
```

回滚后确认 `active` 指向、`/release.json` 内容与页面状态码，并重跑 smoke。

---

## 9. 备份与恢复

### 9.1 备份

- 站点：源码在 Git，构建产物可由源码重建，因此主要备份**认证数据库**与服务器配置。
- 认证库使用一致性快照（SQLite `VACUUM INTO`）并做完整性校验：

```bash
/srv/example-blog-auth/ops/backup.sh --db /var/lib/example-blog-auth/auth.db \
  --out-dir /var/backups/example-blog-auth --bin /srv/example-blog-auth/releases/current/lab-auth
```

### 9.2 恢复

停止认证服务 → 用快照替换数据库文件 → 校正属主与权限 → 启动并检查 `/health/ready`。
**不要**用恢复旧库的方式回滚代码版本。

### 9.3 保留策略

快照按天保留最近若干份（unit 中 `--keep` 控制）；定期确认磁盘占用与快照可读性。

---

## 10. 监控与健康检查

### 10.1 快速体检

```bash
node ops/smoke-test.mjs https://example.com
curl -sI https://example.com/ | head
curl -s https://example.com/release.json
```

### 10.2 观察清单

- 当天 / 24h / 72h / 7d：nginx 错误日志、旧 URL 404、搜索、RSS、手机阅读、证书续期。
- 磁盘与内存：避免在服务器上跑构建；注意备份与 release 累积。
- 认证服务：`systemctl status`、`NRestarts`、RSS、最近一小时 5xx 计数。

### 10.3 定时任务

unit 模板随 Git 保存在 `ops/systemd/`，脚本为 `ops/healthcheck.sh`；部署时安装到服务器并
`systemctl enable --now`。健康检查会校验站点与入口状态码、未知路径 404、认证就绪、证书剩余天数、
根分区占用与 active release 一致性，结果写入 `state/health.json`。

告警通道默认只有 journal 与状态文件；如需邮件或推送需另行接入。

---

## 11. 故障排查

| 现象 | 排查 |
| --- | --- |
| 整站 403 | release 目录权限；目录 `755`、文件 `a+rX` |
| 文章 404 / 未知路径返回首页 200 | 检查 `try_files ... =404`；确认没有 SPA 回落 |
| 中文标点后的 `**加粗**` 不渲染 | Astro 需 `remark-cjk-friendly`，配置见 `apps/blog/astro.config.mjs` |
| `nginx -t` 失败 | 先不要 reload；回滚 vhost 备份后重试 |
| 证书过期 | 检查续期任务与 80 端口 ACME 路径可达性 |
| 磁盘满 | 清理旧 release 与旧备份；`du -sh` 定位 |
| 发布后未生效 | `readlink active`、`/release.json`、reload 是否成功 |
| 发布失败 | 上传/校验失败不激活；用 `rollback-release.sh` 或重新发布 |

---

## 12. 安全与密钥

- 私钥仅放本机文件系统，`SSH_IDENTITY` 指向路径；不写入仓库、文档或日志。
- 服务器侧激活脚本应限制为 `root:root 0700`；不执行上传包内的脚本。
- 首次核对主机指纹后固定，不要使用 `StrictHostKeyChecking=no`。
- 仓库可能含第三方模型/字体/素材，公开前先做脱敏（见 [SANITIZE-NOTES.md](SANITIZE-NOTES.md)）。

---

## 13. 后续完善（Roadmap）

| 优先级 | 事项 | 说明 |
| --- | --- | --- |
| 高 | 受限 deploy 用户 | 用最小 sudoers 替代 root 手工发布 |
| 中 | 定时构建 | 未来文章到点自动重建 |
| 中 | 主动告警 | 邮件 / Webhook 接入健康检查 |
| 低 | 三维空主题装饰 | 空槽改为不可选空状态 |
| 低 | 字体与素材说明补齐 | 新引入第三方资源时同步许可与来源 |

---

## 14. 相关文档

- [README.md](README.md)：项目定位、快速开始与许可范围。
- [docs/README.md](docs/README.md)：文档索引（写作、构建发布、阅读层、身份认证、上游与许可）。
- [AGENTS.md](AGENTS.md)：代理协作约束与实施边界。
- [docs/AUTHORING.md](docs/AUTHORING.md)、[content/README.md](content/README.md)：内容字段与写作流程。
- [docs/BUILD.md](docs/BUILD.md)：构建顺序、发布、回滚与排障的命令级说明。
- [docs/READER.md](docs/READER.md)：阅读层契约与参数。
- [docs/IDENTITY.md](docs/IDENTITY.md)：身份、认证接口与运维约束。
- [DESIGN.md](DESIGN.md)：三维视觉与行为基线。
- [SANITIZE-NOTES.md](SANITIZE-NOTES.md)：本模板的脱敏范围与残留说明。
