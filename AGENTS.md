# AGENTS.md

dsh-superagent is a DeepSeek Harness bundle: a proactive agent for the repositories a team watches — GitHub, and optionally GitLab — that assesses a request under a Policy, turns an authorized one into a Ticket, and works each Ticket in its own DSH Session.

## Every task

- **pnpm, not npm.** `pnpm install`; the repo pins `pnpm@11.7.0`. Node 22.19+ or 24.
- **Verify with `pnpm check`** — `pnpm typecheck` (`tsc --noEmit`), `pnpm test` (`vitest run`), `pnpm build` (`tsdown`, not `tsc`). CI runs the same command on Node 22 and 24.
- **There is no linter and no formatter.** Typecheck and tests are the only gates, so match the file you edit.
- **Adding, renaming or deleting a file means editing a table.** `tests/docs.spec.ts` fails unless `docs/007-architecture.md` lists every module under `src/` and every `tests/**/*.spec.ts(x)`.
- **Keep changes additive.** This is a fork beside a moving upstream; a rewrite is expensive to carry.
- **No secrets and no real data** — no token, phone number, chat id, private endpoint or personal name. Use `example.com`, `acme/…` and placeholder ids.

## Where to look

| If the task is… | Read |
| --- | --- |
| writing or changing TypeScript | [TypeScript](docs/agents/typescript.md) |
| writing or changing tests | [Testing](docs/agents/testing.md) |
| touching modules, services or dependency direction | [Architecture](docs/agents/architecture.md) |
| editing documentation, or a prompt | [Documentation](docs/agents/documentation.md) |
| adding a Source | [Sources](docs/agents/sources.md) |
| committing, branching or opening a pull request | [Git workflow](docs/agents/git-workflow.md) |

The design rationale is the numbered series in `docs/`, read in order from [000 Philosophy](docs/000-philosophy.md). For layout, services and state ownership, [007 Architecture](docs/007-architecture.md) is the authority; the pages above summarise it for an agent and do not repeat it.
