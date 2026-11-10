import type { AuthStrategy, Payload, PayloadRequest, Where } from 'payload'

import { asPlugin, attachState, hatsOptions, idOf } from './state.js'
import { LINKS, MEMBERS, SESSIONS, type Hat, type HatsState, type HatsUser, type ResolvedHatsOptions } from './types.js'

type SessionDoc = { id: string; sid: string; user: string; via?: string | null; link?: string | null; hat?: string | null; steppedUp?: Record<string, string> | null }

export async function sessionBySid(payload: Payload, sid: string, req?: PayloadRequest) {
  const { docs } = await payload.find({ collection: SESSIONS as never, where: { sid: { equals: sid } }, limit: 1, depth: 0, overrideAccess: true, pagination: false, req })
  return (docs[0] as unknown as SessionDoc | undefined) ?? null
}

/** Removes one Payload session from an account, so its token stops working everywhere at once. */
export async function revokeSid(payload: Payload, userId: string, sid: string, req?: PayloadRequest) {
  const { users } = hatsOptions(payload)
  const user = (await payload.findByID({ collection: users as never, id: userId, depth: 0, overrideAccess: true, showHiddenFields: true, disableErrors: true, req })) as
    | (HatsUser & { sessions?: { id: string }[] })
    | null
  if (!user?.sessions?.some((s) => s.id === sid)) return
  // The same write Payload's own logout makes: only the sessions change.
  await payload.db.updateOne({ collection: users, id: user.id, data: { sessions: user.sessions.filter((s) => s.id !== sid) }, req, returning: false })
}

/** Ends every switched session matching `where` (and its Payload session), e.g. after an unlink. */
export async function revokeSessions(payload: Payload, where: Where, reason: string, req?: PayloadRequest) {
  const { docs } = await payload.find({ collection: SESSIONS as never, where, limit: 0, depth: 0, overrideAccess: true, pagination: false, req })
  for (const s of docs as unknown as SessionDoc[]) {
    await revokeSid(payload, s.user, s.sid, req)
    await payload.delete({ collection: SESSIONS as never, id: s.id, overrideAccess: true, req })
  }
  if (docs.length) await hatsOptions(payload).onEvent?.({ type: 'sessions-revoked', payload, sessions: docs.length, reason })
  return docs.length
}

/** A set with one account left isn't a link any more: remove it. */
export async function dissolveIfAlone(payload: Payload, link: string, req: PayloadRequest) {
  const { docs } = await payload.find({ collection: MEMBERS as never, where: { link: { equals: link } }, limit: 0, depth: 0, overrideAccess: true, pagination: false, req })
  if (docs.length > 1) return
  const before = req.context?.hatsDissolving
  req.context = { ...(req.context ?? {}), hatsDissolving: true }
  try {
    await asPlugin(req, async () => {
      for (const d of docs) await payload.delete({ collection: MEMBERS as never, id: d.id, overrideAccess: true, req })
      await payload.delete({ collection: LINKS as never, where: { id: { equals: link } }, overrideAccess: true, req })
    })
  } finally {
    req.context.hatsDissolving = before
  }
  await revokeSessions(payload, { link: { equals: link } }, 'set dissolved', req)
}

/** The approved set two accounts are both in, or null. Read fresh every time. */
export async function sharedLink(payload: Payload, a: string, b: string, req?: PayloadRequest) {
  const { docs } = await payload.find({
    collection: MEMBERS as never,
    where: { and: [{ user: { in: [a, b] } }, { status: { equals: 'approved' } }] },
    limit: 2,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
  })
  const [x, y] = docs as unknown as { link: unknown; user: unknown }[]
  if (a === b) return x ? idOf(x.link) : null
  return x && y && idOf(x.link) === idOf(y.link) ? idOf(x.link) : null
}

/** The hat a session wears, from the account's current hats. A worn hat the account no longer has falls to the narrowest. */
export function wornHat(hats: Hat[], s: Pick<SessionDoc, 'hat' | 'via'> | null): Hat | null {
  if (!hats.length) return null
  if (!s?.hat) return s?.via ? hats[0]! : null
  return hats.find((h) => h.id === s.hat) ?? hats[0]!
}

/**
 * The user as the rest of the site sees them: narrowed to the hat this session wears. A switched session whose set
 * is gone is revoked and signed out. Anything unexpected throws, which signs the request out: never full roles.
 */
export async function applyHat(payload: Payload, opts: ResolvedHatsOptions, user: HatsUser): Promise<HatsUser | null> {
  const sid = user._sid
  if (!sid) return user // API keys and other non-session sign-ins: the site's own business.
  const s = await sessionBySid(payload, sid)
  if (s && String(s.user) !== String(user.id)) throw new Error('Hats: this session belongs to another account.')
  if (s?.via) {
    const link = await sharedLink(payload, String(user.id), String(s.via))
    if (!link || link !== String(s.link)) {
      await revokeSessions(payload, { sid: { equals: sid } }, 'no longer linked')
      return null
    }
  }
  const hats = opts.hatsOf(user)
  const hat = wornHat(hats, s)
  const state: HatsState = { sid, hat: hat?.id ?? null, via: s?.via ? String(s.via) : null, link: s?.link ? String(s.link) : null }
  if (!hat || hat.id === hats.at(-1)!.id) return attachState(user, state)
  const narrowed = opts.wear(user, hat.id)
  const held = new Map(hats.map((h) => [h.id, h]))
  const after = opts.hatsOf(narrowed)
  // Wearing a hat never adds one, and an ordinary hat never carries a sensitive one with it.
  for (const h of after) if (!held.has(h.id)) throw new Error(`Hats: wearing "${hat.id}" added "${h.id}", which the account doesn't hold.`)
  for (const h of after) if (h.sensitive && !hat.sensitive) throw new Error(`Hats: wearing "${hat.id}" kept the sensitive hat "${h.id}".`)
  return attachState(narrowed, state)
}

/** Every auth strategy, wrapped so a signed-in user of our collection is narrowed before `req.user` exists. */
export function wrapStrategies(payload: Payload, opts: ResolvedHatsOptions) {
  payload.authStrategies = payload.authStrategies.map(
    (strategy): AuthStrategy => ({
      ...strategy,
      authenticate: async (args) => {
        const result = await strategy.authenticate(args)
        const user = result.user as HatsUser | null
        if (!user || user.collection !== opts.users) return result
        const worn = await applyHat(payload, opts, user)
        return { ...result, user: (worn as never) ?? null }
      },
    }),
  )
}
