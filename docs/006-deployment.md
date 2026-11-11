# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **An agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account.
- **Optional accounts:** a Feishu bot for chat requests, a WeCom intelligent robot, a WeChat bot logged in by QR code, a GitLab account for issues and merge requests, and a PingCode account for work items and their comments. Every Source plugin is enabled by default and appears in Sources settings; one nobody configures stays paused. A profile leaves a Source out with `disabled: true` on its entry.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- GitHub CLI (`gh`) 2.48 or later. Source CLI fields must point to `gh`, `glab` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- A repository on github.com; GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if that repository uses Git LFS.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot
- For GitLab: `glab` (tested with 1.102.0) and a GitLab account that is a Developer of every watched project, with a wrapper signed in only as that account
- For PingCode: `python3`, and the PingCode skill (a directory holding `scripts/api_call.py` and `.env`) configured with a PingCode enterprise app's user token

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

### Deploying without GitHub

In **Settings → Sources → GitHub**, turn off the GitHub Source and save. Setup restarts and skips the GitHub account and repository checks. Configure WeCom and GitLab independently below. A disabled GitHub Source does not provide a worker credential helper.

### WeCom robot (optional)

1. In the WeCom admin console, create an intelligent robot (智能机器人) for the team and note its **bot ID** and **secret**.
2. Save the bot ID and secret on the WeCom Source in the panel. A private deployment also sets the long-connection URL its admin console gives; leave it empty for `wss://openws.work.weixin.qq.com`.

The Source opens one long connection per bot and reconnects with backoff. WeCom keeps a single connection for a bot, so a second dsh-superagent or another client subscribed with the same bot takes the connection over; the Source reports that as an error and stops. Setup only checks that both credentials are present: a wrong secret shows as the WeCom Source's health, not as a setup problem, because it is known only once the connection is attempted.

An image a person sends is read from the encrypted URL WeCom pushes and decrypted with the message's own `aeskey`, then committed as an attachment: the main Session receives it beside the request card, and the worker Session of a ticket receives the images of the trigger it works from. The assessment lane reads any further image of the thread on demand. A read needs the configured model to accept image input; with a text-only model the image is left out instead of inspected. WeCom's image links expire about five minutes after the message arrives, so an image read after that window (for example by a ticket launched much later) is unavailable.

### WeChat bot (optional)

1. Open the WeChat Source's card under **Settings → Sources**, choose **扫码登录**, and scan the code with WeChat on a phone; confirm on the phone, and the token is saved and dsh-superagent restarts.

The Source polls the iLink bot API (`https://ilinkai.weixin.qq.com`) for direct messages and replies in the same conversation. It is a personal WeChat bot built on the bot backend that Tencent publishes as the MIT-licensed `@tencent-weixin/openclaw-weixin` package: it sees only what people send it, keeps no readable history (assessments read the window this process remembered), and sends text only. A token the backend rejects with `-14` shows as the Source's health, and the Source stops for an hour so the account can be logged in again; setup only checks that a token is saved, so a wrong token never blocks the rest of dsh-superagent.

> **Unofficial, and at the operator's risk.** This Source is not produced, endorsed or supported by Tencent, and the iLink endpoints are published with Tencent's `openclaw-weixin` plugin rather than as a stable, officially documented API: they can change or be withdrawn without notice, and fixes here are best effort. Scanning the code binds the bot to that WeChat account, so use a dedicated test account — not a personal or company primary account. Tencent may restrict an account whose traffic it considers outside its terms, and the saved token is a credential that grants access to that account.

### Agent GitLab account (optional)

1. Create a GitLab account for the agent and add it to every watched project as a Developer, which is the lowest role that may push branches.
2. Give it a `glab` configuration that holds only its own login, and a wrapper:

   ```sh
   GLAB_CONFIG_DIR="$HOME/.config/glab-dsh-superagent" glab auth login --hostname gitlab.com
   cat > ~/.local/bin/glab-agent <<'EOF'
   #!/bin/sh
   export GLAB_CONFIG_DIR="$HOME/.config/glab-dsh-superagent"
   exec glab "$@"
   EOF
   chmod +x ~/.local/bin/glab-agent
   ```

   The wrapper runs `glab` with that configuration directory; dsh-superagent calls it as `glab` in worker shells and sets `GITLAB_HOST` to the configured instance. `GITLAB_HOST` is glab's environment override, which every subcommand accepts, so the shim never adds `--hostname` (only some subcommands define it). A self-hosted instance works the same way with its hostname.

   Signing in with a token instead of interactively (`glab auth login --hostname <instance> --stdin < token`, or `--token`) stores no username, so the credential helper git asks answers with an empty username and every HTTPS push fails with `HTTP Basic: Access denied`. Add it once with `glab config set user <username> --host <instance>`; the API checks in setup pass either way.

### Agent PingCode account (optional)

1. Install the PingCode skill in a directory holding `scripts/api_call.py` and `.env`, and configure it with a PingCode enterprise app that issues a user token. Set `PINGCODE_AUTH_MODE=authorization_code` and `PINGCODE_ACCESS_TOKEN` in `.env`; dsh-superagent reads `/v1/myself` through the skill, so an enterprise (`client_credentials`) token that cannot see that endpoint does not work.
2. Authorize the agent's PingCode account in that directory:

   ```sh
   python3 scripts/auth_user.py
   ```

   The user token expires after 30 days. Run the same command to authorize again; until it succeeds, setup reports `pingcodeTokenInvalid`.

   The Source looks for the skill in `~/.agents/skills/pingcode`, then `~/.workbuddy/skills/pingcode`, and accepts another directory in the PingCode card's skill field. The `.env` decides which account answers, and dsh-superagent posts replies to work items as that account.

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The package is also published on npm, so the checkout and build steps can be replaced by a normal plugin install once the profile exists:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add @samanhappy/dsh-superagent
```

That package ships the built bundles, so `pnpm install` and `pnpm build` are skipped. Use the `link:$PWD` form above when working on a checkout.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there; for WeCom, the `dsh-superagent-wecom` entry; for WeChat, the `dsh-superagent-weixin` entry; for GitLab, the `dsh-superagent-gitlab` entry; for PingCode, the `dsh-superagent-pingcode` entry. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | no | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. Omitted, it is `state/superagent` under the DeepSeek Harness home (`$DSH_HOME`, by default `~/.dsh`), so a profile can mount the bundle without any configuration. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

The default `stateDir` is shared by every profile that mounts the bundle: one orchestrator owns a state directory, so name an explicit `stateDir` for each further profile, or the entries of the second profile fail to acquire the lock and do not activate.

## Start and stop

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Set the GitHub repository (`owner/name`), the agent CLI, for example `/home/me/.local/bin/gh-agent`, and the base branch that Tickets which are not pull requests start from. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages. For GitLab, set the instance hostname, the agent's `glab` wrapper, the projects (`group/project`), each project's base branch for Tickets that are not merge requests, and the switches for new Issues, new merge requests and comments; comments on a merge request diff are not received yet. For PingCode, set the skill directory, the `python3`, and the projects (ID, identifier or name), and the switches for new work items and comments; saving resolves each project through `/v1/pjm/projects`, and with both switches off only work items and comments that mention the agent are received.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts, GitLab accounts, Feishu users and PingCode accounts who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The default repository and base branch for Tickets that start outside a repository Source, such as IM Tickets, the directory root and a prepare command. To give each Ticket a checkout of the repository:

   ```sh
   [ -n "$DSH_SUPERAGENT_WORK_REF" ] || { echo "prepare: no pull/merge request head and no base branch configured" >&2; exit 1; }
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_REPOSITORY.git" "$DSH_SUPERAGENT_WORK_REF:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   `DSH_SUPERAGENT_WORK_REF` is the head of the pull or merge request that started the Ticket, or `refs/heads/<base branch>` otherwise: the GitHub or GitLab base branch for that Ticket, or the Executor's default base branch. Never fall back to the remote's default branch with `HEAD`: it differs from the integration branch in most repositories that release from a `dev` or `master` branch.

   List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the GitHub disclosure line, review bots, the commit author and the auto-merge condition.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone`, `channelIgnored` or `messageInvalid` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `feishu`, `history` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:feishu`, `source:gitlab`, `source:pingcode`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`; GitLab's has `host`, `cli`, `projects` as `[{"path": "group/project"}]`, `pollSeconds`, `failuresBeforeError`, and the switches `observeIssues`, `observeMergeRequests` and `observeComments`, off by default; PingCode's has `skill`, `python`, `projects` as `[{"project": "SCR"}]`, `pollSeconds`, `failuresBeforeError`, and the switches `observeWorkItems` and `observeComments`, off by default.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. PingCode's part is `{"allowed": [{"id": "<account name>"}]}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub, by `issues`, `mergeRequests` or `comments` for GitLab, and by `workItems` or `comments` for PingCode; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `directory`, `prepare` and `blockedCommands`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the GitHub repository and the agent's push access, writes the worker environment, and checks that git uses only the agent credentials for github.com. When the GitLab Source names a CLI, setup also verifies the account and its Developer access to every project, and checks the credentials for that instance. When the PingCode Source names a skill or a project, setup also verifies the skill directory, its `python3`, the user token through `/v1/myself`, and each project against `/v1/pjm/projects`. A Feishu, GitLab or PingCode setup failure disables only that Source. WeCom's credentials are checked for completeness only; the subscription itself is attempted by the Source, which reports a rejected bot as its health.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the agent's GitHub CLI, `glab` its GitLab CLI when configured, `lark-cli` the bot's CLI, and `git` runs git with the agent's configuration (next point) in an Executor Session's shell only; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target. The `glab` shim sets `GITLAB_HOST` to the configured instance.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLIs as the github.com and GitLab instance credential helpers, rewrites their SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN` and `GITLAB_HOST` are removed (the `glab` shim sets `GITLAB_HOST` itself). The host applies this configuration to every child process, so the `git` shim restores the operator's own `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` (or unsets them) in every shell that is not an Executor Session's or one of its subagents': the panel's terminal, and the Sessions this deployment did not start, keep the aliases, identity, HTTP proxy and includes the operator configured. The shells of Executor Sessions and their subagents carry the managed `DSH_SUPERAGENT_WORKER` variable, which only the `git` shim reads.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat. For GitLab, open an Issue or merge request, or comment with `@<agent username>`, in a watched project; with the comment and new-object switches on, objects and comments that do not mention the agent are received too. For PingCode, open a work item or comment with `@<agent account name>` in a watched project; with the work-item and comment switches on, the rest of a watched project is received too, subject to the admission table.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| A prepare command reads a Source variable that is empty | A variable is set only while the Ticket comes from that Source; a Ticket from another Source, such as an IM, sees an empty value. Do not build a path from it alone: name the repository explicitly or give the expansion a default, and test the command for a Ticket from each Source that can accept work |
| `git does not read the credential configuration dsh-superagent writes for github.com or the GitLab instance` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `The agent GitLab CLI (glab) was not found.` | Set the wrapper's absolute path, or a command name on `PATH`, on the GitLab card |
| `The agent GitLab CLI cannot read its account` | Sign the wrapper in with `glab auth login --hostname <instance>` |
| `@… cannot read …` or `@… is not a Developer of …` | Add the agent's GitLab account to that project as a Developer |
| `The GitLab Source names no project.` | Add at least one project, `group/project`, on the GitLab card |
| `No PingCode skill directory was found (it must hold scripts/api_call.py and .env): …` | Install the PingCode skill, or set its directory on the PingCode card |
| `The python3 the PingCode skill runs on was not found.` | Set `python` on the PingCode card to a `python3` command name or absolute path |
| `The PingCode skill could not call the API.` | Run `scripts/api_call.py` by hand as the operator's user and fix what it reports: the skill directory, its `.env`, or the network |
| `The PingCode user token is missing, expired or invalid; run scripts/auth_user.py in the skill directory to authorize again.` | Run that command in the skill directory; the user token expires after 30 days |
| `The PingCode API did not report the account of the user token.` | Use a user token (`PINGCODE_AUTH_MODE=authorization_code`); an enterprise token cannot read `/v1/myself` |
| `The project … was not found; name it by project ID, identifier or name.` | Fix the project row; saving resolves it against `/v1/pjm/projects` |
| `The PingCode Source names no project.` | Add at least one project on the PingCode card |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |

### WeCom personal GitLab authorization

Set `personalGitlabHost` to the GitLab HTTPS hostname (without the scheme) and
`personalGitlabAdmins` to the WeCom user IDs allowed to register projects in the
Super-agent entry's configuration. These IDs must also be on the WeCom sender
allowlist. Leave the host unset to use the standard setup.

In a direct conversation, ask the bot to bind a personal GitLab account and
supply its access token. The GitLab instance may also accept username/password
authorization. GitLab instances that disable the password grant require a
token. The bot stores the resulting access token in the deployment's private
state directory. Protect the state and conversation history. Expired tokens
must be rebound. The provided credential can appear in the original conversation
and its model history.

An administrator with a bound account can ask the bot to add a project by
HTTPS URL or namespace/project. A work request names the registered project in
its first message. The worker uses the originator's bound account for supported
GitLab API operations, including file and merge request reads, issue creation,
commits and opening merge requests. GitLab checks that account's actual
permissions. The configured mode disables the legacy GitLab source and
restricts managed sessions to their registered tools, including disabling shell,
local file tools and external subagents on the same profile.

To enable isolated ticket execution, set `personalGitlabWorkerImage` to a
trusted local Docker image on the non-root Linux host running Super-agent.
The image needs `/bin/sh`, the project's build tools and, for delegated
operations, working `codex` and `hermes` executables on its PATH with their
own model access. Set `personalGitlabWorkerModelEnv` to the name of the
deployment's dedicated model credential variable if the agents require one.
Only agent commands receive that variable. Keep model access separate from
GitLab authorization.
Commands run with an ephemeral home and share only their ticket's workspace.
The host's GitLab credentials, DSH history, and Docker socket are outside the
container. The GitLab broker can place an authorized project archive in that
workspace. Use the existing GitLab tool to commit the resulting file changes
and open an MR with the originator's permissions. This uses an archive,
without Git history or submodule checkout.
