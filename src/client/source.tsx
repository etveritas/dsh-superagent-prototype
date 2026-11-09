/** Source status view (health, filtered Triggers, dropped replies) and Source settings cards. */
import { useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { FieldSpec } from '../sources/kind.ts'
import { usePoll, type DroppedReply, type SourceStatusRow, type SourceView } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, InfoTip, Input, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import type { DshSuperagentKey } from './locales.ts'
import { sourceMark } from './marks.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { ConfigHistory, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { actorName, healthText, localized, readableMarkers, reasonLabel, valueLabel, when } from './text.ts'
import { CheckSetupButton, Hint, LabelValue, LoadState, SetupMessage, StatusHead, When } from './widgets.tsx'

function SourceCard({ source, focus }: { source: SourceView; focus?: boolean }) {
  const { t, call } = usePanel()
  const { running } = usePanelData()
  const { reload } = useSettings()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [open, setOpen] = useState(false)
  const bodyId = `dt-source-${source.id}-body`
  // A link that points at this card opens it, so the setting it needs is on screen.
  useEffect(() => { if (focus) setOpen(true) }, [focus])
  const refreshLabels = async () => { const { added } = await call('POST sources/:id/labels',
    { id: source.id }); await reload(); return added }
  const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision)
  const value = draft.value
  const { problem, value: saved } = source
  const changed = (key: string) => String(value.config[key] ?? '') !== String(saved.config[key] ?? '')
  // Saving a modified setup-sensitive field restarts dsh-superagent, interrupting running Assignments.
  const restarts = draft.dirty && source.restarts.some(changed)
  const description = localized(t, source.description)
  // Hide derived facts for unsaved field edits until the new value is saved.
  const field = (spec: FieldSpec) => <SourceField key={spec.key} field={spec} value={value.config[spec.key]} saved={saved.config[spec.key]}
    labels={source.labels}
    refreshLabels={refreshLabels} fact={spec.type === 'fact' || !changed(spec.key) ? source.facts[spec.key] : undefined}
    onChange={next => draft.edit({ ...value, config: { ...value.config, [spec.key]: next } })} />
  const advanced = source.fields.filter(spec => spec.advanced)
  return <form id={`dt-source-${source.id}`} className="dt-card" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-card-head">
        <div className="dt-row-main">
          <div className="dt-row-title">
            <button type="button" className="dt-card-toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined}
              onClick={() => setOpen(!open)}>
              <span className="dt-card-toggle-icon"><Icon name={open ? 'chevron-down' : 'chevron-right'} /></span>
              <span className="dt-card-title">{localized(t, source.title)}</span>
            </button>
            {description && <InfoTip text={description} />}
            {!source.installed && <Tag tone="warning">{t('sourceNotInstalled')}</Tag>}
          </div>
        </div>
        {source.installed && <Switch checked={value.enabled} onChange={enabled => draft.edit({ ...value, enabled })}
          label={t('sourceEnable', { name: localized(t, source.title) })} />}
      </div>
      {problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={problem} lead /></p><CheckSetupButton />
      </div>}
      {open && <div id={bodyId} className="dt-card-body">
        {!source.installed && <Hint>{t('sourceNotInstalledHint')}</Hint>}
        {source.installed && source.fields.filter(spec => !spec.advanced).map(field)}
        {source.installed && advanced.length > 0 && <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')}
          open={advancedOpen} onToggle={() => setAdvancedOpen(!advancedOpen)}>
          <div className="dt-disclosure-body">{advanced.map(field)}</div>
        </DisclosureRow>}
        {source.installed && source.login && <SourceLogin source={source.id} login={source.login} />}
      </div>}
    </Fields>
    <SaveBar {...draft} status={restarts && running > 0 ? t('restartInterrupts', { count: running }) : undefined}
      onDiscard={draft.discard} />
  </form>
}

const LOGIN_POLL_MS = 2000
type LoginPageView = ApiResponse<'GET sources/:id/login'>
/** Statuses that keep polling; every other status ends the attempt until the operator starts again. */
const LOGIN_ACTIVE = new Set<LoginPageView['status']>(['wait', 'scaned', 'need_verifycode'])
const LOGIN_STATUS: Partial<Record<LoginPageView['status'], DshSuperagentKey>> = { wait: 'loginWaiting', scaned: 'loginScan',
  confirmed: 'loginConfirmed', expired: 'loginExpired', blocked: 'loginBlocked', failed: 'loginFailed' }

/**
 * The QR login section of a Source card: starts an attempt, polls it while the operator scans, asks for the code the
 * phone shows, and rereads the settings once the confirmed credentials are saved (which may restart dsh-superagent).
 */
function SourceLogin({ source, login }: { source: string; login: NonNullable<SourceView['login']> }) {
  const { t, call } = usePanel()
  const { reload } = useSettings()
  const [view, setView] = useState<LoginPageView>()
  const [code, setCode] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const mounted = useRef(true)
  // The poll after a response runs from a timer, so it reads the latest render's `call` through a ref.
  const poll = useRef<() => void>(() => {})
  const stop = () => { clearTimeout(timer.current); timer.current = undefined }
  const apply = (next: LoginPageView) => {
    if (!mounted.current) return
    setView(next)
    // A confirmed answer saved the account, so reread the settings once; polling ends there.
    if (next.status === 'confirmed') void reload()
    stop()
    if (LOGIN_ACTIVE.has(next.status)) timer.current = setTimeout(() => poll.current(), LOGIN_POLL_MS)
  }
  poll.current = () => { void (async () => {
    try { apply(await call('GET sources/:id/login', { id: source })) }
    // An unreachable host ends the attempt; the operator starts again once the panel answers.
    catch { stop() }
  })() }
  // Leaving the card must not leave a poll behind, and a response that lands afterwards must not set state.
  useEffect(() => () => { mounted.current = false; clearTimeout(timer.current) }, [])
  const request = useAction(async (body: { code?: string }) => {
    stop()
    apply(await call('POST sources/:id/login', { id: source, body }))
  })
  const terminal = view?.status === 'expired' || view?.status === 'blocked' || view?.status === 'failed'
  const status = view && LOGIN_STATUS[view.status]
  const submit = () => { if (code.trim()) void request.run({ code: code.trim() }) }
  return <div className="dt-field">
    <div className="dt-actions">
      <Button variant="outline" size="sm" disabled={request.busy} aria-busy={request.busy}
        onClick={() => { void request.run({}) }}>{request.busy ? t('loginStarting') : terminal ? t('loginAgain')
          : localized(t, login.label)}</Button>
    </div>
    {status && <p className="dt-hint">{t(status)}</p>}
    {/* The login's own sentence is the backend's wording, which the panel cannot localize. */}
    {view?.message && <p className="dt-detail">{view.message}</p>}
    {/* Only the fixed generator's markup is injected here; no markup is built from request data. */}
    {view?.svg && <div data-login-code style={{ width: 200 }} dangerouslySetInnerHTML={{ __html: view.svg }} />}
    {view?.status === 'need_verifycode' && <div className="dt-actions">
      <Input aria-label={t('loginCode')} placeholder={t('loginCode')} value={code} inputMode="numeric"
        autoComplete="one-time-code" onChange={event => setCode(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit() } }} />
      <Button variant="outline" size="sm" disabled={request.busy || !code.trim()} onClick={submit}>{t('loginCodeSubmit')}</Button>
    </div>}
    {!view && login.hint && <Hint>{localized(t, login.hint)}</Hint>}
  </div>
}

export function SourceSettings({ focus }: { focus?: string }) {
  const { sources } = useSettings().settings
  useEffect(() => { if (focus) document.getElementById(`dt-source-${focus}`)?.scrollIntoView?.({ block: 'start' }) }, [focus])
  return <div className="dt-form">
    {sources.map(source => <SourceCard key={source.id} source={source} focus={source.id === focus} />)}
    <ConfigHistory blocks={['source:']} />
  </div>
}

function DroppedReplies({ items }: { items: DroppedReply[] }) {
  const { t, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  // Link to the message's Ticket, or fall back to its Thread for messages queued before receipts recorded `ticketId`.
  const target = (item: DroppedReply): { route: Route; name: string } | undefined => item.ticket
    ? { route: { page: 'execution', id: item.ticket.id }, name: item.ticket.title }
    : item.thread ? { route: { page: 'trigger', id: item.thread }, name: t('term.thread') } : undefined
  return <DisclosureRow icon={<Icon name="dismiss" />} title={<>{t('sourceDroppedTitle')} <span
    className="dt-count">{items.length}</span></>} open={open}
    onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('sourceDroppedHint')}</Hint>
      <ul className="dt-list">{items.map(item => {
        const link = target(item)
        return <li key={item.id} className="dt-row"><Dot state="idle" /><div className="dt-row-main">
          <div className="dt-row-title dt-line">{readableMarkers(t, item.preview) || t('empty')}</div>
          <div className="dt-row-meta">
            <Tag tone="neutral">{reasonLabel(t, item.dropped.reason)}</Tag><When at={item.dropped.at} />
            {link && <button type="button" className="dt-textlink" onClick={() => navigate(link.route)}>{link.name}</button>}
          </div>
        </div></li>
      })}</ul>
    </div>
  </DisclosureRow>
}
function SourceRow({ source }: { source: SourceStatusRow }) {
  const { t, navigate } = usePanel()
  const { setup } = usePanelData()
  const [filteredOpen, setFilteredOpen] = useState(false)
  const { problem, dropped } = source
  const { dot, label: state } = sourceMark(t, source.state)
  const { received, filtered, lastAt } = source.stats
  // Omit healthy parts and suppress per-part notes when a setup problem already explains why the Source is stopped.
  const notes = source.enabled && !problem && !setup?.problem ? source.health.filter(item => item.state === 'error'
    || item.state === 'paused') : []
  return <li className="dt-row">
    <Dot state={dot} label={state} />
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-row-name">{localized(t, source.title)}</span><span className="dt-status-text"
        data-state={dot}>{state}</span></div>
      <div className="dt-row-meta">
        {received > 0 && <LabelValue label={t('sourceReceivedLabel')}
          value={received} />}{filtered > 0 && <LabelValue label={t('sourceFilteredLabel')} value={filtered} />}
        {lastAt && <LabelValue label={t('sourceLatestLabel')} value={when(lastAt, t('lang'))} />}
      </div>
      {problem && <p className="dt-error">
        <SetupMessage problem={problem} lead /> <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute('source', { source: source.id }))}>
          {t('sourceOpenSettings')}
        </button>
      </p>}
      {notes.map(item => <p key={item.name} className={item.state === 'error' ? 'dt-error dt-clamp' : 'dt-hint dt-clamp'}>
        {valueLabel(t, 'health', item.name)}{t('labelSeparator')}<span className={item.code ? undefined : 'dt-mono'}>{healthText(t,
          item)}</span>
      </p>)}
      {source.filtered.length > 0 && <DisclosureRow icon={<Icon name="filter" />} title={t('sourceFilteredTitle')} open={filteredOpen}
        onToggle={() => setFilteredOpen(!filteredOpen)}>
        <div className="dt-disclosure-body">
          <ul className="dt-list">{source.filtered.map(item => <li key={item.id} className="dt-row"><Dot state="idle" /><div
            className="dt-row-main">
            <div className="dt-row-title">{actorName(t, item.actor)}{t('labelSeparator')}{readableMarkers(t, item.preview)
              || t('empty')}</div>
            <div className="dt-row-meta"><Tag tone="neutral">{reasonLabel(t, item.reason)}</Tag><When at={item.at} /></div>
          </div></li>)}</ul>
        </div>
      </DisclosureRow>}
      {dropped.length > 0 && <DroppedReplies items={dropped} />}
    </div>
  </li>
}

export function SourceStatus() {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error } = usePoll(() => call('GET sources'), [])
  // Global deployment setup problems halt all Sources and show at the top; Source-specific setup problems show on that Source's row.
  const elsewhere = setup?.problem?.place === 'deployment' ? setup.problem : undefined
  return <div className="dt-form">
    <StatusHead hint={t('sourceStatusIntro')} settings="source" />
    {elsewhere && <p className="dt-error">
      <SetupMessage problem={elsewhere} lead /> <button type="button" className="dt-textlink"
        onClick={() => navigate(setupPage(elsewhere.place))}>{t('setupFixLink')}</button>
    </p>}
    <LoadState error={error} loading={!data} />
    {data && <ul className="dt-list">{data.map(source => <SourceRow key={source.id} source={source} />)}</ul>}
  </div>
}
