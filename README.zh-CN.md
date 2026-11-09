# dsh-superagent

[English](README.md) | 简体中文

> **非官方 fork，不是 DeepSeek 产品。** 本仓库是
> [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的独立 fork，
> 由 samanhappy 维护。DeepSeek 与 DeepSeek Harness 团队不维护、不背书、也不支持本 fork。
> 上游代码以 MIT 协议发布，© 2026 DeepSeek Harness Team；本 fork 的修改与新增部分 © 2026 samanhappy，
> 采用同一协议。详见 [NOTICE](NOTICE)。

> **上游的免责声明仍然适用。** 上游把自己定位为「仅供参照的研究原型，不是 DeepSeek 官方产品」，大部分工程由
> 编码 agent 完成，并非生产就绪的软件。本 fork 不会把它变成经过加固的服务：它只是朝着「一个团队能每天使用」
> 的方向走了一步，并继承随之而来的限制。

dsh-superagent 是一个面向团队所关注仓库的主动式编码 agent，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的 bundle 形式交付。它监听 GitHub，也可选择监听 GitLab、飞书、PingCode、企业微信和微信。当允许的人向它提出工作时，它会建立工作项，在自己的 agent 会话与目录中执行，并在原会话中作答，例如提交一个 pull request。Web 面板展示哪些事情需要人来处理。

它同时也是一种与 agent 协作的方式：**尽可能少占用人的注意力，尽可能多地交付价值。** 能替整个团队行动的 agent，也可能浪费整个团队的注意力，所以它只在被要求时、或团队写下的规则允许时行动，只在有人必须行动或能用到结果时发言。[docs/000-philosophy.md](docs/000-philosophy.md) 解释了这一原则，以及它对运维者提出了什么要求。

## 面板截图

以下截图来自一次全新安装、尚未配置任何凭据的面板：接单前的部署检查、六个 Source，以及每个 Source 的配置位置。

![概览](assets/screenshots/overview.png)
![来源](assets/screenshots/sources.png)

![设置](assets/screenshots/settings.png)

## 本 fork 的定位

上游是一个参考实现：一个 GitHub 仓库、一个可选的飞书 Source，代码以阅读和改写为目的。本 fork 保留这套设计，并把它推进到这样的状态：团队可以像安装普通 DeepSeek Harness 插件一样安装它、让它长期运行，并把它接到团队已经在用的渠道上。

相对上游，具体做了这些：

- **一次安装，拿到全部 Source。** 每个 Source 都是 [cordis.patch.yml](cordis.patch.yml) 中独立的一行插件，并在 `package.json` 中各有自己的 `*-watch` 入口，因此一条 `dsh plugin add "link:$PWD"` 就能装好整个 bundle。profile 可以通过禁用对应行来去掉某个 Source；装了但还没配置的 Source 会保持暂停，并说明在等什么。
- **比上游更多的 Source。** GitLab（通过 `glab`：实例地址、项目、轮询，以及 issue、merge request、评论的 observe 开关）；PingCode（通过本地 PingCode 技能及其 user token：项目可按 ID、identifier 或名称解析，回复以工作项评论发出）；企业微信（智能机器人，每个 bot 一条长连接：退避重连、markdown 回复、会话窗口上下文，以及被其他客户端抢占连接时的明确报错）；微信（通过 iLink，面板扫码登录，长轮询接收私聊，在同一会话中回复）。GitLab、PingCode 和企业微信自带供 worker 使用的 Skill；四者都附带面板设置、setup 校验、文档与测试。
- **面向日常运维，而不只是演示。** Setup 会逐个校验已配置的 Source（仓库与 push 权限、GitLab 角色与各项目凭据、PingCode token 与项目、企业微信凭据、微信 token），单个 Source 失败只停用它自己；Source 会上报健康状态并退避重试，而不是持续打满；保存卡片在需要时重启服务；面板中英双语，每个配置项都在原地有说明。
- **核心持续演进时的回归网。** 约 1300 个测试、65 个文件，另有一致性测试保证模块表、测试表与所有本地链接不失效，并在 [CI](.github/workflows/ci.yml) 中对每次 push 和 PR 运行。

## 兼容性风险

本 fork 跟踪的是一个公开的研究原型，因此请把兼容性当作持续变化的对象，而不是承诺：

- **上游可能继续演进。** 如果 `deepseek-ai/dsh-superagent-prototype` 持续迭代，它的新提交会改到本 fork 扩展的同一批文件——`cordis.patch.yml`、preset 行、prompt 段落、面板、`package.json` 的 exports、`docs/`、`tests/`。rebase 到这些改动上会产生冲突，而 prompt 或 preset 代码的冲突可能在不报错的情况下改变 agent 行为。
- **DeepSeek Harness 仍是 alpha，且版本锁定。** peer 依赖要求 `^0.2.1-alpha.2`，dev 依赖锁定在该版本。发布出去的 bundle 也对 `0.2.2-rc.1` 桌面版做过冒烟验证（安装、启动、面板渲染）；除此之外，每个新的 DSH 版本都应视为未验证，直到测过为止。新的 DSH 版本可能改变这些 Source 调用的服务以及 bundle patch 格式；移植这些改动只能手工完成，在完成之前本 fork 会落后于上游。
- **硬分叉是双向漂移。** 上游的缺陷修复与安全修复不会自动到达这里；本 fork 的改进（尤其是新增的四个 Source）也基本不会被上游团队合并。两者不保证持续兼容。
- **不承诺线缆级兼容。** Source 的配置与状态数据库属于本 fork；数据库 schema 随代码演进，被新版本迁移过的状态目录无法被旧版本打开。升级前请按 [docs/006-deployment.md](docs/006-deployment.md) 的说明备份 `stateDir`。

实际做法建议：保持改动是增量式的，定期 rebase 到上游，把每次 DSH 升级当作一次带备份的迁移，合并前先读上游变更。如果你更看重长期稳定、而不是新增 Source，就锁定任一仓库的某个 commit，验证后再前进。

## 微信与企业微信

两者都是可选项，也很容易不启用。

- **企业微信** 对接企业微信的智能机器人 API。同一个 bot 只有一条长连接，会被本服务占用；如果另一个客户端用同一个 bot 订阅，本 Source 会报错并停止。
- **微信** 使用腾讯以 MIT 协议发布的 `@tencent-weixin/openclaw-weixin` 包背后的 iLink bot 协议。它不是稳定、官方文档化的 API，本 fork 与腾讯没有关联、也不受其背书。登录会把 bot 绑定到扫码的那个微信号，因此请使用专门的测试账号，而不是个人或公司主账号：腾讯可能限制它认为不符合其条款的流量，接口也可能在不通知的情况下变更或下线。保存下来的 token 就是凭据，请按凭据对待。

[docs/006-deployment.md](docs/006-deployment.md) 对两者有更详细的说明，包括如何拆解一次失败。

## 安装

安装步骤较多，所以由一个 agent 陪你完成。对你的编码 agent 说：

> 阅读本仓库的 SETUP.md，和我一起安装并配置 dsh-superagent。

它会一次只问一个简短的问题，先把完整计划给你看一遍，然后完成安装与配置。[SETUP.md](SETUP.md) 就是它遵循的步骤。

也可以不克隆仓库，直接安装 npm 上发布的 [`@samanhappy/dsh-superagent`](https://www.npmjs.com/package/@samanhappy/dsh-superagent) 包：在 setup 建好 profile 之后，把安装这一步换成普通的插件安装即可。

```sh
dsh plugin --profile superagent add @samanhappy/dsh-superagent
```

包里已带构建产物，因此不需要 `pnpm install`，也不需要额外构建。[docs/006-deployment.md](docs/006-deployment.md) 说明了两种安装路径各自验证了什么。

## 文档

按顺序阅读编号文档；每一篇只依赖它之前的内容。

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md)：手动安装、配置、升级与故障排查
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md)：新增一个 Source

## 开发

`pnpm check` 依次运行 typecheck、测试与构建。CI 在每次 push 和 PR 上运行同一条命令。

## 贡献

请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。影响 agent 行为、prompt 或 Source 的改动应当附带测试与文档；当模块或测试文件没有出现在 [007 Architecture](docs/007-architecture.md) 中时，文档测试会失败。也请阅读[行为准则](CODE_OF_CONDUCT.md)。

## 安全

漏洞不要开公开 issue。[SECURITY.md](SECURITY.md) 说明了如何私下报告，以及本软件对它运行所在的机器做了哪些假设。

## 许可证

[MIT](LICENSE)。上游声明完整保留；本 fork 的新增部分与第三方组件列在 [NOTICE](NOTICE) 中。
