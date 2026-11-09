# Architecture

[007 Architecture](../007-architecture.md) is the authority on layout, services and state ownership; read it before a change that crosses modules. This page is the operational summary an agent needs in order not to break a boundary.

## Where code goes

| Directory | Holds | Must not |
| --- | --- | --- |
| `src/core/` | the domain: Triggers, Threads, Tickets, the Engine, Policies, errors | import anything outside itself except Node hashing, or do I/O |
| `src/sources/` | one adapter per Source — GitHub, GitLab, Feishu, PingCode, WeCom, WeChat | import from `src/app` |
| `src/app/` | the Runtime, glue, API, store, passes, tools, views | — |
| `src/client/` | the management panel: React in the browser | import Node built-ins, or host values beyond the listed plain modules |
| `src/executor/` | running a Ticket in a DSH Session | — |
| `src/infra/` | health, commands, paths, environment, text | — |
| `src/*.ts` | cross-cutting singletons: `policy`, `admission`, `limits`, `deployment`, `setup`, `kv`, `navigation` | hold state a class already owns |

[src/index.ts](../../src/index.ts) is the plugin entry; [src/app/runtime.ts](../../src/app/runtime.ts) is the Runtime.

## Dependency direction

- **Hand a class the narrowest interface it needs**, as a `Pick` of the caller — `ExecutorHost`, `SettingsHost`, `SourceHost` and the rest. Nothing receives the Runtime itself.
- **A Source sees only its own `SourceContext`**, and touches a Ticket only through `bindThread` and `threadClosed`.
- **One writer per state.** The Engine writes Triggers, Threads, Decisions, Tickets and Assignments; a Source writes its own read positions and Thread `meta`; Settings, Prompts, Effects and the Outbox each own theirs; a health entry belongs to the part that claimed it. Read that table in 007 before adding a write.
- **Refusals are typed, never free text.** A refusal a person can cause is `UserError(code, values)` from `USER_ERRORS` in [src/core/errors.ts](../../src/core/errors.ts); a setup failure is a `SetupError` code in [src/setup.ts](../../src/setup.ts); a health text is a `HealthCode` in [src/sources/host.ts](../../src/sources/host.ts). The API and the panel word them from the code.

## Changing behaviour

Behaviour lives in three places, and one change often touches more than one: the code, the prompts in `prompts/`, and the settings schemas. A new concept needs to clear the bar in [000 Philosophy](../000-philosophy.md) ("few concepts"); a new setting needs a reason a default will not do. Prefer an attribute or a prompt over a new concept.
