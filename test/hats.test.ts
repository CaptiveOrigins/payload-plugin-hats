import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, createLocalReq, createPayloadRequest, getPayload, type SanitizedConfig, type Endpoint, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyHat, cleanupSessions, hats, hatsStateOf, MEMBERS, SESSIONS, type Hat, type HatsEvent, type HatsUser } from '../src/index.js'
import type { ResolvedHatsOptions } from '../src/types.js'

/**
 * A made-up site: a role ladder member < author < curator < admin (curator and admin sensitive), notes only admins
 * may read, a "maintainer" flag for approving links, and a fake second factor (the code is stored on the account).
 */
const LADDER = ['member', 'author', 'curator', 'admin'] as const
type Level = (typeof LADDER)[number]
type U = HatsUser & { level: Level; maintainer?: boolean; code?: string | null; disabled?: boolean }
const hatsOf = (u: HatsUser): Hat[] => {
  if ((u as U).disabled) return [] // as a site does for a disabled account
  const level = LADDER.indexOf((u as U).level ?? 'member')
  return LADDER.slice(0, level + 1).map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1), sensitive: id === 'curator' || id === 'admin' }))
}
const wear = (u: HatsUser, hat: string) => ({ ...u, level: hat as Level, maintainer: hat === 'admin' ? (u as U).maintainer : false }) as HatsUser

let payload: Payload
let config: SanitizedConfig
let mongo: MongoMemoryReplSet
const PW = 'correct-horse-battery'
const mail: { to: string; text: string }[] = []
const events: HatsEvent[] = []
let masquerading = false
/** Stand-in answers for the site's own checks, so a test can make them say something other than true or false. */
const answers: { approve?: () => unknown; available?: () => unknown; verify?: () => unknown } = {}
/** Truthy answers that aren't `true`, and a thrown error: every one must be a no. */
const NOT_TRUE: [string, () => unknown][] = [
  ['1', () => 1],
  ["'yes'", () => 'yes'],
  ['{ valid: false }', () => ({ valid: false })],
  ['a resolved object', async () => ({})],
  ['a thrown error', () => {
    throw new Error('check store down')
  }],
  ['a rejected promise', async () => {
    throw new Error('check store down')
  }],
]

const tokenFrom = (text: string) => /token=([\w-]+)/.exec(text)?.[1] ?? ''
const endpoint = (path: string, method: string) => (payload.config.endpoints as Endpoint[]).find((e) => e.path === path && e.method === method)!
/** The signed-in user for a token, exactly as REST, GraphQL and the admin see it (Payload's auth strategies). */
const whoIs = async (token: string) => (await payload.auth({ headers: new Headers({ Authorization: `JWT ${token}` }) })).user as U | null

async function call(path: string, token: string | null, body: unknown = {}, method = 'post') {
  const user = token ? await whoIs(token) : null
  const req = (await createLocalReq({ user: (user ?? undefined) as never }, payload)) as PayloadRequest
  if (!user) req.user = null
  ;(req as { headers: Headers }).headers = new Headers({ 'content-type': 'application/json' })
  ;(req as { url: string }).url = `https://site.example/api${path}`
  req.data = body as never
  ;(req as unknown as { json: () => Promise<unknown> }).json = async () => body
  try {
    const res = await endpoint(path, method).handler(req)
    const text = await res.text()
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('payload-token='))
    return { status: res.status, body: text.startsWith('{') ? JSON.parse(text) : text, token: cookie ? cookie.split(';')[0]!.slice('payload-token='.length) : null }
  } catch (error) {
    return { status: (error as { status?: number }).status ?? 500, body: { message: (error as Error).message, data: (error as { data?: unknown }).data } as Record<string, any>, token: null }
  }
}

const login = async (email: string) => (await payload.login({ collection: 'users', data: { email, password: PW } })).token!
const make = (email: string, level: Level, extra: Partial<U> = {}) =>
  payload.create({ collection: 'users', data: { email, password: PW, level, ...extra } as never }) as unknown as Promise<U>
const canReadSecrets = async (user: U | null) => {
  try {
    await payload.find({ collection: 'secrets', user: user as never, overrideAccess: false })
    return true
  } catch {
    return false
  }
}

/** Links accounts the way people do: request, both confirm by email, a maintainer outside the set approves. */
async function link(from: U, to: U, approver: U) {
  mail.length = 0
  const res = await call('/hats/link', await login(from.email!), { email: to.email })
  expect(res.status).toBe(202)
  for (const m of [...mail]) expect((await call('/hats/confirm', null, { token: tokenFrom(m.text) })).status).toBe(200)
  const { docs } = await payload.find({ collection: MEMBERS as never, where: { status: { equals: 'confirmed' } }, depth: 0, overrideAccess: true })
  for (const d of docs) await payload.update({ collection: MEMBERS as never, id: d.id, data: { status: 'approved' } as never, user: approver as never, overrideAccess: false })
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  config = await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('hats'), ensureIndexes: true }),
      collections: [
        {
          slug: 'users',
          auth: true,
          access: { update: () => true },
          fields: [
            { name: 'level', type: 'select', options: [...LADDER], defaultValue: 'member', saveToJWT: true },
            { name: 'maintainer', type: 'checkbox' },
            { name: 'code', type: 'text' },
            { name: 'disabled', type: 'checkbox' },
          ],
        },
        { slug: 'secrets', access: { read: ({ req }) => (req.user as U | null)?.level === 'admin' }, fields: [{ name: 'text', type: 'text' }] },
      ],
      plugins: [
        hats({
          hatsOf,
          wear,
          canApproveLinks: ({ user }) => (answers.approve ? (answers.approve() as boolean) : Boolean((user as U).maintainer)),
          stepUp: {
            available: async (u) => (answers.available ? (answers.available() as boolean) : Boolean((u as U).code)),
            verify: ({ user, code }) => (answers.verify ? (answers.verify() as boolean) : code === (user as U).code),
          },
          blocked: () => (masquerading ? 'Stop masquerading first.' : null),
          limit: ({ email }) => {
            if (email.startsWith('broken-')) throw new Error('limit store down')
            return !email.startsWith('limited-')
          },
          sendEmail: async ({ to, text }) => void mail.push({ to, text }),
          onEvent: (e) => void events.push(e),
        }),
      ],
    })
  payload = await getPayload({ config })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

let n = 0
const email = (name: string) => `${name}-${++n}@example.invalid`
beforeEach(() => {
  masquerading = false
  delete answers.approve
  delete answers.available
  delete answers.verify
  mail.length = 0
})

describe('hats on one account', () => {
  it('starts in every role, narrows to a hat, and the hat holds for every reader of req.user', async () => {
    const admin = await make(email('admin'), 'admin', { code: '123456' })
    const token = await login(admin.email!)
    expect((await whoIs(token))!.level).toBe('admin')
    expect(await canReadSecrets(await whoIs(token))).toBe(true)

    const menu = await call('/hats', token, undefined, 'get')
    expect(menu.body.hats.map((h: Hat) => h.id)).toEqual(['member', 'author', 'curator', 'admin'])
    expect(menu.body.hat).toBe('admin')
    expect(menu.body.showSwitch).toBe(true)

    expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(200)
    const narrowed = await whoIs(token)
    expect(narrowed!.level).toBe('member')
    expect(hatsStateOf(narrowed)).toMatchObject({ hat: 'member', via: null })
    // The canary: an administrator wearing Member reads nothing only administrators may read.
    expect(await canReadSecrets(narrowed)).toBe(false)
    // The state never ends up in a response.
    expect(JSON.stringify(narrowed)).not.toContain('_hats')
  })

  it('narrows the user REST and GraphQL requests are built with', async () => {
    const admin = await make(email('admin'), 'admin', { code: '5' })
    const token = await login(admin.email!)
    await call('/hats/switch', token, { hat: 'member' })
    for (const path of ['/api/secrets', '/api/graphql']) {
      const req = await createPayloadRequest({ config, request: new Request(`https://site.example${path}`, { headers: { cookie: `payload-token=${token}` } }) })
      expect((req.user as U).level).toBe('member')
      await expect(payload.find({ collection: 'secrets', req, overrideAccess: false })).rejects.toThrow()
    }
  })

  it('asks for the second factor to switch up, refuses a wrong code, remembers a good one, then asks again', async () => {
    const admin = await make(email('admin'), 'admin', { code: '654321' })
    const token = await login(admin.email!)
    await call('/hats/switch', token, { hat: 'author' })
    // Narrowing never needs a code.
    expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(200)
    const ask = await call('/hats/switch', token, { hat: 'admin' })
    expect(ask.status).toBe(401)
    expect(ask.body.needsCode).toBe(true)
    const wrong = await call('/hats/switch', token, { hat: 'admin', code: '000000' })
    expect(wrong.status).toBe(403)
    expect(wrong.body.reason ?? wrong.body.data?.reason).toBe('wrongCode')
    expect((await whoIs(token))!.level).toBe('member')
    expect((await call('/hats/switch', token, { hat: 'admin', code: '654321' })).status).toBe(200)
    expect((await whoIs(token))!.level).toBe('admin')

    await call('/hats/switch', token, { hat: 'member' })
    expect((await call('/hats/switch', token, { hat: 'curator' })).status).toBe(200) // remembered

    const sid = hatsStateOf(await whoIs(token))!.sid
    const { docs } = await payload.find({ collection: SESSIONS as never, where: { sid: { equals: sid } }, overrideAccess: true })
    const old = new Date(Date.now() - 181 * 60_000).toISOString()
    await payload.update({ collection: SESSIONS as never, id: docs[0]!.id, data: { steppedUp: { [String(admin.id)]: old } } as never, overrideAccess: true })
    await call('/hats/switch', token, { hat: 'member' })
    expect((await call('/hats/switch', token, { hat: 'admin' })).status).toBe(401) // three hours on: asked again
  })

  it('refuses a sensitive hat on an account with no second factor, and any hat the account doesn’t hold', async () => {
    const curator = await make(email('curator'), 'curator')
    const token = await login(curator.email!)
    await call('/hats/switch', token, { hat: 'member' })
    const res = await call('/hats/switch', token, { hat: 'curator' })
    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/two-step/)
    expect((await call('/hats/switch', token, { hat: 'admin' })).status).toBe(400)
  })

  it('falls to the narrowest hat when the worn one is gone, and never lets wear() widen', async () => {
    const u = await make(email('curator'), 'curator', { code: '111111' })
    const token = await login(u.email!)
    await call('/hats/switch', token, { hat: 'author' })
    await payload.update({ collection: 'users', id: u.id, data: { level: 'member' } as never, overrideAccess: true })
    await payload.update({ collection: 'users', id: u.id, data: { level: 'curator' } as never, overrideAccess: true })
    expect((await whoIs(token))!.level).toBe('author')
    // A stored hat the account no longer holds (e.g. written before a role change): narrowest, not widest.
    const sid = hatsStateOf(await whoIs(token))!.sid
    const { docs } = await payload.find({ collection: SESSIONS as never, where: { sid: { equals: sid } }, overrideAccess: true })
    await payload.update({ collection: SESSIONS as never, id: docs[0]!.id, data: { hat: 'pope' } as never, overrideAccess: true })
    expect((await whoIs(token))!.level).toBe('member')

    await payload.update({ collection: SESSIONS as never, id: docs[0]!.id, data: { hat: 'member' } as never, overrideAccess: true })
    const raw = { ...(await payload.findByID({ collection: 'users', id: u.id, overrideAccess: true })), collection: 'users', _sid: sid } as unknown as HatsUser
    const opts = payload.config.custom!.hats
    await expect(applyHat(payload, { ...opts, wear: (x: HatsUser) => ({ ...x, level: 'admin' }) as HatsUser }, raw)).rejects.toThrow(/doesn't hold/)
    await expect(applyHat(payload, { ...opts, wear: (x: HatsUser) => x }, raw)).rejects.toThrow(/sensitive/)
  })

  it('hides the switch from an account with nothing to switch to, and refuses it while masquerading', async () => {
    const member = await make(email('member'), 'member')
    const token = await login(member.email!)
    expect((await call('/hats', token, undefined, 'get')).body.showSwitch).toBe(false)
    expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(403)

    const admin = await make(email('admin'), 'admin', { code: '1' })
    masquerading = true
    expect((await call('/hats/switch', await login(admin.email!), { hat: 'member' })).status).toBe(409)
  })
})

describe('an account left with no hats', () => {
  it('signs out its sessions that wear a hat or came from another account, instead of giving them every role', async () => {
    // Its own session, wearing a narrower hat.
    const own = await make(email('nohat'), 'author')
    const token = await login(own.email!)
    expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(200)
    // Disabled without any hook running (a direct write), so only the per-request check stands in the way.
    await payload.db.updateOne({ collection: 'users', id: own.id, data: { disabled: true }, returning: false })
    expect(await whoIs(token)).toBeNull()

    // A session switched into it from a linked account.
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const a = await make(email('a'), 'author')
    const b = await make(email('b'), 'admin', { code: '424242' })
    await link(a, b, approver)
    const res = await call('/hats/switch', await login(a.email!), { account: b.id, hat: 'member' })
    expect(await whoIs(res.token!)).toBeTruthy()
    await payload.db.updateOne({ collection: 'users', id: b.id, data: { disabled: true }, returning: false })
    expect(await whoIs(res.token!)).toBeNull()

    // A plain sign-in with no hats is the site's business (it refuses disabled accounts at sign-in): unchanged.
    const plain = await make(email('plain'), 'member')
    const plainToken = await login(plain.email!)
    await payload.db.updateOne({ collection: 'users', id: plain.id, data: { disabled: true }, returning: false })
    expect((await whoIs(plainToken))?.id).toBe(plain.id)
  })
})

describe('wear() that doesn’t narrow', () => {
  it('refuses a wear() that hands back the same user', async () => {
    // An author wearing Member: no sensitive hat involved, so only this guard can catch it.
    const u = await make(email('w'), 'author')
    const token = await login(u.email!)
    expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(200)
    const sid = hatsStateOf(await whoIs(token))!.sid
    const raw = (await payload.findByID({ collection: 'users', id: u.id, depth: 0, overrideAccess: true })) as unknown as HatsUser
    const opts = { ...(payload.config.custom!.hats as ResolvedHatsOptions), wear: (x: HatsUser) => x }
    await expect(applyHat(payload, opts, { ...raw, collection: 'users', _sid: sid } as HatsUser)).rejects.toThrow(/unchanged/)
  })
})

describe('linking', () => {
  it('needs both emails confirmed and an approver outside the set; tokens work once', async () => {
    const maint = await make(email('maint'), 'admin', { maintainer: true, code: '9' })
    const other = await make(email('maint2'), 'admin', { maintainer: true, code: '8' })
    const b = await make(email('b'), 'member')
    const res = await call('/hats/link', await login(maint.email!), { email: b.email })
    expect(res.status).toBe(202)
    expect(mail.map((m) => m.to).sort()).toEqual([maint.email, b.email].sort())
    const [t1, t2] = mail.map((m) => tokenFrom(m.text))

    const row = async () => (await payload.find({ collection: MEMBERS as never, where: { user: { equals: b.id } }, overrideAccess: true })).docs[0]!
    // Not before it's confirmed.
    await expect(payload.update({ collection: MEMBERS as never, id: (await row()).id, data: { status: 'approved' } as never, user: other as never, overrideAccess: false })).rejects.toThrow(/confirmed/)

    // A mail scanner opening the link confirms nothing.
    expect((await call('/hats/confirm', null, undefined, 'get')).status).toBe(200)
    expect((await row()).status).toBe('requested')
    for (const t of [t1, t2]) expect((await call('/hats/confirm', null, { token: t })).status).toBe(200)
    expect((await call('/hats/confirm', null, { token: t1 })).status).toBe(400) // once only
    expect((await row()).status).toBe('confirmed')

    // The approver is in the set: refused, so the owner's own links need someone else.
    await expect(payload.update({ collection: MEMBERS as never, id: (await row()).id, data: { status: 'approved' } as never, user: maint as never, overrideAccess: false })).rejects.toThrow(/belong to/)
    // Nobody else can rewrite the row, or approve without the approver role.
    await expect(payload.update({ collection: MEMBERS as never, id: (await row()).id, data: { user: other.id } as never, user: other as never, overrideAccess: false })).rejects.toThrow()
    await expect(payload.update({ collection: MEMBERS as never, id: (await row()).id, data: { status: 'approved' } as never, user: b as never, overrideAccess: false })).rejects.toThrow()
    await payload.update({ collection: MEMBERS as never, id: (await row()).id, data: { status: 'approved' } as never, user: other as never, overrideAccess: false })
    expect((await row()).status).toBe('approved')
    expect((await row()).approvedBy).toBeTruthy()
  })

  it('refuses an expired link and gives nothing away about other accounts', async () => {
    const a = await make(email('a'), 'author')
    const taken = await make(email('taken'), 'member')
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    await link(taken, await make(email('x'), 'member'), approver)
    mail.length = 0

    const token = await login(a.email!)
    const answers = [await call('/hats/link', token, { email: 'nobody@example.invalid' }), await call('/hats/link', token, { email: taken.email }), await call('/hats/link', token, { email: a.email })]
    for (const r of answers) expect([r.status, r.body.message]).toEqual([202, answers[0]!.body.message])
    expect(mail).toHaveLength(0)

    const fresh = await make(email('fresh'), 'member')
    await call('/hats/link', token, { email: fresh.email })
    // The requester's own menu doesn't show the other account until its owner confirms it.
    expect((await call('/hats', token, undefined, 'get')).body.set.map((m: { label: string }) => m.label)).toEqual([a.email])
    const t = tokenFrom(mail.find((m) => m.to === fresh.email)!.text)
    const row = (await payload.find({ collection: MEMBERS as never, where: { user: { equals: fresh.id } }, overrideAccess: true })).docs[0]!
    await payload.update({ collection: MEMBERS as never, id: row.id, data: { tokenExpires: new Date(Date.now() - 1000).toISOString() } as never, overrideAccess: true, context: { hatsInternal: true } })
    expect((await call('/hats/confirm', null, { token: t })).status).toBe(400)
  })

  it('refuses link requests the site’s limit refuses, and when the limit itself fails, sending nothing', async () => {
    const a = await make(email('lim'), 'member')
    const target = await make(`limited-${email('t')}`, 'member')
    const broken = await make(`broken-${email('t')}`, 'member')
    for (const to of [target, broken]) {
      const res = await call('/hats/link', await login(a.email!), { email: to.email })
      expect(res.status).toBe(429)
      expect(res.body.data?.reason).toBe('tooMany')
    }
    expect(mail).toHaveLength(0)
    expect((await payload.find({ collection: MEMBERS as never, where: { user: { in: [a.id, target.id, broken.id] } }, overrideAccess: true })).totalDocs).toBe(0)
  })

  it('holds at most four accounts, and one set per account', async () => {
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const [a, b, c, d, e] = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((x) => make(email(x), 'author')))
    await link(a!, b!, approver)
    await link(a!, c!, approver)
    await link(a!, d!, approver)
    const res = await call('/hats/link', await login(a!.email!), { email: e!.email })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/at most 4/)
    const set = await payload.find({ collection: MEMBERS as never, where: { user: { in: [a!.id, b!.id, c!.id, d!.id] } }, overrideAccess: true })
    expect(new Set(set.docs.map((m) => String((m as unknown as { link: unknown }).link))).size).toBe(1)
    expect(set.docs.every((m) => (m as unknown as { status: string }).status === 'approved')).toBe(true)
  })
})

describe('switching accounts', () => {
  async function linkedPair() {
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const a = await make(email('a'), 'author')
    const b = await make(email('b'), 'admin', { code: '424242' })
    await link(a, b, approver)
    return { a, b, approver }
  }

  it('switches within an approved set, credits the account switched to, and asks for that account’s code', async () => {
    const { a, b } = await linkedPair()
    const token = await login(a.email!)
    expect((await call('/hats', token, undefined, 'get')).body.linked.map((l: { label: string }) => l.label)).toEqual([b.email])
    // Into b's narrowest hat: no code needed.
    const res = await call('/hats/switch', token, { account: b.id, hat: 'member' })
    expect(res.status).toBe(200)
    expect(res.token).toBeTruthy()
    const asB = await whoIs(res.token!)
    expect(asB!.id).toBe(b.id)
    expect(asB!.level).toBe('member')
    expect(hatsStateOf(asB)).toMatchObject({ via: String(a.id), hat: 'member' })
    expect(await whoIs(token)).toBeNull() // the session it came from has ended
    // b's admin hat: b's own second factor.
    expect((await call('/hats/switch', res.token, { hat: 'admin' })).status).toBe(401)
    expect((await call('/hats/switch', res.token, { hat: 'admin', code: '424242' })).status).toBe(200)
    expect(await canReadSecrets(await whoIs(res.token!))).toBe(true)
    // Back to a: a plain session of a's own again.
    const back = await call('/hats/switch', res.token, { account: a.id, hat: 'author' })
    expect(hatsStateOf(await whoIs(back.token!))).toMatchObject({ via: null })
  })

  it('refuses accounts outside the set, including before approval', async () => {
    const { a } = await linkedPair()
    const stranger = await make(email('s'), 'admin')
    expect((await call('/hats/switch', await login(a.email!), { account: stranger.id, hat: 'member' })).status).toBe(403)
    const c = await make(email('c'), 'member')
    await call('/hats/link', await login(a.email!), { email: c.email })
    for (const m of [...mail]) await call('/hats/confirm', null, { token: tokenFrom(m.text) })
    expect((await call('/hats/switch', await login(a.email!), { account: c.id, hat: 'member' })).status).toBe(403)
  })

  it('ends switched sessions the moment the link goes: self-serve unlink, an approver’s delete, a lost role', async () => {
    const into = async () => {
      const p = await linkedPair()
      const res = await call('/hats/switch', await login(p.a.email!), { account: p.b.id, hat: 'member' })
      expect(await whoIs(res.token!)).toBeTruthy()
      return { ...p, token: res.token! }
    }
    // Unlink, self-serve, from b's own sign-in.
    let s = await into()
    const own = await login(s.b.email!)
    expect((await call('/hats/unlink', own, {})).status).toBe(200)
    expect(await whoIs(s.token)).toBeNull()
    expect(await whoIs(own)).toBeTruthy() // b's own sign-in stays
    expect((await payload.find({ collection: MEMBERS as never, where: { user: { equals: s.a.id } }, overrideAccess: true })).totalDocs).toBe(0) // a set of one is gone

    // An approver deletes the row.
    s = await into()
    const row = (await payload.find({ collection: MEMBERS as never, where: { user: { equals: s.b.id } }, overrideAccess: true })).docs[0]!
    await payload.delete({ collection: MEMBERS as never, id: row.id, user: s.approver as never, overrideAccess: false })
    expect(await whoIs(s.token)).toBeNull()

    // b loses a role.
    s = await into()
    await payload.update({ collection: 'users', id: s.b.id, data: { level: 'curator' } as never, overrideAccess: true })
    expect(await whoIs(s.token)).toBeNull()

    // Even if the session record survived somehow, the set is re-checked on every request.
    s = await into()
    const sid = hatsStateOf(await whoIs(s.token))!.sid
    await payload.db.deleteMany({ collection: MEMBERS, where: { user: { equals: s.b.id } } })
    expect(await whoIs(s.token)).toBeNull()
    const rows = (await payload.find({ collection: SESSIONS as never, where: { sid: { equals: sid } }, overrideAccess: true })).docs as { revokedAt?: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.revokedAt).toBeTruthy() // kept as a tombstone, not deleted
  })

  it('keeps a revoked session signed out even when Payload puts it back', async () => {
    const { a, b } = await linkedPair()
    const res = await call('/hats/switch', await login(a.email!), { account: b.id, hat: 'member' })
    const sid = hatsStateOf(await whoIs(res.token!))!.sid
    const sessionsOf = async () => ((await payload.findByID({ collection: 'users', id: b.id, depth: 0, overrideAccess: true, showHiddenFields: true })) as unknown as { sessions: { id: string }[] }).sessions
    const before = await sessionsOf()
    expect(before.some((x) => x.id === sid)).toBe(true)
    // b loses a role: switched sessions end, while the link itself stays.
    await payload.update({ collection: 'users', id: b.id, data: { level: 'curator' } as never, overrideAccess: true })
    expect(await whoIs(res.token!)).toBeNull()
    // A sign-in elsewhere that read b's sessions before the revocation writes them all back.
    await payload.db.updateOne({ collection: 'users', id: b.id, data: { sessions: before }, returning: false })
    expect((await sessionsOf()).some((x) => x.id === sid)).toBe(true)
    // Still signed out: never a plain sign-in with b's every role. And the session is taken off again.
    expect(await whoIs(res.token!)).toBeNull()
    expect((await sessionsOf()).some((x) => x.id === sid)).toBe(false)
  })

  it('cleans up session records only once their Payload session is gone', async () => {
    const { a, b } = await linkedPair()
    const res = await call('/hats/switch', await login(a.email!), { account: b.id, hat: 'member' })
    const sid = hatsStateOf(await whoIs(res.token!))!.sid
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
    // A live switched session whose record says it expired (Payload refreshed it): kept.
    await payload.update({ collection: SESSIONS as never, where: { sid: { equals: sid } }, data: { expiresAt: old } as never, overrideAccess: true })
    // A long-gone one: removed.
    await payload.create({ collection: SESSIONS as never, data: { sid: `gone-${n}`, user: String(b.id), revokedAt: old, expiresAt: old } as never, overrideAccess: true })
    await cleanupSessions(payload)
    const left = async (s: string) => (await payload.find({ collection: SESSIONS as never, where: { sid: { equals: s } }, overrideAccess: true })).totalDocs
    expect(await left(sid)).toBe(1)
    expect(await left(`gone-${n}`)).toBe(0)
    const asB = await whoIs(res.token!)
    expect(asB!.level).toBe('member') // still narrowed
  })

  it('records who did what for the audit log', async () => {
    events.length = 0
    const { a, b } = await linkedPair()
    await call('/hats/switch', await login(a.email!), { account: b.id, hat: 'member' })
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['link-requested', 'link-confirmed', 'link-approved', 'switched']))
    expect(events.find((e) => e.type === 'switched')).toMatchObject({ from: String(a.id), to: String(b.id), via: String(a.id), hat: 'member', steppedUp: false })
  })
})

describe('only an exact true from the site’s checks', () => {
  it('refuses a step-up when available or verify answers anything but true, a throw included, and never 500s', async () => {
    const admin = await make(email('admin'), 'admin', { code: '246810' })
    const token = await login(admin.email!)
    expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(200)

    for (const [what, answer] of NOT_TRUE) {
      answers.available = answer
      const res = await call('/hats/switch', token, { hat: 'admin', code: '246810' })
      expect(res.status, `available: ${what}`).toBe(403)
      expect(res.body.data?.reason, `available: ${what}`).toBe('setUpTwoStep')
    }
    delete answers.available

    for (const [what, answer] of NOT_TRUE) {
      answers.verify = answer
      const res = await call('/hats/switch', token, { hat: 'admin', code: '246810' })
      expect(res.status, `verify: ${what}`).toBe(403)
      expect(res.body.data?.reason, `verify: ${what}`).toBe('wrongCode')
      expect((await whoIs(token))!.level, `verify: ${what}`).toBe('member')
    }
    const sid = hatsStateOf(await whoIs(token))!.sid
    const { docs } = await payload.find({ collection: SESSIONS as never, where: { sid: { equals: sid } }, overrideAccess: true })
    expect(docs[0]?.steppedUp?.[String(admin.id)]).toBeUndefined() // nothing remembered from a refused code

    answers.available = () => true
    answers.verify = () => true
    expect((await call('/hats/switch', token, { hat: 'admin', code: '246810' })).status).toBe(200)
    expect((await whoIs(token))!.level).toBe('admin')
  })

  it('refuses link approval, and reading the sets, unless canApproveLinks answers exactly true', async () => {
    const maint = await make(email('maint'), 'admin', { maintainer: true })
    const a = await make(email('a'), 'member')
    const b = await make(email('b'), 'member')
    expect((await call('/hats/link', await login(a.email!), { email: b.email })).status).toBe(202)
    for (const m of [...mail]) expect((await call('/hats/confirm', null, { token: tokenFrom(m.text) })).status).toBe(200)
    const row = async () => (await payload.find({ collection: MEMBERS as never, where: { user: { equals: b.id } }, overrideAccess: true })).docs[0]!

    for (const [what, answer] of NOT_TRUE) {
      answers.approve = answer
      const approve = payload.update({ collection: MEMBERS as never, id: (await row()).id, data: { status: 'approved' } as never, user: maint as never, overrideAccess: false })
      await expect(approve, `approve: ${what}`).rejects.toMatchObject({ status: 403 })
      await expect(payload.find({ collection: MEMBERS as never, user: maint as never, overrideAccess: false }), `read: ${what}`).rejects.toMatchObject({ status: 403 })
      expect((await row()).status, what).toBe('confirmed')
    }

    answers.approve = () => true
    expect((await payload.find({ collection: MEMBERS as never, where: { user: { equals: b.id } }, user: maint as never, overrideAccess: false })).docs).toHaveLength(1)
    await payload.update({ collection: MEMBERS as never, id: (await row()).id, data: { status: 'approved' } as never, user: maint as never, overrideAccess: false })
    expect((await row()).status).toBe('approved')
  })
})
