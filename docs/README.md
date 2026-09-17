# 文档索引

本目录是模板的**操作与参考手册**：把开发过程中形成的结论、契约与参数整理成描述当前实现、
约定与操作方式的说明。历史开发文档已总结为本目录与仓库根的入口文档，不再单独分发过程记录。

仓库根的三个入口文档与本文互补：[README](../README.md)（定位与快速开始）、
[AGENTS](../AGENTS.md)（协作约束）、[BLOG-MAINTAIN-PERFECT.md](../BLOG-MAINTAIN-PERFECT.md)（维护手册）。

## 文档一览

| 文档 | 内容 |
| --- | --- |
| [AUTHORING.md](AUTHORING.md) | 写作与内容维护：目录约定、frontmatter 字段、草稿与未来文章、URL 与重定向、三维主题映射、常见问题 |
| [BUILD.md](BUILD.md) | 构建与发布：环境准备、构建顺序、本地预览、资源白名单、release 打包与激活、回滚、健康检查、排障 |
| [READER.md](READER.md) | 沉浸式全文阅读：模块职责、页面契约、窗口与布局参数、控件与目录导航、内容白名单与安全、滚动恢复、验证命令 |
| [IDENTITY.md](IDENTITY.md) | 启动身份与认证：三种身份、用户名/密码规则、状态机、接口与错误、Cookie/CSRF/Origin、超时与限流、取消竞争不变量、部署与运维 |
| [UPSTREAM.md](UPSTREAM.md) | 上游来源与署名：只读远端配置、相对上游的差异、第三方资源与许可、处理上游更新的原则 |
| [fonts/README.md](fonts/README.md) | 字体来源、许可与重建方式（MiSans 正文/UI、JetBrains Maple Mono 代码） |
| [media/README.md](media/README.md) | 界面截图与动图的采集记录与用途 |
| [../SANITIZE-NOTES.md](../SANITIZE-NOTES.md) | 本模板的脱敏范围、替换规则与残留边界 |

## 阅读顺序建议

- **要写文章**：[AUTHORING.md](AUTHORING.md) → [content/README.md](../content/README.md)
- **要部署上线**：[BUILD.md](BUILD.md) → [BLOG-MAINTAIN-PERFECT.md](../BLOG-MAINTAIN-PERFECT.md)
- **要改阅读层**：[READER.md](READER.md) → `src/article-reader*.ts` 与 `scripts/reading/`
- **要改登录/注册**：[IDENTITY.md](IDENTITY.md) → `services/lab-auth/openapi.yaml`
- **要同步上游或调整素材**：[UPSTREAM.md](UPSTREAM.md)
