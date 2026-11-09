// @vitest-environment jsdom
// The QR login section of a Source settings card.
import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { at, click, field, find, mount, settle, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const SOURCE = 'github'
const SVG = '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
const card = () => document.getElementById(`dt-source-${SOURCE}`)!
/** Source cards start folded, and the login section lives in the card body. */
const openCard = async () => { await click(card().querySelector<HTMLButtonElement>('.dt-card-toggle')!) }
/** Offers the login only on the GitHub card, so other cards never render a section of their own. */
const offersLogin = () => { server.logins = { [SOURCE]: { label: { zh: zh.loginStart, en: 'Log in by scanning' },
  hint: { zh: '先打开微信扫一扫', en: 'Open WeChat and scan first' } } } }
const atSources = () => at({ page: 'settings', query: { group: 'source' } })

it('shows the login hint and starts the login from the Source card', async () => {
  offersLogin()
  server.loginAnswer = () => ({ status: 'wait', svg: SVG })
  atSources()
  await mount()
  await openCard()
  expect(card().textContent).toContain('先打开微信扫一扫')
  await click(find(zh.loginStart, '.dt-btn'))
  expect(server.requests.find(request => request.path === `sources/${SOURCE}/login` && request.method === 'POST'))
    .toMatchObject({ body: {} })
  // The code is the login's own SVG, rendered in a container of its own.
  expect(card().querySelector('[data-login-code] svg')?.outerHTML).toContain('<svg')
  expect(card().textContent).toContain(zh.loginWaiting)
  // The hint belongs to the idle state; an attempt shows its status instead.
  expect(card().textContent).not.toContain('先打开微信扫一扫')
})

it('polls the login while the phone confirms, then rereads the settings once and stops', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  offersLogin()
  let polls = 0
  server.loginAnswer = ({ call }) => call === 'wait'
    ? ++polls === 1 ? { status: 'scaned', svg: SVG } : { status: 'confirmed', restarting: false }
    : { status: 'wait', svg: SVG }
  atSources()
  await mount()
  await openCard()
  const reads = () => server.requests.filter(request => request.path === 'settings').length
  const before = reads()
  await click(find(zh.loginStart, '.dt-btn'))
  expect(card().textContent).toContain(zh.loginWaiting)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) }); await settle()
  expect(card().textContent).toContain(zh.loginScan)
  expect(reads()).toBe(before)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) }); await settle()
  // Confirmed rereads the settings (the saved account appears) and ends the poll.
  expect(card().textContent).toContain(zh.loginConfirmed)
  expect(reads()).toBeGreaterThan(before)
  const pollsNow = server.requests.filter(request => request.path === `sources/${SOURCE}/login` && request.method === 'GET').length
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) }); await settle()
  expect(server.requests.filter(request => request.path === `sources/${SOURCE}/login` && request.method === 'GET')).toHaveLength(pollsNow)
})

it('asks for the code the phone shows and keeps the confirmed line after submitting it', async () => {
  offersLogin()
  server.loginAnswer = ({ call }) => call === 'verify' ? { status: 'confirmed', restarting: false }
    : { status: 'need_verifycode', svg: SVG }
  atSources()
  await mount()
  await openCard()
  await click(find(zh.loginStart, '.dt-btn'))
  expect(card().querySelector('[data-login-code] svg')).not.toBeNull()
  await type(field<HTMLInputElement>(zh.loginCode), '123456')
  await click(find(zh.loginCodeSubmit, '.dt-btn'))
  expect(server.requests.find(request => request.path === `sources/${SOURCE}/login` && request.method === 'POST'
    && (request.body as { code?: string } | undefined)?.code === '123456')).toBeDefined()
  expect(card().textContent).toContain(zh.loginConfirmed)
  // The attempt is over: the code input is gone and the code is no longer shown.
  expect(card().querySelector('input[aria-label="' + zh.loginCode + '"]')).toBeNull()
  expect(card().querySelector('[data-login-code]')).toBeNull()
})
