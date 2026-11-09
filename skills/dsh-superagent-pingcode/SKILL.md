---
name: dsh-superagent-pingcode
description: Read PingCode work items and their comments through the local PingCode skill.
---

The PingCode Source is the agent's PingCode account, read and answered through the local PingCode skill and the user token in its `.env`. Workers use orchestrator_read for context when needed: `pingcode/<work item ID>` for the work item's identifier, title, state and description, and `pingcode/<work item ID>/comments/<page>` for one page of its comments. A page holds 20 comments and names next_resource while another may follow. A comment is `{ id, from, at, text }`: `id` is PingCode's comment id, `from` its author's account name, and `at` its time. Reading does not create tickets or send replies. A work item or comment that mentions the agent's PingCode account, as `@<display name>` or `@<account name>`, reaches the gate without a switch; a person on the allowed list who mentions the account makes an explicit request. Allowed mentions subscribe the work item, so later comments there arrive without another mention, while the Source's new-work-item and comment switches also receive the rest of a watched project.

The execution environment names the project identifier in `$DSH_SUPERAGENT_PINGCODE_PROJECT`, the work item identifier in `$DSH_SUPERAGENT_PINGCODE_ITEM`, and the work item page in `$DSH_SUPERAGENT_PINGCODE_URL`; all are empty when the ticket did not start on PingCode.

dsh-superagent posts replies itself, as a PingCode comment on the work item, as HTML with a hidden marker so a retry does not duplicate it. When the assignment asks for a reply on the source conversation, use `orchestrator_reply`; do not post a comment yourself, with the skill's script or otherwise, or the conversation gets two. Record implementation, verification and material limitations in `orchestrator_report`.

Polling reads the work items whose `updated_at` moved, which a comment normally bumps, and reads all comments of a changed work item; nested replies (`reply_comment_id`) are flattened into that conversation. PingCode rate-limits requests, 200 a minute on the free plan, so the poll interval stays generous. An enterprise (`client_credentials`) token cannot read `/v1/myself` and is unsupported. Inline images and attachments are not read.
