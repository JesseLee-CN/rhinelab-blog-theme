# services/lab-auth

Rhine Lab 启动身份认证服务（G2 存储/密码/CLI，G3 HTTP 协议与安全）。接口契约见
`openapi.yaml`，数据模型见 `migrations/0001_init.sql`，跨模块规则见
`internal/identity` 与 `internal/config` 的实现。

## 布局

```text
cmd/lab-auth/          CLI 与服务入口（serve）
internal/config/       环境配置加载与校验
internal/identity/     用户名/密码规则（与 src/features/auth/identity.ts 对齐）
internal/password/     Argon2id PHC 散列与校验
internal/ratelimit/    有界定窗限流器（内存，重启重置）
internal/server/       /lab/api/auth/ HTTP 处理、Cookie、CSRF、日志
internal/store/        SQLite 架构、迁移、用户、flow/session、备份/恢复
migrations/            schema v1（embed，随二进制发布）
```

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
| `LAB_AUTH_REGISTRATION_ENABLED` | 默认 false；`1`/`true` 开放 register-v1 |
| `LAB_AUTH_REGISTER_SOURCE_HOURLY` | 每来源每小时注册尝试（默认 10，持久额度） |
| `LAB_AUTH_REGISTER_GLOBAL_DAILY` | 全站每日注册尝试（默认 200，持久额度） |
| `LAB_AUTH_REGISTER_MAX_USERS` | 用户总量上限（默认 5000，停用账号计入） |

生产缺少关键配置时 `Validate()` 拒绝启动，默认不监听公网。真实配置放
`ops/auth/*.env`（Git 忽略），仓库只保留示例。

## HTTP 服务

```sh
lab-auth serve [-insecure-cookies]
```

监听 `LAB_AUTH_LISTEN`（生产必须 unix socket）。公共接口仅在
`/lab/api/auth/{csrf,register,login,confirm,session,cancel,logout}`；`/health/live` 与
`/health/ready` 仅供本机运维，不应经公网代理公开。日志只记录白名单字段
（request_id、method、path、status、duration），不含请求体、密码或 Cookie。

### 公开注册（register-v1）

- `POST /lab/api/auth/register` 需已有 flow 与 CSRF；请求体仅 `{username,password}`。
- **注册不是登录**：201 只在 INSERT 成功后返回，不 Set-Cookie、不建立/更改 session；客户端拿到 201 后仍需走 `/login`→`/confirm`。
- 错误：400 规则、409 `registration_unavailable`（保留/停用/占用统一文案）、403 安全校验、413 过大、429 `rate_limited`+`Retry-After`、503 `registration_disabled`（开关关闭）或 `unavailable`（队列/存储/容量）。
- 取消/断线不会撤销已创建的账号，也不会自动登录或删除用户。
- 限流：内存来源预限流（HMAC 摘要，IPv6 按 /64 聚合）+ `rate_limits` 表的 `register:src:*`（小时）与 `register:global`（每日）持久额度。基本校验通过后先提交额度准入，再散列并在独立写事务中复核用户上限和唯一性；重复用户名、队列拒绝或写入失败不退还已准入额度。
- 散列共享全局 Argon2 池，注册同时最多 1 个散列任务、排队最多 2 个。
- 复用 schema v1（`users` 唯一约束 + `rate_limits`），不修改 `0001_init.sql`；201/409 的差异仍允许探测用户名可用性，这是该方案的已知权衡。

## CLI

```sh
lab-auth migrate        -db <path>
lab-auth user create    -db <path> <username>
lab-auth user list      -db <path>
lab-auth user disable|enable <username>
lab-auth user reset-password <username>
lab-auth user revoke-sessions <username>
lab-auth backup         -db <path> -out <file>
lab-auth restore        -src <file> -db <path>
```

- 密码从终端隐藏读取两次；管道输入时按行读取，便于受控自动化。
- **没有** `--password` 参数；命令不会回显密码。
- 停用、重置密码会递增 `credential_version` 并撤销该账号会话。
- 恢复备份会校验完整性并撤销恢复库中的所有会话。

## 安全说明

- 密码使用独立随机 salt 的 Argon2id（PHC 格式），恒定时间比较；未知用户走虚拟校验。
- Cookie 值只存摘要；`schema_migrations` 校验和不符时拒绝启动。
- 本目录不存放真实账号、数据库、密钥或备份；本地数据统一放 Git 忽略的
  `.tools/boot-identity/`。
