# dsh-superagent

English | [简体中文](README.zh-CN.md)

> **Unofficial fork — not a DeepSeek product.** This repository is an independent fork of
> [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), maintained by
> samanhappy. Neither DeepSeek nor the DeepSeek Harness team maintains, endorses or supports this fork.
> The upstream code is MIT-licensed, © 2026 DeepSeek Harness Team; the changes and additions in this fork are
> © 2026 samanhappy, under the same licence. See [NOTICE](NOTICE).

> **The upstream caveat still applies.** The prototype describes itself as a "research prototype for reference only,
> not an official DeepSeek product", written largely by coding agents, and not production-ready software. This fork
> does not turn it into a hardened service; it is a step toward running it every day in one team, with the
> limitations that come with that.

dsh-superagent is a proactive coding agent for the repositories a team watches, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, GitLab, Feishu, PingCode, WeCom and WeChat. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Screenshots

The management panel on a fresh install, before any credential is configured: the deployment checks that gate taking work, the six Sources, and where each Source is set up.

![Overview](assets/screenshots/overview.png)
![Sources](assets/screenshots/sources.png)

![Settings](assets/screenshots/settings.png)

## What this fork is for

The upstream project is a reference implementation: one GitHub repository, one optional Feishu source, and code meant to be read and adapted. This fork keeps that design and takes it toward a state where a team can install it as a normal DeepSeek Harness plugin, leave it running, and point it at the channels the team already uses.

Concretely, on top of upstream:

- **Install once and get every Source.** Each Source is a separate plugin row in [cordis.patch.yml](cordis.patch.yml) with its own `*-watch` entry in `package.json`, so a single `dsh plugin add "link:$PWD"` installs the whole bundle. Profiles can drop a Source by disabling its row; a Source that is installed but unconfigured stays paused and reports why.
- **More Sources than upstream.** GitLab (through `glab`: instance host, projects, polling, observe switches for issues, merge requests and comments); PingCode (through the local PingCode skill and its user token: projects resolved by ID, identifier or name, replies as work-item comments); WeCom (an intelligent robot over one long connection per bot: reconnect with backoff, markdown replies, conversation-window context, and a clear error when another client takes the bot over); WeChat (via iLink, through a QR-code login in the panel, long polling for direct messages, replies in the same conversation). GitLab, PingCode and WeCom ship a Skill for workers; all four come with panel settings, setup verification, documentation and tests.
- **Day-two operation, not just a demo.** Setup re-checks each configured Source (repository and push access, GitLab role and credentials per project, PingCode token and projects, WeCom credentials, WeChat token) and a failing Source disables only itself; Sources report health and back off instead of hammering; saving a card restarts the service when it must; the panel is bilingual (English/Chinese) and documents every configuration field in place.
- **A regression net while the core changes.** About 1,300 tests across 65 files, plus documentation tests that keep the module table, the test table and every local link honest, run in [CI](.github/workflows/ci.yml) on every push and pull request.

## Compatibility risk

This fork tracks a public research prototype, so treat compatibility as a moving target rather than a promise:

- **Upstream may keep changing.** If `deepseek-ai/dsh-superagent-prototype` keeps evolving, its next commits touch the same files this fork extends — `cordis.patch.yml`, the preset rows, the prompt sections, the panel, `package.json` exports, `docs/`, `tests/`. Rebasing onto those changes will conflict, and conflicts in prompt or preset code can change agent behaviour quietly.
- **DeepSeek Harness is alpha and pinned.** Peer dependencies require `^0.2.1-alpha.2` and the dev dependencies are pinned to it. The published bundle is also smoke-tested against the `0.2.2-rc.1` desktop app (install, boot and panel render); treat every further DSH release as unverified until it is tested. New DSH releases may change the services these Sources call and the bundle patch format; porting those changes is manual work here, and this fork will lag upstream until it is done.
- **A hard fork drifts both ways.** Upstream bug fixes and security fixes do not arrive automatically, and improvements made here (the four added Sources in particular) are unlikely to be upstreamed by the upstream team. There is no guarantee that the two stay compatible.
- **No wire-level compatibility promise.** Source configuration and the state database belong to this fork; the database schema moves with the code, and a state directory migrated by a newer version cannot be opened by an older one. Back up `stateDir` before upgrading, as [docs/006-deployment.md](docs/006-deployment.md) says.

The practical stance: keep additions additive, rebase onto upstream regularly, treat each DSH upgrade as a migration with a backup, and read the upstream changes before merging. If you need long-term stability more than new Sources, pin a commit of either repository and test before moving.

## WeChat and WeCom

Both are optional and easy to leave off.

- **WeCom** talks to the intelligent-robot API of WeCom. The bot takes over the account's single long connection; if another client subscribes with the same bot, this Source reports that and stops.
- **WeChat** speaks the iLink bot protocol behind Tencent's MIT-licensed `@tencent-weixin/openclaw-weixin` package. It is not a stable, officially documented API, and this fork is not affiliated with or endorsed by Tencent. The login binds the bot to the WeChat account that scans the QR code, so use a dedicated test account rather than a personal or company primary account: Tencent may restrict accounts whose traffic it considers outside its terms, and the endpoints may change or be withdrawn without notice. The saved token is a credential; treat it as one.

[docs/006-deployment.md](docs/006-deployment.md) covers both in more detail, including how to take a failure apart.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

Installation also works without a checkout. The package is published as [`@samanhappy/dsh-superagent`](https://www.npmjs.com/package/@samanhappy/dsh-superagent) on npm, so the install step can be a normal plugin install into the profile that the setup already created:

```sh
dsh plugin --profile superagent add @samanhappy/dsh-superagent
```

The package ships the built bundles, so this needs no `pnpm install` or build step. [docs/006-deployment.md](docs/006-deployment.md) covers both install paths and what each one verifies.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build. CI runs the same command on every push and pull request.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Changes that affect the agent's behaviour, the prompts or the Sources should come with tests and documentation; the documentation tests fail when a module or a test file is missing from [007 Architecture](docs/007-architecture.md). Please also read the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) explains how to report one privately and what this software assumes about the machine it runs on.

## License

[MIT](LICENSE). The upstream notice is preserved; the fork's additions and third-party components are listed in [NOTICE](NOTICE).
