# Adding a Source

[008 Cookbook](../008-cookbook.md) walks each step in detail and is the reference. This page is the checklist plus the rules that are easy to miss.

## Checklist

A Source is not done until all of these exist:

1. **The kind and its loop** in `src/sources/<name>.ts`: `schema`, `fields`, `health`, `facts` where setup derives any, `environment` variables (with a `role` on those that name a repository, a pull or merge request head, or a base branch), and a loop that waits for setup, follows the switch, moves cursors after `receive`, keeps errors per item, reports health and stops on abort.
2. **The Trigger translation**, with stable ids, dropping the agent's own messages.
3. **The `scope`** that decides what the Source receives, decided from `meta` alone.
4. **The Channel**, whose `send` posts each message once and answers `gone` only when the conversation can never receive it, and whose optional `check` refuses text the Channel can never accept, such as one over the IM word limit, before Outbox queues a reply.
5. **The Source's part of the Policy** — its `allowed` list and its admission rows.
6. **The plugin row** in [cordis.patch.yml](../../cordis.patch.yml), plus the `*-watch` export and tsdown entry in [package.json](../../package.json).
7. **A Skill** under `skills/dsh-superagent-<name>/SKILL.md`, if workers need one.
8. **The panel fields** and the setup verification that checks them.
9. **Docs**: [006 Deployment](../006-deployment.md) for operation, and the README when the integration is user-visible.
10. **Tests**, and the module and its spec listed in the tables of [007 Architecture](../007-architecture.md).

## Rules

- **An installed but unconfigured Source stays paused** and says what it waits for. It never fails the bundle or another Source.
- **A failing Source disables only itself**, reports the reason and backs off. One Source must not break the Runtime.
- **Name no person, account or organization in code.** Identities come from settings.
- **Disclose unofficial integrations.** A Source that speaks a protocol not meant for third-party clients must say so in the README and in [006 Deployment](../006-deployment.md), with the account and terms-of-service risk it carries.
- **A credential belongs to the operator.** It is saved through the panel, never typed into a chat and never logged.
- **Repository roles come from one Source.** A variable that gives the starting repository (`repository`), a pull or merge request head (`head`), or a base branch for Tickets without one (`base`) sets `role` and is empty for a Ticket from another Source. The Executor takes the roles of one Source as a group into `DSH_SUPERAGENT_REPOSITORY` and `DSH_SUPERAGENT_WORK_REF`, never combining a repository from one Source with a base branch from another; never have a prepare command derive the base from the remote's default branch.
