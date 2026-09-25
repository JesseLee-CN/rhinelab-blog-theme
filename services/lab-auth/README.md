# services/lab-auth

Rhine Lab 账号服务：启动身份门的登录/注册流程，以及博客与 `/lab/` 共用的账号管理。
接口契约见 `openapi.yaml`，数据模型见 `migrations/`，跨模块规则见 `internal/identity`
与 `internal/config` 的实现。

## 布局

```text
cmd/lab-auth/          CLI 入口（main.go 分发、user.go 账号、db.go 数据库、serve.go 服务）
internal/config/       环境配置加载与校验
internal/identity/     用户名/密码规则（与 shared/auth/identity.ts 对齐）
internal/password/     Argon2id PHC 散列与校验
internal/ratelimit/    有界定窗限流器（内存，重启重置）
internal/server/       HTTP 处理：账号接口、Cookie、CSRF、日志
internal/server/admin.go   管理 API（/admin/*，bearer 令牌）
internal/store/        SQLite 架构、迁移、用户、flow/session、备份/恢复
internal/store/accounts.go 账号管理面：分页查询、删除、会话查询、审计
migrations/            schema v1（登录流程）+ v2（审计表），embed 后随二进制发布
```

数据层的对外形状是接口而不是具体类型：CLI 与管理 API 依赖 `store.UserDirectory`、
`store.AuditLog`、`store.SessionDirectory`（合起来是 `store.AccountStore`），
`*store.Store` 实现它们，测试可注入假实现。

## 构建与测试

需要 Go 1.27（本机 1.27.1）。国内网络使用 `GOPROXY=https://goproxy.cn,direct`。

```sh
go mod verify
go vet ./...
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o ../../.tools/boot-identity/bin/lab-auth ./cmd/lab-auth
```

发布二进制不启用 cgo；并发检查（race）使用独立工具链步骤（G3）。

## 配置（环境变量）

| 变量 | 说明 |
| --- | --- |
| `LAB_AUTH_ENV` | `development`（默认）或 `production` |
| `LAB_AUTH_LISTEN` | `unix:/run/.../http.sock` 或回环地址；生产只允许 unix socket |
| `LAB_AUTH_DB` | SQLite 路径；生产为绝对路径 |
| `LAB_AUTH_ALLOWED_ORIGINS` | 逗号分隔；生产必须为 https 且必填 |
| `LAB_AUTH_ARGON_MEMORY_KIB` / `_ITERATIONS` / `_PARALLELISM` | 覆盖 Argon2id 参数 |
| `LAB_AUTH_PENDING_TTL` / `LAB_AUTH_FLOW_TTL` | Go duration |
| `LAB_AUTH_CSRF_SECRET` | 32 字节 hex；生产必填，供 flow/session CSRF 与注册来源 HMAC 派生 |
| `LAB_AUTH_COOKIE_INSECURE` | `1` 时关闭 Cookie Secure（仅本地 http 调试） |
| `LAB_AUTH_PROXY_HEADER` | 反代报告客户端地址用的头：`x-real-ip`（默认）/ `x-forwarded-for` / `off` |
| `LAB_AUTH_REGISTRATION_ENABLED` | 默认 false；`1`/`true` 开放 register-v1 |
| `LAB_AUTH_REGISTER_SOURCE_HOURLY` | 每来源每小时注册尝试（默认 10，持久额度） |
| `LAB_AUTH_REGISTER_GLOBAL_DAILY` | 全站每日注册尝试（默认 200，持久额度） |
| `LAB_AUTH_REGISTER_MAX_USERS` | 用户总量上限（默认 5000，停用账号计入） |
| `LAB_AUTH_ADMIN_TOKEN` | 管理 API 的 bearer 令牌；留空即关闭管理面（返回 503），设置时至少 32 字符 |
| `LAB_AUTH_ADMIN_RATE` | 每个来源每分钟的管理请求上限（默认 60） |

生产缺少关键配置时 `Validate()` 拒绝启动，默认不监听公网。真实配置放
`ops/auth/*.env`（Git 忽略），仓库只保留示例。

### 来源识别与限流键

限流按来源分桶，来源由 `LAB_AUTH_PROXY_HEADER` 指定的头决定，但**只有直连对端是本机代理时
才读该头**：生产是 nginx 经 unix socket 连接（此时 `RemoteAddr` 为空），开发是回环地址。
其它对端一律使用对端地址本身，因此外部客户端无法靠伪造请求头给自己换一个限流桶。

- 取到的值必须是纯 IP 字面量（`1.2.3.4`、`2001:db8::1`）；带端口、主机名或非法值的头
  一律忽略并退回对端地址，宁可共用桶也不接受可疑输入。
- `x-forwarded-for` 只取**最右一段**：本仓库的 nginx 片段用 `$remote_addr` 覆盖写入，
  客户端自带的值不会被追加进信任范围。
- `LAB_AUTH_PROXY_HEADER=off` 关闭该机制，所有请求共用一个桶（仅排查用）。

## HTTP 服务

```sh
lab-auth serve [-insecure-cookies]
```

监听 `LAB_AUTH_LISTEN`（生产必须 unix socket）。公共接口在
`/api/auth/{csrf,register,login,confirm,session,cancel,logout}`；`/lab/api/auth/` 是同一份
契约的兼容别名（服务端两条前缀都挂载，`ops/nginx/auth-location.conf` 同时代理），
供尚未更新的客户端与缓存页面跨发布使用。`/health/live` 与 `/health/ready` 仅供本机运维，
不应经公网代理公开。日志只记录白名单字段（request_id、method、path、status、duration），
不含请求体、密码或 Cookie。

### 公开注册（register-v1）

- `POST {base}/register` 需已有 flow 与 CSRF；请求体仅 `{username,password}`。
- **注册不是登录**：201 只在 INSERT 成功后返回，不 Set-Cookie、不建立/更改 session；客户端拿到 201 后仍需走 `/login`→`/confirm`。
- 错误：400 规则、409 `registration_unavailable`（保留/停用/占用统一文案）、403 安全校验、413 过大、429 `rate_limited`+`Retry-After`、503 `registration_disabled`（开关关闭）或 `unavailable`（队列/存储/容量）。
- 取消/断线不会撤销已创建的账号，也不会自动登录或删除用户。
- 限流：内存来源预限流（HMAC 摘要，IPv6 按 /64 聚合）+ `rate_limits` 表的 `register:src:*`（小时）与 `register:global`（每日）持久额度。基本校验通过后先提交额度准入，再散列并在独立写事务中复核用户上限和唯一性；重复用户名、队列拒绝或写入失败不退还已准入额度。
- 散列共享全局 Argon2 池，注册同时最多 1 个散列任务、排队最多 2 个。
- 复用 schema v1（`users` 唯一约束 + `rate_limits`），不修改 `0001_init.sql`；201/409 的差异仍允许探测用户名可用性，这是该方案的已知权衡。

### 管理 API（admin-v1）

启用条件：设置 `LAB_AUTH_ADMIN_TOKEN`（至少 32 字符）。未设置时这些路由**存在但返回
503 `admin_disabled`**，不会悄悄退化成一个无鉴权的管理面。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/status` | 服务版本、环境、schema 版本、账号/会话/审计计数 |
| GET | `/admin/users` | 分页列表，支持 `search`、`enabled`、`limit`、`offset` |
| POST | `/admin/users` | 建号 `{username,password}` |
| GET | `/admin/users/{ref}` | 单账号；`ref` 是用户名或 user id |
| POST | `/admin/users/{ref}/enable` \| `/disable` | 启停（递增 credential_version 并撤销会话） |
| POST | `/admin/users/{ref}/password` | 重置密码 `{password}` |
| POST | `/admin/users/{ref}/sessions/revoke` | 撤销该账号全部会话 |
| DELETE | `/admin/users/{ref}` | 删除账号及其会话与尝试；最后一个可用账号需 `?force=1` |
| GET | `/admin/sessions` | 跨账号会话列表 |
| GET | `/admin/audit` | 审计流水（按时间倒序），支持 `target`、`action`、`limit`、`offset` |

- 鉴权只用 `Authorization: Bearer <token>`；**不读 Cookie**，所以浏览器会话无法调用管理面，
  也没有 CSRF 令牌要求。令牌比较恒定时间，缺失/错误统一 401，不区分原因。
- 每个变更写一条审计（actor `admin-api`）；CLI 写 `cli:<系统用户>`。审计表只增不改，
  删除账号不会删除它的审计记录（记录里存的是用户名）。
- 按来源限流（`LAB_AUTH_ADMIN_RATE`，默认每分钟 60），**令牌校验之前**先扣额度，因此错误令牌
  的尝试同样受限；失败只写日志、不写审计（审计表只增不删，不能让未认证的请求往里写）。
- `ops/nginx/auth-location.conf` 默认对 `/…/admin/` 返回 404：管理面不挂公网。需要远程操作时，
  用更精确的 location 按网段放行，或走内网监听 / ssh 隧道；服务本身不区分来源网段。

## CLI

```sh
lab-auth serve          [-insecure-cookies]

lab-auth user create|list|show|enable|disable|reset-password|revoke-sessions|delete
lab-auth session list|revoke
lab-auth audit list
lab-auth db status|verify|migrate|backup|restore
```

- 语法统一为 `<组> <动词> [flags] [ref]`；`migrate`、`backup`、`restore` 保留为顶层别名。
- 每个命令都接受 `-json`，输出与 `/admin/*` 的字段一致，便于脚本在 CLI 与 API 之间切换。
- **flag 必须写在位置参数之前**（Go flag 的标准行为）：`user show -db auth.db -json joyce`。
- 密码从终端隐藏读取两次；管道输入时按行读取，便于受控自动化。**没有** `--password` 参数。
- 停用、重置密码会递增 `credential_version` 并撤销该账号会话。
- `user delete` 会删除该账号的会话与登录尝试；删除最后一个可用账号需要 `-force`。
- 恢复备份会校验完整性并撤销恢复库中的所有会话。

## 数据库与迁移

- `schema_migrations` 记录每个已应用迁移的版本与 SHA-256；校验和不符时**拒绝启动**，
  因此已发布的迁移文件不可修改，只能追加新文件（`0003_*.sql` 起）。
- 期望版本不要写死：`store.LatestSchemaVersion()` 从内嵌迁移派生，测试与
  `GET /admin/status` 都用它，新增迁移不会留下过期字面量。
- `db status` 给出路径、schema 版本、账号/会话/审计计数；`db verify` 额外跑
  `PRAGMA integrity_check`。
- 备份/恢复沿用 `lab-auth db backup|restore`；恢复后所有会话都是撤销状态。

## 安全说明

- 密码使用独立随机 salt 的 Argon2id（PHC 格式），恒定时间比较；未知用户走虚拟校验。
- Cookie 值只存摘要；`schema_migrations` 校验和不符时拒绝启动。
- 本目录不存放真实账号、数据库、密钥或备份；本地数据统一放 Git 忽略的
  `.tools/boot-identity/`。
