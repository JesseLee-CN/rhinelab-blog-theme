# 启动身份与认证服务

`/lab/` 在开场动画之前会显示身份选择：**REGISTERED USER** 走同源认证服务，**GUEST** 直接进入。
认证是**可选组件**——服务不可用时 GUEST 与全部公开阅读仍然可用，认证故障不会影响博客。

前端是一个自包含功能模块 `src/features/auth/`：`entry.ts` 是身份门状态机与宿主端口契约，
`intro.ts` 是序幕幕布、`panel.ts` 是登录/注册面板、`identity.ts` 是 lab 侧阶段表、
`client.ts` 所属的账号规则与协议客户端在 `shared/auth/`（博客页共用同一实现）。
模块边界、`EntryHost` 端口与增删流程见 [FEATURES.md](FEATURES.md)；账号数据库的管理
（CLI 与管理 API）见本文 §8，与博客共享登录态见 §9。

## 1. 三种身份

| 身份 | 来源 | 说明 |
| --- | --- | --- |
| `none` | 初始状态 | 未选择身份，不渲染任何姓名帧 |
| `guest` | 本地选择 | 不请求认证 API；不产生任何服务端状态 |
| `registered` | 服务端响应 | `userId` / `username` / `label` **只能**来自 `session` 或 `confirm` 响应 |

- 展示名 `label` 由服务端返回的 username 大写派生（`usernameLabel`），**不使用输入框内容**。
- 前端身份阶段只是交互状态，**不是权限判据**；权限始终由服务端会话决定。
- 输入框内容、查询参数与全局对象都不能制造注册身份。

## 2. 用户名与密码规则

| 项 | 规则 |
| --- | --- |
| 用户名字符集 | `[A-Za-z0-9._-]`，3–24 个 Unicode 码点 |
| 唯一键 | ASCII 小写（`usernameKey`）；大小写冲突由唯一约束拒绝 |
| 保留名 | `guest`（小写比较）不可注册 |
| 展示值 | 大写，形如 `ID CONFIRMED : <LABEL>` |
| 密码长度 | 15–128 个 Unicode 码点 |
| 密码处理 | 原样 UTF-8 字节校验，**不 trim、不归一化、不截断**；允许空格与粘贴 |
| 散列 | Argon2id，19 MiB / 迭代 2 / 并行度 1；并发 2、队列 8 |

长度一律按码点计（`[...value].length`），前后端一致。密码只经由隐藏输入或管道传入，
CLI **没有也不接受** `--password` 参数。

## 3. 状态机

**序幕阶段**（`IntroPhase`）：
`connecting → docking → ready → exiting → handoff → playing → entered`；
资源失败走 `connecting → resource-error`；`disposed` 为终态。开启「减少动态效果」时
`connecting → ready`、`ready → handoff`（跳过停靠与退出动画）。

**面板阶段**（`EntryPanelPhase`）：`login ↔ register`；`busy` 是独立布尔量，不写进 phase。
ready 之前表单为 inert；登录页按 `Esc` 取消进行中的登录并留在原页，注册页按 `Esc` 返回登录；
默认不自动聚焦输入框（避免手机软键盘打断入场）。

**认证阶段**（`AuthPhase`）：`idle / verifying / confirming / cancelling / registering`。

- `registering` 成功或失败都回到 `idle`，**不直接进入** `confirming`——注册不是登录。
- 界面关闭只作废本地代次（epoch），**不等于**服务端已取消。

## 4. 接口

前缀固定为 `/lab/api/auth/`；schema 与错误细节以 `services/lab-auth/openapi.yaml` 为准。

| 方法 | 用途 | 关键规则 |
| --- | --- | --- |
| `GET /csrf` | 建立预认证 flow | 不覆盖已认证 session；建立独立 flow Cookie |
| `POST /login` | 校验密码，签发 pending | 此时 `session` 仍返回未认证 |
| `POST /register` | 创建公开账号 | `201` 只表示已写入；**不 Set-Cookie、不自动登录、不改既有 session** |
| `POST /confirm` | pending → active | 事务内激活；**不 Set-Cookie** |
| `GET /session` | 查询状态 | 不写 Cookie；pending / 过期 / 撤销 / 停用 / 旧凭据版本均返回未认证 |
| `POST /cancel` | 幂等取消 | 可取消 pending 与本 attempt 的 active，不影响其他 attempt |
| `POST /logout` | 撤销当前会话 | 幂等 |

统一错误对象 `{ error: { code, message }, requestId }`，状态码 `400 / 401 / 403 / 409 / 413 / 429 / 503`。
**登录失败不区分「用户不存在」**，避免账号枚举。

## 5. Cookie、Origin 与 CSRF

| 项 | 值 |
| --- | --- |
| 会话 Cookie | `__Host-lab-session`：`Secure; HttpOnly; SameSite=Lax; Path=/`，无 `Domain` |
| Flow Cookie | `__Host-lab-flow`：同上，用于预认证取消 |
| CSRF | 绑定 flow 或当前会话，走 `X-CSRF-Token` 头；不放 URL、不记日志 |
| Origin | 精确允许列表；POST 同时校验 Origin 与 Fetch Metadata；只信任本机代理传来的真实源地址 |

会话 Cookie 是**持久 Cookie**：默认 30 分钟空闲过期、12 小时绝对过期。前端加载时查询 `/session`，
仍有效时在登录面板显示 `CONTINUE AS <用户名>` 并预填用户名；登出会同时清除服务端会话与 Cookie。

## 6. 数据与超时

持久表：`schema_migrations`、`users`、`flows`、`login_attempts`、`sessions`、`rate_limits`
（见 `services/lab-auth/migrations/0001_init.sql`）。Cookie 只存摘要，不存明文密码；
散列在数据库写锁之外计算，写前在事务内复核账号 `enabled` 与 `credential_version`。

| 项 | 默认值 |
| --- | --- |
| 会话空闲 / 绝对 | 30 分钟 / 12 小时 |
| pending 未确认 | 60 秒 |
| 预认证 flow | 10 分钟 |
| 请求体上限 | 4 KiB |
| 来源限流 | 每分钟 10 次、burst 3 |
| 用户名限流 | 15 分钟内 5 次失败后进入退避 |
| 每 flow 未结束 attempt | ≤ 4 |
| 注册额度 | 来源 10/小时、全站 200/日、账号上限 5000 |

注册默认**关闭**（`LAB_AUTH_REGISTRATION_ENABLED=0`）；开启后 `register:` 命名空间与登录限流相互独立。
注册的 `201` 与 `409` 差异仍允许探测某个用户名是否可用——已用统一失败文案、限流与不返回既有账号
详情来收敛，但**不宣称完全消除枚举**。

## 7. 取消与竞争（不变量）

1. 每次打开或提交都递增前端 epoch；关闭、`Esc`、切到 GUEST 立即作废当前 epoch。
2. 校验密码成功只得到 pending；仅当前 epoch、已收到 Cookie 且仍处于提交态才发 `confirm`。
3. `cancel` 先提交 → `login`/`confirm` 必须被拒绝；`confirm` 先提交 → `cancel` 撤销其 session。
   终态不会被随后到达的异步结果改回 pending。
4. `confirm` 响应不得 Set-Cookie；`cancel` 不清除固定 session Cookie（避免迟到的取消覆盖后来的登录）。
5. 同一页面禁止重叠 `login`；有未完成 login 时仍允许 GUEST，但暂停下一次注册提交。
6. pending 60 秒未确认即失效；撤销记录保留到会话不可能再有效为止。
7. 多标签共享 Cookie，以服务端复核为准；进入 registered 前与重新聚焦时核对 `userId`，
   不匹配则回到身份选择。
8. 离线取消只标记待确认，仅持久化不含秘密的 `attemptId`；恢复后核对 session。
   **不把 `AbortController` 当作服务端撤销。**

## 8. 账号管理（CLI 与管理 API）

账号数据库的增删改查有两条等价通道，字段与语义一致，脚本可以在两者之间切换：
命令行（`lab-auth user|session|audit|db`）与 HTTP 管理接口（`{base}/admin/*`）。

**前缀**：规范前缀是 `/api/auth`——博客静态页与 `/lab/` 三维档案都是同一个账号服务的
客户端，共用同一个 `__Host-lab-session` Cookie。`/lab/api/auth/` 仍然挂载为兼容别名
（服务端两条前缀都注册，`ops/nginx/auth-location.conf` 同时代理），供未更新的客户端跨发布使用。

**管理接口**（契约见 [services/lab-auth/openapi.yaml](../services/lab-auth/openapi.yaml)）：

| 操作 | 接口 |
| --- | --- |
| 状态 | `GET /admin/status`（版本、schema、账号/会话/审计计数） |
| 列表 / 单条 | `GET /admin/users`（`search`、`enabled`、`limit`、`offset`）、`GET /admin/users/{ref}` |
| 建号 | `POST /admin/users` `{username,password}` |
| 启停 | `POST /admin/users/{ref}/enable`、`/disable` |
| 重置密码 | `POST /admin/users/{ref}/password` `{password}` |
| 撤销会话 | `POST /admin/users/{ref}/sessions/revoke`、会话列表 `GET /admin/sessions` |
| 删除 | `DELETE /admin/users/{ref}`（最后一个可用账号需 `?force=1`） |
| 审计 | `GET /admin/audit`（`target`、`action`、`limit`、`offset`） |

- **默认关闭**：未设置 `LAB_AUTH_ADMIN_TOKEN` 时这些路由返回 503 `admin_disabled`，
  不会退化成无鉴权接口。令牌至少 32 字符，恒定时间比较，缺失/错误统一 401。
- 接口**只认 Bearer 令牌、不读 Cookie**，因此浏览器会话或 XSS 都无法调用管理面，
  也不存在 CSRF 面；请求按来源限流。
- 每次变更写一条审计（actor `admin-api`；CLI 写 `cli:<系统用户>`，动作
  `user.create|enable|disable|password|delete`、`session.revoke`）。审计表只增不改，
  删除账号不删除其审计记录。
- 删除账号会同时删除它的会话与登录尝试（外键没有级联），并在同一事务内完成；
  删除最后一个可用账号被拒绝，除非显式 `force` / `-force`。
- 命令行语法统一为 `<组> <动词> [flags] [ref]`，flag 写在位置参数之前，所有命令支持
  `-json`。命令与输出示例见 [services/lab-auth/README.md](../services/lab-auth/README.md)。

## 9. 与博客共享登录态

- 登录态就是**一个源级 Cookie**：`__Host-lab-session`，`Path=/`、`Secure`、`HttpOnly`、
  `SameSite=Lax`。博客页与 `/lab/` 同源，因此任一侧登录后另一侧在下次 `GET /session`
  就能看到同一身份，不存在第二套会话或票据交换。
- 博客侧页面（静态 HTML）在加载后查询 `GET /api/auth/session`：页头账号控件显示用户名，
  `/account/` 页显示当前身份与退出按钮。没有 JavaScript 时它们退化为指向 `/account/` 的
  普通链接，文章阅读完全不受影响。
- 同一浏览器的多个标签页通过 `BroadcastChannel("rhine-auth")`（不支持时退回 `storage`
  事件）即时同步登录/退出；`/lab/` 在启动时读取同一 Cookie 并据此提供
  「CONTINUE AS <用户名>」。
- 前端共享实现在 `shared/auth/`：`identity.ts` 规则、`client.ts` 协议客户端、
  `session.ts` 会话桥（缓存、登录/退出、跨标签同步）。三维入口的功能模块
  `src/features/auth/` 与博客的 `apps/blog/src/scripts/account.ts` 都用它，不各自实现协议。
- 安全边界不变：身份只作展示与交互状态，权限始终由服务端会话决定；两端都不缓存密码。

## 10. 部署与运维

- 服务用户独立于网页账号（nologin），二进制放 `/srv/example-blog-auth/releases/<版本>/`，
  用 `current` 软链切换；配置放 `/etc/example-blog-auth/auth.env`（0640），
  数据放 `/var/lib/example-blog-auth/`（0600）。
- 服务只监听 **unix socket**，由 nginx 代理 `/api/auth/`（兼容前缀 `/lab/api/auth/`），
  不直接暴露端口。建议在 nginx 层限制或仅内网开放 `/api/auth/admin/`。
- unit 模板见 `ops/systemd/example-auth*.{service,timer}`，脚本见 `ops/auth/`
  （`prepare.sh` / `activate.sh` / `rollback.sh` / `backup.sh` / `healthcheck.sh`）。
- 备份使用一致性快照（SQLite `VACUUM INTO`）并对快照做完整性校验；
  `example-auth-backup.timer` 每日执行并保留最近若干份。
- 只关闭注册时，优先把 `LAB_AUTH_REGISTRATION_ENABLED` 置 0 并重启服务——登录与 GUEST 不受影响。
- 数据库 schema 由 `schema_migrations` 版本化并校验 SHA-256：已发布迁移不可修改，
  只能追加 `000N_*.sql`；校验和不符时服务拒绝启动。期望版本取
  `store.LatestSchemaVersion()`，不要写死。

## 11. 测试与验证

```bash
npm run test:identity     # 用户名/展示名规则（shared/auth/identity.ts）
npm run test:entry        # 身份时间线（帧点、打字节奏、标签派生）
npm run test:login-e2e    # 登录/注册端到端（Playwright）
npm run check:flow        # 认证流程契约
npm run check:account     # 账号端到端：CLI 建号 + 博客登录 + /lab/ 共享同一会话（需 Go）
npm run check:artifacts   # 构建产物与配置检查
npm run bench:auth        # 认证容量压测（隔离库）
npm run test:packaging    # 打包与配对（需要 Go 工具链构建二进制）
```

服务端自身：`cd services/lab-auth && go vet ./... && go test ./...`。测试要覆盖：
大小写用户名、保留名、边界长度、密码空格与 Unicode、错误密码、停用、重置后旧密码失效、
重复迁移、隔离备份恢复、账号删除的连带行与最后一个账号保护、审计流水、管理接口的
令牌与禁用分支，以及 CLI 不回显密码。测试账号应随机生成且只写入隔离数据库——
**源码与文档里不放长期凭据**。

## 12. 相关文档

- [docs/README.md](README.md)：文档索引
- [FEATURES.md](FEATURES.md)：功能模块划分（`auth` 模块的端口、门面与增删流程）
- [BUILD.md](BUILD.md)：构建与发布（含认证服务部署）
- [../services/lab-auth/README.md](../services/lab-auth/README.md)：服务实现与本地运行
- [../services/lab-auth/openapi.yaml](../services/lab-auth/openapi.yaml)：接口真源
