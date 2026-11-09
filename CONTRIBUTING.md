# Contributing

Thanks for taking the time to help. This is an unofficial fork of
`deepseek-ai/dsh-superagent-prototype`; the upstream project is the source of truth for the core design, so an
improvement to the core may belong there instead of here.

## Before you start

- Read [docs/000-philosophy.md](docs/000-philosophy.md) and the numbered documents that touch what you want to
  change. The prompts and the documentation are part of the product, not an afterthought.
- Check whether the change is additive. This fork lives beside a moving upstream, and small, local changes are far
  cheaper to carry than rewrites.
- For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Set up

```sh
pnpm install
pnpm check        # typecheck, tests and build — the same command CI runs
```

Node 22.19+ or 24 and pnpm 11 are required. DSH itself is a peer dependency and is not installed to use the code
directly; the tests mock it.

## What a good change looks like

- **Tests come with behaviour.** The suite is the regression net for prompt and Source behaviour. A change to a
  Source, a prompt section, setup, or the panel should come with a test, and a bug fix should fail before the fix
  and pass after it.
- **Documentation is tested.** [docs/007-architecture.md](docs/007-architecture.md) must list every module in `src/`
  and every test file in `tests/`; `tests/docs.spec.ts` fails otherwise. Numbered documents must stay in order and
  every local link must resolve.
- **Match the surrounding style.** The code is written with dense comments that explain why, no semicolons, and
  small functions. Follow the file you are editing rather than a global style guide; `pnpm typecheck` and the tests
  catch most drift.
- **A new Source follows the cookbook.** [docs/008-cookbook.md](docs/008-cookbook.md) walks through every place a
  Source must be registered: the kind, the plugin row in `cordis.patch.yml`, the `*-watch` export in `package.json`,
  the Skill, the panel fields, setup verification, the docs and the tests.
- **No secrets, no personal data, no hidden network calls.** Never commit a token, a phone number, a chat id or a
  real endpoint of a private instance; use `example.com`, `acme/…` and placeholder ids, as the existing tests do.
- **Disclose unofficial integrations.** A Source that speaks a protocol not meant for third-party clients must say
  so in the README and in `docs/006-deployment.md`, with the account and terms-of-service risk it carries.

## Branches, commits and pull requests

- Open a pull request against `main`. A `custom` branch also exists in this repo; do not open new work against it
  unless a maintainer asks.
- Keep commits focused and start the subject with a type: `feat:`, `fix:`, `docs:`, `test:`, `refactor:` or
  `chore:`, with an optional scope such as `fix(feishu):`. A subject with no type is acceptable when none fits. A
  commit message explains the reason, not just the diff.
- A pull request says what changed, why, and what you ran. `pnpm check` must pass; if it cannot run in your
  environment, say which part you did run.
- If your change depends on an upstream change that is not merged here yet, say so and link it.

## Review

Reviewers look for: tests that would catch the regression, documentation that still matches the behaviour,
compatibility with the pinned DSH version, and whether the change belongs upstream. Expect questions about the
prompts, because they shape the agent's behaviour as much as the code does.

## Licence

By contributing you agree that your contribution is licensed under the MIT License, the same terms as the rest of
the repository. New files do not need a licence header.
