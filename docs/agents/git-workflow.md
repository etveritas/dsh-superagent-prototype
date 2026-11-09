# Git workflow

## Branch

Work on `main` and open pull requests against `main`. A `custom` branch also exists in this repo; do not open new work against it unless a maintainer asks.

## Commits

- Start the subject with a type — `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:` — with an optional scope: `fix(feishu): keep an event error when the ready line is read after it`.
- A subject with no type is acceptable when none fits; what the message must do is explain the reason, not restate the diff.
- Keep each commit focused on one change.

## Pull requests

- Say what changed, why, and what you ran. `pnpm check` must pass; if a part cannot run in your environment, say which part you did run.
- If the change depends on an upstream change that is not merged here yet, say so and link it.
- Compatibility is not promised. DSH is pinned to `^0.2.1-alpha.2` across the peer and dev dependencies, so treat a DSH upgrade as a migration: back up `stateDir` first ([006 Deployment](../006-deployment.md)) and expect the state schema to move with the code.

## Security

- **Never commit a token, a phone number, a chat id, a personal name or the real endpoint of a private instance.** Tests and docs use `example.com`, `acme/…` and placeholder ids.
- Do not open a public issue for a vulnerability; follow [SECURITY.md](../../SECURITY.md).
- The state directory holds credentials and conversation data. Do not paste its contents into an issue, a log line or a test fixture.
