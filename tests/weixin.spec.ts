import { afterEach, describe, expect, it, vi } from 'vitest'
import { key, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { getUpdates, ilinkHeaders, isStaleToken, sendMessage, WeixinApiError, WEIXIN_API_BASE, WEIXIN_CHANNEL_VERSION }
  from '../src/sources/weixin-api.ts'
import { activeWeixin, sendWeixin, setActiveWeixin, weixinLink } from '../src/sources/weixin-channel.ts'
import { forgetWeixin, rememberToken, rememberWeixin, weixinThreadContext, weixinToken, weixinTranscript } from '../src/sources/weixin-read.ts'
import { WeixinMessageSchema, weixinMessageId, weixinPeer, weixinQuote, weixinText, weixinThreadId, weixinTime, weixinTrigger, weixinTriggerId }
  from '../src/sources/weixin-trigger.ts'

/** A message as the iLink `getupdates` response carries it. */
const message = (over: Record<string, unknown> = {}) => ({ message_id: 'm-1', from_user_id: 'user-1', to_user_id: 'bot-1', message_type: 1,
  message_state: 2, create_time_ms: 1_767_225_600_000, item_list: [{ type: 1, text_item: { text: 'Please fix the build' } }],
  context_token: 'ctx-1', ...over })
const endpoint = { token: 'bot-token' }
const triggerOf = (over: Record<string, unknown> = {}) => weixinTrigger(message(over))!
const parsed = (over: Record<string, unknown> = {}) => WeixinMessageSchema.parse(message(over))
const outbound = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({ id: 'out-1', kind: 'reply', text: 'Done.',
  channel: { source: 'weixin', thread: 'weixin:user-1', address: { peer: 'user-1', messageId: 'm-1', contextToken: 'addr-token' } }, ...over })
/** Replaces `fetch` with a JSON response and returns the stub, so tests can read what was posted. */
const stubFetch = (body: unknown, status = 200) => {
  const mock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', mock)
  return mock
}
/** The URL and parsed JSON body of one stubbed call. */
const posted = (mock: ReturnType<typeof stubFetch>, index = 0) => {
  const call = mock.mock.calls[index]!
  return { url: call[0], headers: call[1].headers as Record<string, string>, body: JSON.parse(String(call[1].body)) as Record<string, unknown> }
}
/** A fetch that never answers and rejects when the request is aborted, like a long poll with no messages. */
const stubLongPoll = () => vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
})))
afterEach(() => {
  setActiveWeixin(undefined)
  forgetWeixin()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('weixin trigger', () => {
  it('turns a direct message into a Trigger with a deterministic id, thread, actor and context token', () => {
    const trigger = triggerOf()
    expect(trigger).toMatchObject({ id: weixinTriggerId('m-1'), source: 'weixin', addressed: 'direct', human: true,
      actor: { source: 'weixin', id: 'user-1' }, threads: [{ source: 'weixin', id: 'weixin:user-1' }],
      channel: { source: 'weixin', thread: 'weixin:user-1', address: { peer: 'user-1', messageId: 'm-1', contextToken: 'ctx-1' } },
      meta: { peer: 'user-1', messageId: 'm-1', direct: true, contextToken: 'ctx-1' } })
    expect(trigger.id).toBe(key('weixin', 'm-1'))
    expect(trigger.channel!.address).not.toHaveProperty('direct')
  })
  it('parses the time from create_time_ms and keeps the group id for the panel', () => {
    expect(triggerOf().at).toBe('2026-01-01T00:00:00.000Z')
    expect(triggerOf({ group_id: 'group-1' }).meta).toMatchObject({ groupId: 'group-1' })
    expect(triggerOf({ message_id: 'm-2', message_state: undefined }).meta).not.toHaveProperty('groupId')
  })
  it('drops the bot\'s own message, a GENERATING update, and messages without sender or id', () => {
    expect(weixinTrigger(message({ message_type: 2 }))).toBeUndefined()
    expect(weixinTrigger(message({ message_state: 1 }))).toBeUndefined()
    expect(weixinTrigger(message({ from_user_id: '' }))).toBeUndefined()
    expect(weixinTrigger(message({ message_id: undefined }))).toBeUndefined()
    expect(weixinTrigger('not a message')).toBeUndefined()
    expect(weixinTrigger({ message_id: 'm-3' })).toBeUndefined()
    expect(weixinTrigger(null)).toBeUndefined()
  })
  it('falls back to the item\'s msg_id when the envelope has none', () => {
    const parsed = WeixinMessageSchema.parse({ from_user_id: 'user-1', item_list: [{ type: 1, msg_id: 'item-1', text_item: { text: 'hi' } }] })
    expect(weixinMessageId(parsed)).toBe('item-1')
    expect(weixinTrigger(parsed)!.id).toBe(weixinTriggerId('item-1'))
  })
  it('shows media as markers and a voice message as its transcription', () => {
    const item = (type: number, extra: Record<string, unknown> = {}) => parsed({ item_list: [{ type, ...extra }] })
    expect(weixinText(item(2))).toBe('[图片]')
    expect(weixinText(item(3))).toBe('[语音]')
    expect(weixinText(item(4, { file_item: { file_name: 'a.pdf' } }))).toBe('[文件]')
    expect(weixinText(item(5))).toBe('[视频]')
    expect(weixinText(item(11))).toBe('[消息]')
    expect(weixinText(item(3, { voice_item: { text: 'spoken' } }))).toBe('spoken')
    expect(weixinText(parsed({ item_list: [] }))).toBe('[消息]')
  })
  it('reads the quoted message, either its text or a marker for its media', () => {
    expect(weixinQuote(WeixinMessageSchema.parse(message()))).toBeUndefined()
    const quoted = (item: Record<string, unknown>) => WeixinMessageSchema.parse(message({ item_list: [{ type: 1, ref_msg: { message_item: item } }] }))
    expect(weixinQuote(quoted({ type: 1, text_item: { text: 'the earlier request' } }))).toBe('the earlier request')
    expect(weixinQuote(quoted({ type: 3, voice_item: { text: 'transcribed' } }))).toBe('transcribed')
    expect(weixinQuote(quoted({ type: 2 }))).toBe('[图片]')
    const trigger = weixinTrigger(message({ item_list: [{ type: 1, ref_msg: { message_item: { type: 1, text_item: { text: 'earlier' } } } }] }))!
    expect(trigger.meta.quote).toBe('earlier')
  })
  it('falls back to now for a message without a timestamp', () => {
    const now = weixinTime(WeixinMessageSchema.parse({ from_user_id: 'user-1' }))
    expect(Math.abs(Date.parse(now) - Date.now())).toBeLessThan(5_000)
  })
  it('exposes the peer of a Trigger from this Source only', () => {
    const trigger = triggerOf()
    expect(weixinPeer(trigger)).toBe('user-1')
    expect(weixinPeer({ ...trigger, source: 'wecom' } as Trigger)).toBeUndefined()
    expect(weixinThreadId('user-1')).toBe('weixin:user-1')
  })
})

describe('ilink headers', () => {
  it('authenticates the bot, announces the client version, and carries a base64 random uint32', () => {
    const headers = ilinkHeaders('bot-token')
    expect(headers).toMatchObject({ 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', Authorization: 'Bearer bot-token',
      'iLink-App-Id': 'bot' })
    expect(headers['iLink-App-ClientVersion']).toBe(String(0x0002040a))
    const uin = Buffer.from(headers['X-WECHAT-UIN']!, 'base64').toString('utf8')
    expect(uin).toMatch(/^\d+$/)
    expect(Number(uin)).toBeLessThanOrEqual(0xffff_ffff)
    expect(WEIXIN_CHANNEL_VERSION).toBe('2.4.10')
  })
  it('leaves out Authorization when no token is set', () => {
    expect(ilinkHeaders()).not.toHaveProperty('Authorization')
    expect(ilinkHeaders()).toMatchObject({ 'iLink-App-Id': 'bot' })
  })
})

describe('getUpdates', () => {
  it('sends the previous cursor and base_info, and returns the messages with the new cursor', async () => {
    const fetchMock = stubFetch({ ret: 0, msgs: [message()], get_updates_buf: 'cursor-2', longpolling_timeout_ms: 12_000 })
    const result = await getUpdates(endpoint, { buf: 'cursor-1', timeoutMs: 35_000, signal: new AbortController().signal })
    expect(result).toEqual({ messages: [message()], buf: 'cursor-2', timeoutMs: 12_000 })
    const call = posted(fetchMock)
    expect(call.url).toBe(`${WEIXIN_API_BASE}/ilink/bot/getupdates`)
    expect(call.body).toEqual({ get_updates_buf: 'cursor-1', base_info: { channel_version: '2.4.10', bot_agent: 'dsh-superagent' } })
    expect(call.headers.Authorization).toBe('Bearer bot-token')
  })
  it('keeps the old cursor and timeout when the response omits them', async () => {
    stubFetch({ ret: 0, msgs: [] })
    await expect(getUpdates(endpoint, { buf: 'cursor-1', timeoutMs: 35_000, signal: new AbortController().signal }))
      .resolves.toEqual({ messages: [], buf: 'cursor-1', timeoutMs: 35_000 })
    stubFetch({ ret: 0, get_updates_buf: '' })
    await expect(getUpdates(endpoint, { buf: 'cursor-1', timeoutMs: 35_000, signal: new AbortController().signal }))
      .resolves.toMatchObject({ buf: 'cursor-1' })
  })
  it('clamps the reported long-poll timeout into a usable range', async () => {
    stubFetch({ ret: 0, get_updates_buf: 'c', longpolling_timeout_ms: 10 })
    await expect(getUpdates(endpoint, { buf: '', timeoutMs: 35_000, signal: new AbortController().signal })).resolves.toMatchObject({ timeoutMs: 1_000 })
    stubFetch({ ret: 0, get_updates_buf: 'c', longpolling_timeout_ms: 999_999 })
    await expect(getUpdates(endpoint, { buf: '', timeoutMs: 35_000, signal: new AbortController().signal })).resolves.toMatchObject({ timeoutMs: 120_000 })
  })
  it('throws a stale-token error for ret or errcode -14', async () => {
    stubFetch({ ret: -14, errmsg: 'stale token' })
    const retStale: unknown = await getUpdates(endpoint, { buf: '', timeoutMs: 35_000, signal: new AbortController().signal }).catch(error => error)
    expect(retStale).toBeInstanceOf(WeixinApiError)
    expect(isStaleToken(retStale)).toBe(true)
    stubFetch({ ret: 0, errcode: -14 })
    const codeStale: unknown = await getUpdates(endpoint, { buf: '', timeoutMs: 35_000, signal: new AbortController().signal }).catch(error => error)
    expect(codeStale).toMatchObject({ ret: 0, errcode: -14 })
    expect(isStaleToken(codeStale)).toBe(true)
  })
  it('rejects other failures with the codes the response carried', async () => {
    stubFetch({ ret: 7, errcode: 8, errmsg: 'nope' })
    const error: unknown = await getUpdates(endpoint, { buf: '', timeoutMs: 35_000, signal: new AbortController().signal }).catch(error => error)
    expect(error).toMatchObject({ message: 'nope', ret: 7, errcode: 8 })
    expect(isStaleToken(error)).toBe(false)
    stubFetch({}, 500)
    await expect(getUpdates(endpoint, { buf: '', timeoutMs: 35_000, signal: new AbortController().signal })).rejects.toBeInstanceOf(WeixinApiError)
  })
  it('resolves an empty round when only the client-side long-poll budget expired', async () => {
    const timed = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timed.signal)
    stubLongPoll()
    const pending = getUpdates(endpoint, { buf: 'cursor-1', timeoutMs: 35_000, signal: new AbortController().signal })
    timed.abort()
    await expect(pending).resolves.toEqual({ messages: [], buf: 'cursor-1', timeoutMs: 35_000 })
    expect(AbortSignal.timeout).toHaveBeenCalledWith(40_000)
  })
  it('throws when the caller aborts, so the Source loop can end', async () => {
    stubLongPoll()
    const caller = new AbortController()
    const pending = getUpdates(endpoint, { buf: '', timeoutMs: 35_000, signal: caller.signal })
    caller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })
})

describe('sendMessage', () => {
  it('posts one FINISHED text message and echoes the context token', async () => {
    const fetchMock = stubFetch({ ret: 0, errmsg: '' })
    await sendMessage(endpoint, { peer: 'user-1', text: '你好', contextToken: 'ctx-1' })
    const call = posted(fetchMock)
    expect(call.url).toBe(`${WEIXIN_API_BASE}/ilink/bot/sendmessage`)
    expect(call.body).toMatchObject({ msg: { from_user_id: '', to_user_id: 'user-1', message_type: 2, message_state: 2, context_token: 'ctx-1',
      item_list: [{ type: 1, text_item: { text: '你好' } }] }, base_info: { channel_version: '2.4.10', bot_agent: 'dsh-superagent' } })
    expect((call.body.msg as { client_id: string }).client_id).toMatch(/^dsh-\d+-/)
    expect(call.headers.Authorization).toBe('Bearer bot-token')
  })
  it('omits the context token when the inbound message had none, and honors a private base URL and bot agent', async () => {
    const fetchMock = stubFetch({ ret: 0 })
    await sendMessage({ token: 'tok', baseUrl: 'https://ilink.example/c2c/', botAgent: 'my-agent' }, { peer: 'user-2', text: 'ok' })
    const call = posted(fetchMock)
    expect(call.url).toBe('https://ilink.example/c2c/ilink/bot/sendmessage')
    expect(call.body).toMatchObject({ msg: { to_user_id: 'user-2' }, base_info: { bot_agent: 'my-agent' } })
    expect(call.body.msg as Record<string, unknown>).not.toHaveProperty('context_token')
  })
  it('throws the server\'s ret, and non-2xx responses', async () => {
    stubFetch({ ret: -1, errmsg: 'refused' })
    await expect(sendMessage(endpoint, { peer: 'user-1', text: 'hi' })).rejects.toMatchObject({ message: 'refused', ret: -1 })
    stubFetch({}, 502)
    await expect(sendMessage(endpoint, { peer: 'user-1', text: 'hi' })).rejects.toBeInstanceOf(WeixinApiError)
  })
})

describe('weixin channel', () => {
  it('sends the reply text to the peer with the address\'s context token', async () => {
    setActiveWeixin(endpoint)
    expect(activeWeixin()).toBe(endpoint)
    const fetchMock = stubFetch({ ret: 0 })
    await expect(sendWeixin({} as never, outbound())).resolves.toBe('sent')
    expect(posted(fetchMock).body).toMatchObject({ msg: { to_user_id: 'user-1', context_token: 'addr-token',
      item_list: [{ type: 1, text_item: { text: 'Done.' } }] } })
  })
  it('prefers the remembered context token over the address one', async () => {
    setActiveWeixin(endpoint)
    rememberToken('user-1', 'stored-token')
    const fetchMock = stubFetch({ ret: 0 })
    await sendWeixin({} as never, outbound())
    expect(posted(fetchMock).body).toMatchObject({ msg: { context_token: 'stored-token' } })
  })
  it('refuses to reply while no bot is connected, so the Outbox retries later', async () => {
    await expect(sendWeixin({} as never, outbound())).rejects.toThrow('not connected')
  })
  it('drops text that emptied out, because it can never be delivered', async () => {
    setActiveWeixin(endpoint)
    const fetchMock = stubFetch({ ret: 0 })
    await expect(sendWeixin({} as never, outbound({ text: '   ' }))).resolves.toBe('gone')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('requires a reply target and lets a transport failure escape for a retry', async () => {
    setActiveWeixin(endpoint)
    await expect(sendWeixin({} as never, outbound({ channel: { source: 'weixin', thread: 'weixin:user-1', address: {} } })))
      .rejects.toThrow('Missing WeChat reply target')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(sendWeixin({} as never, outbound())).rejects.toThrow('network down')
  })
  it('has no public link that opens a conversation', () => {
    expect(weixinLink({ peer: 'user-1' })).toEqual({ url: '', label: { zh: '微信', en: 'WeChat' } })
  })
})

describe('weixin thread context', () => {
  const read = (trigger: Trigger, part: 'thread' | 'root' | 'parent') =>
    weixinThreadContext.read({} as never, trigger, part, undefined, { token: 'bot-token' })
  it('reads the remembered window of the peer, oldest first and without duplicates', async () => {
    rememberWeixin('user-1', { id: 'm-1', from: 'user-1', at: '2026-01-01T00:00:00.000Z', text: 'first' })
    rememberWeixin('user-1', { id: 'm-2', from: 'user-1', at: '2026-01-01T00:01:00.000Z', text: 'second' })
    rememberWeixin('user-1', { id: 'm-1', from: 'user-1', at: '2026-01-01T00:00:00.000Z', text: 'first' })
    expect(weixinTranscript('user-1').map(item => item.id)).toEqual(['m-1', 'm-2'])
    const trigger = triggerOf({ message_id: 'm-2' })
    expect(weixinThreadContext.messageId(trigger)).toBe('m-2')
    expect(await read(trigger, 'thread')).toMatchObject({ status: 'available', messages: [{ id: 'm-1', text: 'first' }, { id: 'm-2', text: 'second' }] })
    expect(await read(trigger, 'root')).toMatchObject({ status: 'available', messages: [{ id: 'm-1' }] })
  })
  it('keeps only the recent window of a peer', () => {
    for (let index = 0; index < 55; index++) {
      rememberWeixin('user-1', { id: `m-${index}`, from: 'user-1', at: '2026-01-01T00:00:00.000Z', text: `message ${index}` })
    }
    expect(weixinTranscript('user-1')).toHaveLength(50)
    expect(weixinTranscript('user-1')[0]!.id).toBe('m-5')
  })
  it('says there is no root or parent instead of inventing one', async () => {
    const trigger = triggerOf()
    expect(await read(trigger, 'root')).toMatchObject({ status: 'no_root', messages: [] })
    expect(await read(trigger, 'parent')).toMatchObject({ status: 'no_parent', messages: [] })
  })
  it('reads the quoted message as the parent', async () => {
    const trigger = triggerOf({ item_list: [{ type: 1, ref_msg: { message_item: { type: 1, text_item: { text: 'earlier' } } } }] })
    expect(await read(trigger, 'parent')).toMatchObject({ status: 'available', messages: [{ text: 'earlier', id: 'm-1:quote' }] })
  })
  it('forgets the remembered windows and tokens on reset', () => {
    rememberWeixin('user-1', { id: 'm-1', from: 'user-1', at: '2026-01-01T00:00:00.000Z', text: 'first' })
    rememberToken('user-1', 'token-1')
    expect(weixinToken('user-1')).toBe('token-1')
    forgetWeixin()
    expect(weixinTranscript('user-1')).toEqual([])
    expect(weixinToken('user-1')).toBeUndefined()
  })
})
