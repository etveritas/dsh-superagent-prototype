# Testing

Vitest, over `tests/**/*.spec.{ts,tsx}`. `pnpm test` runs the suite; `pnpm vitest run tests/policy.spec.ts` runs one file.

## Shape of a test

- **Titles are sentences that state the behaviour**, not the function name: "grants explicit strength when the sender is allowed in its Source's part and the Source marked the Trigger addressed". A bare `it` is normal here; a `describe` groups only where it helps.
- **Fixtures build the domain**, they do not restate it. See [tests/fixtures/](../../tests/fixtures) and the small builder functions at the top of [tests/policy.spec.ts](../../tests/policy.spec.ts).
- **Panel tests are jsdom with React 18**, opted in per file with `// @vitest-environment jsdom`, not globally in [vitest.config.ts](../../vitest.config.ts). That config dedupes React so the panel and the host share one instance; keep `IS_REACT_ACT_ENVIRONMENT` and wrap updates in `act`.
- **No network and no real accounts.** DSH is mocked, a Source is fed a recorded payload, and ids are placeholders (`oc_1111…`, `acme/…`).

## What a change must include

- **Behaviour gets a test.** A Source, a prompt section, setup, the policy and the panel all change behaviour, so each needs one. A bug fix should fail before the fix and pass after it.
- **A new spec file is registered.** [tests/docs.spec.ts](../../tests/docs.spec.ts) fails unless `docs/007-architecture.md` lists it in the Tests table.
- **The documentation tests cover the docs you edited** — numbering, links, merge markers, and the module and test tables. A docs change is verified by `pnpm test`, not by reading.

## Running

`pnpm test` for the suite; `pnpm check` before you report done. If a part cannot run in your environment, say which part you did run.
