import { addDataAndFileToRequest, APIError, getFieldsToSign, jwtSign, type Endpoint, type PayloadRequest } from 'payload'
import { addSessionToUser, generateCookie } from 'payload/shared'

import { exactlyTrue } from './access.js'
import { cleanupSessions, revokeSessions, revokeSid, sessionBySid, sharedLink, tombstone, wornHat } from './sessions.js'
import { asPlugin, hashToken, hatsOptions, hatsStateOf, idOf, newToken } from './state.js'
import { LINKS, MEMBERS, SESSIONS, type Hat, type HatsUser, type ResolvedHatsOptions } from './types.js'

const json = (body: unknown, status = 200, cookies: string[] = []) => {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  for (const c of cookies) headers.append('Set-Cookie', c)
  return new Response(JSON.stringify(body), { status, headers })
}
/** A refusal with a stable `reason`, so a site can show its own words for it (the English message is the fallback). */
const refuse = (message: string, status = 403, reason?: string): never => {
  throw new APIError(message, status, reason ? { reason } : undefined, true)
}

/** The acting account, its full record (all roles, not the hat), and the session's hat state. */
async function actor(req: PayloadRequest) {
  const opts = hatsOptions(req.payload)
  const user = req.user as HatsUser | null
  if (!user || user.collection !== opts.users) refuse('Sign in first.', 401, 'signIn')
  const state = hatsStateOf(user)
  if (!state) refuse('Switching needs a browser sign-in.', 400, 'signIn')
  const full = await loadUser(req, String(user!.id))
  if (!full) refuse('Sign in first.', 401, 'signIn')
  return { opts, user: user!, full: full!, state: state!, person: state!.via ?? String(user!.id) }
}

const loadUser = async (req: PayloadRequest, id: string) =>
  (await req.payload.findByID({ collection: hatsOptions(req.payload).users as never, id, depth: 0, overrideAccess: true, showHiddenFields: true, disableErrors: true, req })) as HatsUser | null

const labelOf = (u: HatsUser) => String(u.email ?? u.id)

async function members(req: PayloadRequest, link: string) {
  const { docs } = await req.payload.find({ collection: MEMBERS as never, where: { link: { equals: link } }, limit: 0, depth: 0, overrideAccess: true, pagination: false, req })
  return docs as unknown as { id: string; user: unknown; status: string }[]
}
async function membershipOf(req: PayloadRequest, userId: string) {
  const { docs } = await req.payload.find({ collection: MEMBERS as never, where: { user: { equals: userId } }, limit: 1, depth: 0, overrideAccess: true, pagination: false, req })
  return (docs[0] as unknown as { id: string; link: unknown; status: string } | undefined) ?? null
}

/** The other approved accounts in the acting account's set, with their hats. */
async function linkedAccounts(req: PayloadRequest, userId: string) {
  const mine = await membershipOf(req, userId)
  if (mine?.status !== 'approved') return { link: null, linked: [] as { user: HatsUser; hats: Hat[] }[] }
  const link = idOf(mine.link)
  const linked: { user: HatsUser; hats: Hat[] }[] = []
  for (const m of await members(req, link)) {
    if (m.status !== 'approved' || idOf(m.user) === userId) continue
    const u = await loadUser(req, idOf(m.user))
    if (u) linked.push({ user: u, hats: hatsOptions(req.payload).hatsOf(u) })
  }
  return { link, linked }
}

const defaultShow: NonNullable<ResolvedHatsOptions['showSwitch']> = ({ hats, linked }) => hats.length > 1 || linked.some((l) => l.hats.length > 1)

const remembered = (opts: ResolvedHatsOptions, steppedUp: Record<string, string> | null | undefined, account: string) => {
  const at = steppedUp?.[account]
  return Boolean(at && Date.now() - new Date(at).getTime() < (opts.stepUp?.rememberMinutes ?? 180) * 60_000)
}

async function blockedReason(req: PayloadRequest, opts: ResolvedHatsOptions) {
  const why = await opts.blocked?.(req)
  if (why) refuse(why, 409, 'blocked')
}

/** GET /api/hats: the switch menu for the acting account. */
const me: Endpoint = {
  path: '/hats',
  method: 'get',
  handler: async (req) => {
    if (!req.user) return json({ signedIn: false })
    const { opts, full, state, person } = await actor(req)
    const hats = opts.hatsOf(full)
    const { link, linked } = await linkedAccounts(req, String(full.id))
    const worn = wornHat(hats, state.hat ? { hat: state.hat, via: state.via } : null) ?? hats.at(-1) ?? null
    const s = await sessionBySid(req.payload, state.sid, req)
    const mine = await membershipOf(req, String(full.id))
    // The set as this account may see it: an account nobody has confirmed yet stays hidden, so a request never
    // reveals whether an email has an account here.
    const set: { id: string | number; label: string; status: string; you: boolean }[] = []
    if (mine)
      for (const m of await members(req, idOf(mine.link))) {
        const you = idOf(m.user) === String(full.id)
        if (!you && m.status === 'requested') continue
        const u = you ? full : await loadUser(req, idOf(m.user))
        if (u) set.push({ id: u.id, label: labelOf(u), status: m.status, you })
      }
    return json({
      signedIn: true,
      account: { id: full.id, label: labelOf(full) },
      signedInAs: person,
      hat: worn?.id ?? null,
      hats: hats.map((h) => ({ ...h, needsCode: Boolean(h.sensitive && h.id !== worn?.id && !remembered(opts, s?.steppedUp, String(full.id))) })),
      linked: linked.map((l) => ({
        id: l.user.id,
        label: labelOf(l.user),
        hats: l.hats.map((h) => ({ ...h, needsCode: Boolean(h.sensitive && !remembered(opts, s?.steppedUp, String(l.user.id))) })),
      })),
      link,
      set,
      canLink: Boolean(opts.canApproveLinks),
      showSwitch: (opts.showSwitch ?? defaultShow)({ user: full, hats, linked }),
      maxLinked: opts.maxLinked,
    })
  },
}

/**
 * POST /api/hats/switch { account?, hat, code? }: wear another hat, on this account or another approved account in
 * the same set. A sensitive hat needs that account's second factor unless it was given here recently.
 */
const switchHat: Endpoint = {
  path: '/hats/switch',
  method: 'post',
  handler: async (req) => {
    await addDataAndFileToRequest(req)
    const { opts, full, state, person } = await actor(req)
    await blockedReason(req, opts)
    const body = (req.data ?? {}) as { account?: unknown; hat?: unknown; code?: unknown }
    const current = String(full.id)
    const to = body.account == null || body.account === '' ? current : String(body.account)

    let link: string | null = null
    if (to !== current) {
      link = await sharedLink(req.payload, current, to, req)
      if (!link) refuse('That account isn’t linked to this one.', 403, 'notLinked')
    }
    const target = to === current ? full : await loadUser(req, to)
    if (!target) refuse('That account isn’t linked to this one.', 403, 'notLinked')
    const { linked } = await linkedAccounts(req, current)
    if (!(opts.showSwitch ?? defaultShow)({ user: full, hats: opts.hatsOf(full), linked })) refuse('Switching isn’t available for this account.', 403, 'notAvailable')

    const hats = opts.hatsOf(target!)
    const hat = typeof body.hat === 'string' ? hats.find((h) => h.id === body.hat) : to === current ? undefined : hats[0]
    if (!hat) refuse('Choose one of that account’s hats.', 400, 'chooseHat')

    const s = await sessionBySid(req.payload, state.sid, req)
    const nowWearing = to === current ? (wornHat(hats, s) ?? hats.at(-1))!.id : null
    const steppedUp = { ...(s?.steppedUp ?? {}) }
    let gaveCode = false
    if (hat!.sensitive && hat!.id !== nowWearing && !remembered(opts, steppedUp, to)) {
      if (!opts.stepUp) refuse('This site has no second factor for switching up.', 403, 'noSecondFactor')
      // Only an exact `true` passes either check; a truthy answer such as `{ valid: false }`, or a thrown error, is a no.
      const stepUp = opts.stepUp!
      if (!(await exactlyTrue(() => stepUp.available(target!)))) refuse('Set up two-step sign-in on that account first.', 403, 'setUpTwoStep')
      const code = typeof body.code === 'string' ? body.code.trim() : ''
      if (!code) return json({ ok: false, needsCode: true, reason: 'needsCode', message: 'Enter a code from that account’s authenticator app.' }, 401)
      if (!(await exactlyTrue(() => stepUp.verify({ req, user: target!, code })))) refuse('That code didn’t work. Try a new one.', 403, 'wrongCode')
      steppedUp[to] = new Date().toISOString()
      gaveCode = true
    }

    const users = req.payload.collections[opts.users as never]!.config
    if (to === current) {
      await asPlugin(req, async () => {
        if (s) await req.payload.update({ collection: SESSIONS as never, id: s.id, data: { hat: hat!.id, steppedUp } as never, overrideAccess: true, req })
        else await req.payload.create({ collection: SESSIONS as never, data: { sid: state.sid, user: current, hat: hat!.id, steppedUp, expiresAt: expiry(users.auth.tokenExpiration) } as never, overrideAccess: true, req })
      })
      await opts.onEvent?.({ type: 'switched', req, from: current, to, hat: hat!.id, via: person, steppedUp: gaveCode })
      return json({ ok: true, account: to, hat: hat!.id, reload: true })
    }

    // Another account: a fresh Payload session for it, then this one ends.
    const own = person === to
    const { sid } = await addSessionToUser({ collectionConfig: users, payload: req.payload, req, user: target as never })
    if (!sid) refuse('Switching accounts needs Payload sessions (auth.useSessions).', 500)
    await asPlugin(req, () =>
      req.payload.create({
        collection: SESSIONS as never,
        data: { sid, user: to, via: own ? null : person, link: own ? null : link, hat: hat!.id, steppedUp, expiresAt: expiry(users.auth.tokenExpiration) } as never,
        overrideAccess: true,
        req,
      }),
    )
    await revokeSid(req.payload, current, state.sid, req)
    if (s) await tombstone(req.payload, s.id, req)
    else
      await asPlugin(req, () =>
        req.payload.create({ collection: SESSIONS as never, data: { sid: state.sid, user: current, revokedAt: new Date().toISOString(), expiresAt: expiry(users.auth.tokenExpiration) } as never, overrideAccess: true, req }),
      )
    await cleanupSessions(req.payload, req).catch((err) => req.payload.logger.warn({ err }, 'Hats: session clean-up skipped'))
    const { token } = await jwtSign({
      fieldsToSign: getFieldsToSign({ collectionConfig: users, email: String(target!.email ?? ''), sid, user: target as never }),
      secret: req.payload.secret,
      tokenExpiration: users.auth.tokenExpiration,
    })
    const cookie = generateCookie<string>({
      name: `${req.payload.config.cookiePrefix}-token`,
      value: token,
      path: '/',
      httpOnly: true,
      secure: users.auth.cookies.secure,
      sameSite: typeof users.auth.cookies.sameSite === 'string' ? users.auth.cookies.sameSite : 'Lax',
      domain: users.auth.cookies.domain ?? undefined,
      expires: new Date(Date.now() + users.auth.tokenExpiration * 1000),
      returnCookieAsObject: false,
    })
    await opts.onEvent?.({ type: 'switched', req, from: current, to, hat: hat!.id, via: person, steppedUp: gaveCode })
    return json({ ok: true, account: to, hat: hat!.id, reload: true }, 200, [cookie])
  },
}

const expiry = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()

const SENT = 'If that account can be linked, we’ve emailed it a link to confirm. Confirm from your own email too; then an administrator reviews the link.'

/** POST /api/hats/link { email }: ask to link the acting account with another. Says the same thing whatever happens to the other account. */
const requestLink: Endpoint = {
  path: '/hats/link',
  method: 'post',
  handler: async (req) => {
    await addDataAndFileToRequest(req)
    const { opts, full } = await actor(req)
    await blockedReason(req, opts)
    if (!opts.canApproveLinks) refuse('Linking accounts isn’t turned on here.', 403, 'linkingOff')
    const email = String((req.data as { email?: unknown } | undefined)?.email ?? '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) refuse('Enter the other account’s email address.', 400, 'enterEmail')
    // Refused when the site's limit says so (and when the limit itself fails): nothing is recorded or sent.
    if (opts.limit && !(await (async () => opts.limit!({ req, user: full, email }))().catch(() => false))) refuse('Too many link requests. Try again later.', 429, 'tooMany')
    const me = String(full.id)
    const now = new Date()

    await asPlugin(req, async () => {
      // Requests nobody confirmed in time don't hold anyone up.
      await req.payload.delete({
        collection: MEMBERS as never,
        where: { and: [{ status: { equals: 'requested' } }, { tokenExpires: { less_than: now.toISOString() } }] },
        overrideAccess: true,
        showHiddenFields: true,
        req,
      })
    })
    const mine = await membershipOf(req, me)
    const already = mine ? (await members(req, idOf(mine.link))).length : 0
    if (already + (mine ? 1 : 2) > opts.maxLinked) refuse(`A set can hold at most ${opts.maxLinked} accounts.`, 400, 'setFull')

    const { docs } = await req.payload.find({ collection: opts.users as never, where: { email: { equals: email } }, limit: 1, depth: 0, overrideAccess: true, pagination: false, req })
    const target = docs[0] as HatsUser | undefined
    if (!target || String(target.id) === me || (await membershipOf(req, String(target.id)))) return json({ ok: true, reason: 'linkSent', message: SENT }, 202)

    const hours = opts.confirmHours
    const invite = async (user: HatsUser, link: string) => {
      const token = newToken()
      await req.payload.create({
        collection: MEMBERS as never,
        data: { link, user: user.id, status: 'requested', tokenHash: hashToken(token), tokenExpires: new Date(now.getTime() + hours * 3_600_000).toISOString(), addedBy: me } as never,
        overrideAccess: true,
        req,
      })
      const url = opts.confirmURL ? opts.confirmURL({ req, token }) : `${new URL(req.url ?? 'http://localhost').origin}${req.payload.config.routes.api}/hats/confirm?token=${token}`
      await opts.sendEmail({
        payload: req.payload,
        to: String(user.email),
        subject: 'Confirm linking your accounts',
        text: `Someone asked to link ${labelOf(full)} and ${labelOf(target)}, so one person can switch between them.\n\nIf that was you, confirm here within ${hours} hours:\n${url}\n\nIf it wasn’t you, ignore this email: nothing is linked without it.`,
      })
    }
    let link = mine ? idOf(mine.link) : null
    try {
      await asPlugin(req, async () => {
        if (!link) link = String((await req.payload.create({ collection: LINKS as never, data: { requestedBy: me, label: `Started by ${labelOf(full)}` } as never, overrideAccess: true, req })).id)
        if (!mine) await invite(full, link)
        await invite(target, link)
      })
    } catch (error) {
      // Someone else linked that account a moment ago (the one-set-per-account index): say the same as always.
      req.payload.logger.warn({ err: error }, 'Hats: link request not recorded')
      return json({ ok: true, reason: 'linkSent', message: SENT }, 202)
    }
    await opts.onEvent?.({ type: 'link-requested', req, link: link!, by: me, account: String(target.id) })
    return json({ ok: true, reason: 'linkSent', message: SENT }, 202)
  },
}

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font:1rem/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#222;background:#fff}button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #333;background:#222;color:#fff;cursor:pointer}button:focus-visible{outline:3px solid #c60;outline-offset:2px}@media (prefers-color-scheme:dark){body{color:#eee;background:#111}button{background:#eee;color:#111;border-color:#eee}}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  )
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** GET /api/hats/confirm?token=…: a button, so a mail scanner opening the link doesn't confirm anything. */
const confirmPage: Endpoint = {
  path: '/hats/confirm',
  method: 'get',
  handler: async (req) => {
    const token = new URL(req.url ?? 'http://localhost').searchParams.get('token') ?? ''
    return page(
      'Link your accounts',
      `<p>Confirm that this account belongs to the person who asked to link it. An administrator reviews the link before it works.</p><form method="post"><input type="hidden" name="token" value="${esc(token)}"><button type="submit">Confirm</button></form>`,
    )
  },
}

/** POST /api/hats/confirm (form or JSON { token }). */
const confirm: Endpoint = {
  path: '/hats/confirm',
  method: 'post',
  handler: async (req) => {
    let token = ''
    const type = req.headers.get('content-type') ?? ''
    if (type.includes('application/x-www-form-urlencoded') && req.text) token = new URLSearchParams(await req.text()).get('token') ?? ''
    else {
      await addDataAndFileToRequest(req)
      token = String((req.data as { token?: unknown } | undefined)?.token ?? '')
    }
    const bad = () => page('That link didn’t work', '<p>It may have expired or been used already. Ask again from your account page.</p>', 400)
    if (!token) return bad()
    const { docs } = await req.payload.find({ collection: MEMBERS as never, where: { tokenHash: { equals: hashToken(token) } }, limit: 1, depth: 0, overrideAccess: true, showHiddenFields: true, pagination: false, req })
    const m = docs[0] as unknown as { id: string; link: unknown; user: unknown; status: string; tokenExpires?: string } | undefined
    if (!m || m.status !== 'requested' || !m.tokenExpires || new Date(m.tokenExpires).getTime() < Date.now()) return bad()
    await asPlugin(req, () =>
      req.payload.update({ collection: MEMBERS as never, id: m.id, data: { status: 'confirmed', confirmedAt: new Date().toISOString(), tokenHash: null, tokenExpires: null } as never, overrideAccess: true, req }),
    )
    await hatsOptions(req.payload).onEvent?.({ type: 'link-confirmed', payload: req.payload, link: idOf(m.link), account: idOf(m.user) })
    return page('Confirmed', '<p>Thanks. Once every account in the link is confirmed, an administrator reviews it. You can close this page.</p>')
  },
}

/** POST /api/hats/unlink { account? }: take an account (default: the acting one) out of the set. Self-serve, at once. */
const unlink: Endpoint = {
  path: '/hats/unlink',
  method: 'post',
  handler: async (req) => {
    await addDataAndFileToRequest(req)
    const { opts, full, person } = await actor(req)
    await blockedReason(req, opts)
    const me = String(full.id)
    const account = String((req.data as { account?: unknown } | undefined)?.account ?? me)
    const mine = await membershipOf(req, me)
    const theirs = account === me ? mine : await membershipOf(req, account)
    if (!mine || !theirs || idOf(mine.link) !== idOf(theirs.link)) refuse('That account isn’t in your linked set.', 404, 'notInSet')
    const link = idOf(theirs!.link)
    await asPlugin(req, () => req.payload.delete({ collection: MEMBERS as never, id: theirs!.id, overrideAccess: true, req }))
    await opts.onEvent?.({ type: 'unlinked', payload: req.payload, link, account, by: me })
    // If this session was switched in through the account just removed, it ended with the unlink.
    return json({ ok: true, signedOut: account === me ? person !== me : person === account })
  },
}

export const hatEndpoints: Endpoint[] = [me, switchHat, requestLink, confirmPage, confirm, unlink]
export { revokeSessions }
