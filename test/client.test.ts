import { afterEach, describe, expect, it, vi } from 'vitest'

import { hatsApi, statusText } from '../src/client/api.js'

afterEach(() => vi.unstubAllGlobals())

describe('the client calls', () => {
  it('reads Payload’s error shape, the plugin’s own and a code request', async () => {
    const answers = [
      new Response(JSON.stringify({ errors: [{ message: 'That account isn’t linked to this one.' }] }), { status: 403 }),
      new Response(JSON.stringify({ ok: false, needsCode: true, message: 'Enter a code.' }), { status: 401 }),
    ]
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => answers.shift()!)
    vi.stubGlobal('fetch', fetch)
    const api = hatsApi('/api')
    expect(await api.switchTo({ account: 'b', hat: 'member' })).toMatchObject({ ok: false, status: 403, message: 'That account isn’t linked to this one.' })
    expect(await api.switchTo({ hat: 'admin' })).toMatchObject({ ok: false, needsCode: true })
    expect(fetch.mock.calls[0]![0]).toBe('/api/hats/switch')
    expect(fetch.mock.calls[0]![1]!.credentials).toBe('include')
  })

  it('says so plainly when the site can’t be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    expect((await hatsApi().link('x@example.invalid')).message).toMatch(/connection/)
  })

  it('words each status for the account page', () => {
    expect(statusText('approved', true)).toBe('Linked')
    expect(statusText('requested', true)).toMatch(/you to confirm/)
    expect(statusText('requested', false)).toMatch(/its email/)
    expect(statusText('confirmed', false)).toMatch(/administrator/)
  })
})

describe('the site’s own words', () => {
  it('replaces a server message by its reason, and keeps the English for any it doesn’t cover', async () => {
    const answers = [
      new Response(JSON.stringify({ errors: [{ message: 'That code didn’t work. Try a new one.', data: { reason: 'wrongCode' } }] }), { status: 403 }),
      new Response(JSON.stringify({ errors: [{ message: 'That account isn’t linked to this one.', data: { reason: 'notLinked' } }] }), { status: 403 }),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => answers.shift()!))
    const api = hatsApi('/api', { offline: 'x', failed: 'y', reasons: { wrongCode: 'Dieser Code hat nicht funktioniert.' } })
    expect(await api.switchTo({ hat: 'admin', code: '1' })).toMatchObject({ reason: 'wrongCode', message: 'Dieser Code hat nicht funktioniert.' })
    expect(await api.switchTo({ account: 'b', hat: 'member' })).toMatchObject({ reason: 'notLinked', message: 'That account isn’t linked to this one.' })
  })
})
