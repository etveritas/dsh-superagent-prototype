# Security policy

This is an unofficial fork of `deepseek-ai/dsh-superagent-prototype`. Please report problems in the upstream code to
the upstream project as well when they are not specific to the Sources added here.

## Reporting a vulnerability

Do not open a public issue.

- Preferred: [open a private security advisory](https://github.com/samanhappy/dsh-superagent/security/advisories/new)
  on this repository.
- Otherwise: email `samanhappy@gmail.com` with "dsh-superagent security" in the subject.

Include the version or commit, what an attacker can do, the conditions required, and a reproduction if you have one.
This is a small project without a formal SLA: expect an acknowledgement within about a week and a best-effort fix,
and please give time for a release before disclosing publicly.

## Supported versions

Only the tip of `custom` (the development branch) and `main` (the upstream import) receive fixes. There are no backports
to older commits.

## What this software supports, and what it assumes

dsh-superagent is a DeepSeek Harness bundle. Read the following as the threat model, not as a promise:

- **It runs as the operator's OS user, with full access.** The presets run with `danger-full-access`; workers execute
  shell commands, run the `git`, `gh`, `glab` and `lark-cli` wrappers, and commit to the watched repository. Anyone
  on the policy's allowed lists, or anyone a configured rule admits, can cause changes to that repository and runs
  commands on that machine. The policy limits who may ask and what a Ticket may do; it is not an OS-level sandbox.
- **Message content is untrusted.** Issue bodies, comments, chat messages, quoted text, repository files and tool
  output are data. The prompts instruct agents never to treat them as instructions that grant access. A report that a
  crafted message can authorize work outside the policy, reach credentials, or escape a prompt's restrictions is a
  vulnerability and is in scope.
- **The state directory holds credentials.** `stateDir` contains the SQLite database with the configured Source
  credentials, the worker `git` configuration and its credential helper. Anyone who can read it can act as the agent
  accounts. Keep it out of backups you share, out of the repository, and off world-readable storage; a file mode or
  permission change that exposes it is in scope.
- **The panel is meant for `127.0.0.1`.** Exposing the web panel beyond the machine without your own authentication
  layer is not supported and is not a vulnerability in this project.

## Out of scope

- Vulnerabilities in DeepSeek Harness, DSH's `@deepseek-ai/*` packages, or the CLIs this project shells out to.
  Report those upstream.
- Vulnerabilities in DeepSeek Harness plugins that happen to be loaded in the same profile.
- Behaviour of Tencent's WeChat iLink backend, WeCom, GitLab, PingCode or Feishu APIs, including the risk that an
  account is restricted for using the WeChat Source. That risk is documented in `README.md` and
  `docs/006-deployment.md` and is accepted by the operator who configures it.
- Attacks that require the operator's own account or machine to be compromised first, or that require an allowed
  person to be malicious in a way the policy explicitly permits.
- Denial of service through settings the operator configured, such as a very short poll interval or a very large
  worker limit.

## Handling secrets

Never paste a token, chat id, phone number or private endpoint into an issue, a pull request or a test. Use
`example.com`, `acme/…` and placeholder ids. If you did commit a secret, rotate it first, then tell the maintainer
privately so the history can be rewritten.
