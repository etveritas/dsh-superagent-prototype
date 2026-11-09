/** Normalizes GitLab issues, merge requests, and notes into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** What a GitLab conversation belongs to: an issue or a merge request. */
export type GitlabTarget = 'issue' | 'mergeRequest'
export interface GitlabRef { project: string; iid: number; target: GitlabTarget }
/** The Thread of one issue or merge request; the project path keeps the same number in two projects apart. */
export const gitlabThread = (project: string, iid: number): string => `${project}:${iid}`
const pathOf = (target: GitlabTarget): string => target === 'issue' ? 'issues' : 'merge_requests'
/** The web page of an issue or merge request on `host`, which is the configured GitLab instance. */
export const gitlabPage = (host: string, project: string, target: GitlabTarget, iid: number): string => `https://${host}/${project}/-/${pathOf(target)}/${iid}`
/** The reply address of an issue or merge request conversation, naming its note when the Trigger is one. */
export const gitlabChannel = (ref: GitlabRef, host: string, noteId?: number): ChannelRef => ({
  source: SOURCE, thread: `${SOURCE}:${gitlabThread(ref.project, ref.iid)}`,
  address: { project: ref.project, iid: String(ref.iid), target: ref.target, ...noteId ? { noteId: String(noteId) } : {}, url: gitlabPage(host, ref.project, ref.target, ref.iid) },
})

const UserSchema = z.looseObject({ id: z.number().optional(), username: z.string(), name: z.string().nullish(), bot: z.boolean().nullish() })
export type GitlabUser = z.infer<typeof UserSchema>
/** GitLab reports its automation accounts as users: the `bot` flag, `project_<id>_bot`/`group_<id>_bot`/`service_account_` names, and `[bot]` suffixes. */
const BOT_NAME = /^(?:project|group)_\d+_bot(?:_|$)|^service_account_|\[bot\]$/i
export const isHumanUser = (user: GitlabUser): boolean => user.bot !== true && !BOT_NAME.test(user.username)

/** A conversation note on an issue or merge request; `type: 'DiffNote'` carries a file position and is not ingested yet. */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: UserSchema, created_at: z.string().nullish(), updated_at: z.string().nullish(),
  system: z.boolean().nullish(), type: z.string().nullish(), discussion_id: z.string().nullish(),
  position: z.looseObject({ old_path: z.string().nullish(), new_path: z.string().nullish(), old_line: z.number().nullish(), new_line: z.number().nullish() }).nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
export const IssueSchema = z.looseObject({
  iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string().nullish(),
  created_at: z.string(), updated_at: z.string().nullish(), web_url: z.string().nullish(), author: UserSchema,
})
export type GitlabIssue = z.infer<typeof IssueSchema>
/** A merge request as the project's list endpoint returns it; GitLab also calls the number its `iid`. */
export const MergeRequestSchema = IssueSchema.extend({
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), draft: z.boolean().nullish(), work_in_progress: z.boolean().nullish(),
  source_branch: z.string().nullish(), target_branch: z.string().nullish(), sha: z.string().nullish(),
})
export type GitlabMergeRequest = z.infer<typeof MergeRequestSchema>
type Opened = { iid: number; title: string; description?: string | null; author: GitlabUser; created_at: string; web_url?: string | null }
/** True when `text` addresses the agent's GitLab username; GitLab usernames may contain dots, dashes and underscores. */
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^A-Za-z0-9_.@-])@${escapeRegExp(username)}(?![A-Za-z0-9_.-])`, 'i').test(text)
const actor = (author: GitlabUser, agent: string) => ({ actor: { source: SOURCE, id: author.username }, human: isHumanUser(author) && !sameName(author.username, agent) })
/** Formats a note's text with the file position of a diff note, which a person can also reply to. */
function noteText(note: GitlabNote): string {
  const position = note.position
  if (!position) return note.body ?? ''
  const path = position.new_path ?? position.old_path ?? ''
  const line = position.new_line ?? position.old_line
  return [`${path}${line != null ? `:${line}` : ''}`, note.body ?? ''].filter(Boolean).join('\n\n')
}
/**
 * Builds a Trigger for one note. A note carries the Trigger's own message; a diff note keeps its file and line,
 * which the reply address names indirectly through the thread.
 */
export function noteTrigger(note: GitlabNote, ref: GitlabRef, host: string, agent: string): Trigger {
  const at = note.updated_at ?? note.created_at ?? new Date().toISOString()
  const id = key('gitlab-note', ref.project, String(ref.iid), String(note.id), at)
  const page = gitlabPage(host, ref.project, ref.target, ref.iid)
  const position = note.position
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: gitlabThread(ref.project, ref.iid) }], ...actor(note.author, agent), at,
    text: noteText(note),
    ...(mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref, host, note.id), url: `${page}#note_${note.id}`,
    meta: { project: ref.project, iid: ref.iid, target: ref.target, kind: 'note', noteId: note.id,
      ...position ? { path: position.new_path ?? position.old_path ?? null, line: position.new_line ?? position.old_line ?? null } : {} } }
}
/** True for a note GitLab created itself, such as a label change or a commit push, which is not a person's message. */
export const systemNote = (note: GitlabNote): boolean => note.system === true
/** True for a note on a merge request's diff, which this Source does not ingest yet. */
export const diffNote = (note: GitlabNote): boolean => note.type === 'DiffNote' || note.position != null
/** Builds the Trigger for a newly opened issue or merge request: its title and description. */
function openedTrigger(opened: Opened, ref: GitlabRef, host: string, agent: string): Trigger {
  const page = gitlabPage(host, ref.project, ref.target, ref.iid)
  const description = opened.description ?? ''
  return { id: key(ref.target === 'issue' ? 'gitlab-issue' : 'gitlab-merge-request', ref.project, String(ref.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThread(ref.project, ref.iid) }], ...actor(opened.author, agent), at: opened.created_at,
    text: `${opened.title}\n\n${description}`,
    ...(mentions(description, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref, host), url: page, meta: { project: ref.project, iid: ref.iid, target: ref.target, kind: ref.target } }
}
/** Builds an issue Trigger for a project, which keeps the Trigger ID unique across the Source's projects. */
export const projectIssueTrigger = (issue: Opened, project: string, host: string, agent: string): Trigger =>
  openedTrigger(issue, { project, iid: issue.iid, target: 'issue' }, host, agent)
/** Builds the Trigger for a newly opened merge request: its title and description. */
export const projectMergeRequestTrigger = (merge: Opened, project: string, host: string, agent: string): Trigger =>
  openedTrigger(merge, { project, iid: merge.iid, target: 'mergeRequest' }, host, agent)
/** Reads the issue or merge request a Trigger belongs to from its meta, or undefined for a kind without one. */
export function gitlabRef(trigger: Trigger): GitlabRef | undefined {
  if (trigger.source !== SOURCE) return undefined
  const project = trigger.meta.project
  const iid = Number(trigger.meta.iid)
  const target = trigger.meta.target
  if (typeof project !== 'string' || !Number.isInteger(iid) || (target !== 'issue' && target !== 'mergeRequest')) return undefined
  return { project, iid, target }
}
/** Parses a GitLab issue or merge request URL on any instance into a Thread key; `12` alone is ambiguous across projects. */
export function gitlabUrlThread(url: string): string | undefined {
  const match = /^https?:\/\/[^/]+\/(.+?)\/-\/(issues|merge_requests)\/(\d+)(?:[?#].*)?$/.exec(url.trim())
  if (!match) return undefined
  return `${SOURCE}:${gitlabThread(match[1]!, Number(match[3]))}`
}
