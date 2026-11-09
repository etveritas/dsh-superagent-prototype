/** Normalizes PingCode work items and comments into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'pingcode'
/** What a PingCode event belongs to: one work item of one project. Work item IDs are unique across the enterprise, and the project keeps the reply target. */
export interface PingcodeRef { project: string; item: string }
/** The Thread of one work item; its page is the work item itself. */
export const pingcodeThread = (item: string): string => item
/** The reply address of a work item conversation, naming its comment and identifier when the Trigger knows them. */
export function pingcodeChannel(ref: PingcodeRef, url: string, commentId?: string, identifier?: string): ChannelRef {
  return { source: SOURCE, thread: `${SOURCE}:${pingcodeThread(ref.item)}`,
    address: { project: ref.project, item: ref.item, url, ...commentId ? { commentId } : {}, ...identifier ? { identifier } : {} } }
}

const UserSchema = z.looseObject({ id: z.string(), name: z.string().nullish(), display_name: z.string().nullish(), email: z.string().nullish() })
export type PingcodeUser = z.infer<typeof UserSchema>
/** A PingCode work item as the list and search endpoints return it. */
export const WorkItemSchema = z.looseObject({
  id: z.string(), identifier: z.string().nullish(), title: z.string(), description: z.string().nullish(),
  type: z.string().nullish(), html_url: z.string().nullish(), created_at: z.number().nullish(), updated_at: z.number().nullish(),
  project: z.looseObject({ id: z.string(), identifier: z.string().nullish(), name: z.string().nullish() }).nullish(),
  state: z.looseObject({ name: z.string().nullish(), type: z.string().nullish() }).nullish(),
  created_by: UserSchema.nullish(),
})
export type PingcodeWorkItem = z.infer<typeof WorkItemSchema>
/** A comment on a work item; `is_reply_comment` marks a reply to another comment. */
export const CommentSchema = z.looseObject({
  id: z.string(), content: z.string().nullish(), created_at: z.number().nullish(), created_by: UserSchema.nullish(),
  is_reply_comment: z.number().nullish(), replied_comment: z.looseObject({ id: z.string().nullish() }).nullish(), is_deleted: z.number().nullish(),
})
export type PingcodeComment = z.infer<typeof CommentSchema>

/** PingCode timestamps are epoch seconds; Triggers and cursors use ISO strings. */
export const pingcodeTime = (seconds: number | null | undefined): string =>
  Number.isFinite(seconds) ? new Date(Number(seconds) * 1000).toISOString() : new Date().toISOString()
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
const decode = (text: string): string => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, body: string) => {
  const lower = body.toLowerCase()
  if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16) || 32)
  if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10) || 32)
  return ENTITIES[lower] ?? all
})
/**
 * PingCode descriptions and comments are HTML; the model-facing text keeps their line structure and drops the markup,
 * because a worker reads prose rather than tags. Paragraph, line and list breaks become newlines; other tags vanish.
 */
export function pingcodeText(html: string | null | undefined): string {
  const raw = String(html ?? '')
  if (!raw.trim()) return ''
  return decode(raw.replace(/<(?:br|hr)\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li|ul|ol|h[1-6]|blockquote|tr|table|pre)>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
/** True when `text` addresses the agent's PingCode account, by its display name or its account name. */
export const mentions = (text: string, names: readonly string[]): boolean =>
  names.some(name => !!name && text.includes(`@${name}`))
/** True when the work item or comment was written by the agent's own account, which this Source never answers. */
export const ownWork = (author: PingcodeUser | null | undefined, agentId: string): boolean => !!author && author.id === agentId
/** The account names a Trigger of this Source may mention: the display name first, then the account name. */
export const agentNames = (account: { login: string; displayName?: string | undefined }): string[] =>
  [...new Set([account.displayName ?? '', account.login].filter(Boolean))]

/** Builds the Trigger for one comment on a work item, with its author, time and mention state. */
export function commentTrigger(comment: PingcodeComment, ref: PingcodeRef, names: readonly string[], agentId: string, page = '',
  identifier = ''): Trigger {
  const at = pingcodeTime(comment.created_at)
  const text = pingcodeText(comment.content)
  // A mention may survive in the markup but not in the flattened text, so both are searched.
  return { id: key('pingcode-comment', ref.item, comment.id), source: SOURCE, threads: [{ source: SOURCE, id: pingcodeThread(ref.item) }],
    actor: { source: SOURCE, id: authorId(comment.created_by) }, human: !ownWork(comment.created_by, agentId), at, text,
    ...mentions(`${text}\n${String(comment.content ?? '')}`, names) ? { addressed: 'mention' as const } : {},
    channel: pingcodeChannel(ref, page, comment.id, identifier), ...page ? { url: page } : {},
    meta: { project: ref.project, item: ref.item, kind: 'comment', commentId: comment.id, identifier } }
}
/** Builds the Trigger for a newly created work item: its title and description. */
export function workItemTrigger(item: PingcodeWorkItem, project: string, names: readonly string[], agentId: string): Trigger {
  const ref: PingcodeRef = { project, item: item.id }
  const at = pingcodeTime(item.created_at)
  const description = pingcodeText(item.description)
  const url = item.html_url ?? ''
  return { id: key('pingcode-work-item', project, item.id), source: SOURCE, threads: [{ source: SOURCE, id: pingcodeThread(item.id) }],
    actor: { source: SOURCE, id: authorId(item.created_by) }, human: !ownWork(item.created_by, agentId), at,
    text: `${item.identifier ? `${item.identifier} ` : ''}${item.title}${description ? `\n\n${description}` : ''}`,
    ...mentions(`${item.title}\n${description}`, names) ? { addressed: 'mention' as const } : {},
    channel: pingcodeChannel(ref, url, undefined, item.identifier ?? ''), ...url ? { url } : {},
    meta: { project, item: item.id, kind: 'workItem', identifier: item.identifier ?? '', title: item.title } }
}
/** The account ID a Trigger attributes a work item or comment to; a malformed user leaves the actor unnamed. */
function authorId(author: PingcodeUser | null | undefined): string {
  return author?.name || author?.id || ''
}
/** Reads the work item a Trigger belongs to from its meta, or undefined for a kind without one. */
export function pingcodeRef(trigger: Trigger): PingcodeRef | undefined {
  if (trigger.source !== SOURCE) return undefined
  const project = trigger.meta.project
  const item = trigger.meta.item
  if (typeof project !== 'string' || typeof item !== 'string' || !item) return undefined
  return { project, item }
}
/** The identifier (`SCR-12`) a Trigger's work item was reported with, when the Source knew it. */
export const pingcodeIdentifier = (trigger: Trigger): string => typeof trigger.meta.identifier === 'string' ? trigger.meta.identifier : ''
