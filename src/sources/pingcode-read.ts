/** Read-only PingCode work item and comment inspection for assessments and workers. */
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { CommentSchema, WorkItemSchema, pingcodeRef, pingcodeText, pingcodeTime, type PingcodeComment, type PingcodeRef,
  type PingcodeWorkItem } from './pingcode-trigger.ts'

/** Comments one work item may hold before reads stop; a conversation longer than this is beyond one assessment's context anyway. */
const COMMENT_CAP = 500

/** Reads every comment of one work item, oldest first, skipping records PingCode's schema does not match. */
export async function workItemComments(commands: Commands, ref: PingcodeRef, tally?: Tally): Promise<PingcodeComment[]> {
  const listed = await commands.pingcode<{ values?: unknown[] }>({ method: 'GET', path: '/v1/comments', fetchAll: true,
    params: { principal_type: 'work_item', principal_id: ref.item } })
  const values = Array.isArray(listed?.values) ? listed.values : []
  const comments = validItems(CommentSchema, values.slice(0, COMMENT_CAP), tally)
  return comments.filter(comment => !comment.is_deleted).sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0))
}
/** Reads one work item's current state, which is also its conversation root. */
export async function workItem(commands: Commands, item: string): Promise<PingcodeWorkItem> {
  return commands.pingcode<PingcodeWorkItem>({ method: 'GET', path: `/v1/pjm/work_items/${encodeURIComponent(item)}`,
    params: { include_public_image_token: 'description' } })
}
/** Formats a work item as the model-facing root message of its conversation. */
export function rootMessage(work: PingcodeWorkItem): ContextMessage {
  const description = pingcodeText(work.description)
  const url = work.html_url ?? ''
  return { id: url || work.id, from: work.created_by?.name || work.created_by?.display_name || '', at: pingcodeTime(work.created_at),
    text: `${work.identifier ? `${work.identifier} ` : ''}${work.title}${description ? `\n\n${description}` : ''}`, ...url ? { url } : {} }
}
/** Formats a comment as a model-facing message of its work item's conversation. */
export const commentMessage = (comment: PingcodeComment): ContextMessage => ({
  id: String(comment.id), from: comment.created_by?.name || comment.created_by?.display_name || '', at: pingcodeTime(comment.created_at),
  text: pingcodeText(comment.content),
})

/** Context reader for a PingCode Trigger: the work item's description first, then its comments 100 per page, oldest first. */
export const pingcodeThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? trigger.id,
  read: async (commands, trigger, part, cursor) => {
    const ref = pingcodeRef(trigger)
    if (!ref) throw new Error('The Trigger is not a PingCode work item')
    const page = Math.max(1, Number(part === 'thread' ? cursor ?? '1' : '1') || 1)
    const tally = { skipped: 0 }
    const [work, comments] = await Promise.all([workItem(commands, ref.item), workItemComments(commands, ref, tally)])
    const start = (page - 1) * 100
    const messages: ContextMessage[] = []
    if (page === 1) messages.push(rootMessage(work))
    messages.push(...comments.slice(start, start + 100).map(commentMessage))
    return { messages, next: comments.length > start + 100 ? String(page + 1) : undefined,
      body: { item: work.id, identifier: work.identifier ?? '', title: work.title, state: work.state?.name ?? '',
        url: work.html_url ?? '', total: comments.length }, ...tally.skipped ? { status: `${tally.skipped} unreadable comments skipped` } : {} }
  },
}

/** A PingCode resource's work item ID and optional comments page. */
const RESOURCE = /^pingcode\/([A-Za-z0-9_-]{2,64})(?:\/comments\/([1-9]\d*))?$/
/** Reads a work item's summary, or a page of its comments, under `pingcode/<work item ID>` or `pingcode/<work item ID>/comments/<page>`. */
export async function readPingcode(commands: Commands, resource: string): Promise<unknown> {
  const match = RESOURCE.exec(resource)
  if (!match) throw new Error('Use pingcode/<work item ID>, or append /comments/<page>')
  const [, item, page] = match
  const tally: Tally = { skipped: 0 }
  const comments = await workItemComments(commands, { project: '', item: item! }, tally)
  const skipped = tally.skipped ? { skipped: tally.skipped } : {}
  if (page !== undefined) {
    const at = (Number(page) - 1) * 20
    return { messages: comments.slice(at, at + 20).map(commentMessage), ...skipped,
      ...comments.length > at + 20 ? { next_resource: `pingcode/${item}/comments/${Number(page) + 1}` } : {} }
  }
  const work = await workItem(commands, item!)
  return { item: work.id, identifier: work.identifier ?? '', title: work.title, state: work.state?.name ?? '', url: work.html_url ?? '',
    total: comments.length, message: rootMessage(work), ...skipped }
}
