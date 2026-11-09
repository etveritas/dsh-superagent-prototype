/** Read-only GitLab issue, merge request, and note inspection for assessments and workers. */
import { z } from 'zod'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { IssueSchema, MergeRequestSchema, NoteSchema, gitlabPage, gitlabRef, isHumanUser, type GitlabIssue, type GitlabMergeRequest,
  type GitlabNote, type GitlabRef, type GitlabTarget } from './gitlab-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

const collection = (target: GitlabTarget): string => target === 'issue' ? 'issues' : 'merge_requests'
/** Reads one page of an issue's or merge request's notes, skipping records GitLab's schema does not match. */
export async function notePage(commands: Commands, ref: GitlabRef, query: string, tally?: Tally): Promise<GitlabNote[]> {
  const listed = await commands.gitlabApi(z.array(z.unknown()), ref.project, `${collection(ref.target)}/${ref.iid}/notes?${query}`)
  return validItems(NoteSchema, listed, tally)
}
/** Reads the notes of an issue or merge request newest first, which is how the poller discovers what changed after its cursor. */
export const notePageDesc = (commands: Commands, ref: GitlabRef, page: number, tally?: Tally): Promise<GitlabNote[]> =>
  notePage(commands, ref, `sort=desc&order_by=updated_at&per_page=100&page=${page}`, tally)
/** Reads the description of an issue or merge request as a model-facing message, with the fields that tell a worker what it is. */
async function description(commands: Commands, ref: GitlabRef): Promise<{ message: ContextMessage; issue: GitlabIssue | GitlabMergeRequest }> {
  const issue = await commands.gitlabApi(ref.target === 'issue' ? IssueSchema : MergeRequestSchema, ref.project, `${collection(ref.target)}/${ref.iid}`)
  const url = issue.web_url ?? gitlabPage(commands.deployment.gitlab?.host ?? '', ref.project, ref.target, ref.iid)
  return { issue, message: { id: url, from: issue.author.username, at: issue.created_at, text: `${issue.title}\n\n${issue.description ?? ''}`,
    ...isHumanUser(issue.author) ? {} : { bot: true }, url } }
}
/** Formats a note as a model-facing message, marking automation accounts because their words never authorize work. */
export function noteMessage(note: GitlabNote, ref: GitlabRef, host: string): ContextMessage {
  const line = note.position?.new_line ?? note.position?.old_line
  const path = note.position?.new_path ?? note.position?.old_path
  return { id: String(note.id), from: note.author.username, at: note.created_at ?? note.updated_at ?? '', text: note.body ?? '',
    ...isHumanUser(note.author) ? {} : { bot: true }, url: `${gitlabPage(host, ref.project, ref.target, ref.iid)}#note_${note.id}`,
    ...path ? { path, ...line != null ? { line } : {} } : {} }
}
/** Reads a page of an issue's or merge request's conversation, with its description first on page 1, 100 notes per page. */
async function conversationPage(commands: Commands, ref: GitlabRef, page: number, tally?: Tally) {
  const messages: ContextMessage[] = []
  const host = commands.deployment.gitlab?.host ?? ''
  if (page === 1) messages.push((await description(commands, ref)).message)
  const notes = await notePage(commands, ref, `sort=asc&order_by=created_at&per_page=100&page=${page}`, tally)
  // System notes announce label and state changes; the pages an assessment reads hold what people wrote.
  messages.push(...notes.filter(note => note.system !== true).map(note => noteMessage(note, ref, host)))
  return { messages, next: notes.length === 100 ? String(page + 1) : undefined, ...tally?.skipped ? { skipped: tally.skipped } : {} }
}

/** Reads a non-hidden file or directory listing from the default branch of the project a GitLab Trigger belongs to. */
export async function readGitlabPath(commands: Commands, project: string, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden project source paths are available')
  const file = encodeURIComponent(parts.join('/'))
  if (kind === 'file') return commands.gitlabApi(project, `repository/files/${file}/raw?ref=HEAD`)
  const entries = await commands.gitlabApi(z.array(z.looseObject({ name: z.string(), type: z.string().nullish() })), project,
    `repository/tree?path=${file}&per_page=100`)
  return entries.filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules').sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => entry.type === 'tree' ? `${entry.name}/` : entry.name).join('\n')
}

/** Context reader for a GitLab Trigger: the issue or merge request conversation by page, whose first page is also its root and parent. */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? trigger.id,
  read: async (commands, trigger, part, cursor) => {
    const ref = gitlabRef(trigger)
    if (!ref) throw new Error('The Trigger is not a GitLab issue or merge request')
    const page = Number(part === 'thread' ? cursor ?? '1' : '1')
    const body = await conversationPage(commands, ref, page)
    return { messages: body.messages, next: body.next, body }
  },
}

/** A GitLab resource's project, kind, number, and optional notes page; the project path may contain slashes. */
const RESOURCE = /^gitlab\/(.+)\/(issues|merge_requests)\/([1-9]\d*)(?:\/notes\/([1-9]\d*))?$/
/**
 * Reads an issue or merge request description, or a page of its conversation notes, under
 * gitlab/<project>/issues/<number>, gitlab/<project>/merge_requests/<number>, or their /notes/<page>.
 */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const match = RESOURCE.exec(resource)
  if (!match) throw new Error('Use gitlab/<project>/issues/<number>, gitlab/<project>/merge_requests/<number>, or append /notes/<page>')
  const [, project, kind, number, notes] = match
  const ref: GitlabRef = { project: project!, iid: Number(number), target: kind === 'issues' ? 'issue' : 'mergeRequest' }
  const tally = { skipped: 0 }
  if (notes !== undefined) {
    const page = Number(notes)
    const listed = await notePage(commands, ref, `sort=asc&order_by=created_at&per_page=20&page=${page}`, tally)
    const host = commands.deployment.gitlab?.host ?? ''
    return { messages: listed.filter(note => note.system !== true).map(note => noteMessage(note, ref, host)), ...tally.skipped ? { skipped: tally.skipped } : {},
      ...listed.length === 20 ? { next_resource: `gitlab/${project}/${kind}/${number}/notes/${page + 1}` } : {} }
  }
  const { issue, message } = await description(commands, ref)
  const branches = 'source_branch' in issue && issue.source_branch && issue.target_branch ? { head: issue.source_branch, base: issue.target_branch } : {}
  return { iid: issue.iid, title: issue.title, state: issue.state ?? 'opened', ...branches,
    ...'merged_at' in issue && issue.merged_at ? { merged: true } : {}, ...'draft' in issue && issue.draft ? { draft: true } : {}, message }
}
