import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, CollectionAfterLogoutHook, Config, Plugin } from 'payload'

import { hatCollections } from './collections.js'
import { hatEndpoints } from './endpoints.js'
import { revokeSessions, wrapStrategies } from './sessions.js'
import { asPlugin } from './state.js'
import { MEMBERS, SESSIONS, type HatsOptions, type HatsUser, type ResolvedHatsOptions } from './types.js'

export { hatsStateOf } from './state.js'
export { applyHat, cleanupSessions, revokeSessions } from './sessions.js'
export { LINKS, MEMBERS, SESSIONS } from './types.js'
export type { Hat, HatsEvent, HatsOptions, HatsState, HatsUser } from './types.js'

/**
 * Hats for Payload. One person can link up to `maxLinked` accounts and switch between them, and an account that
 * holds several roles acts in one at a time (a "hat"). Switching into a sensitive hat asks for the site's second
 * factor. Every switched session is checked against its linked set on every request, and ends the moment the set,
 * the membership or the account's roles change.
 */
export const hats =
  (options: HatsOptions): Plugin =>
  (config: Config): Config => {
    const opts: ResolvedHatsOptions = {
      users: 'users',
      maxLinked: 4,
      confirmHours: 24,
      showSwitch: undefined as never,
      adminSwitch: true,
      sendEmail: ({ payload, to, subject, text }) => payload.sendEmail({ to, subject, text }),
      ...options,
    }
    if (opts.maxLinked < 2) throw new Error('hats: maxLinked must be at least 2.')
    const users = (config.collections ?? []).find((c) => c.slug === opts.users)
    if (!users?.auth) throw new Error(`hats: no auth collection "${opts.users}".`)
    if (typeof users.auth === 'object' && users.auth.useSessions === false) throw new Error('hats: needs Payload sessions; remove auth.useSessions: false.')
    for (const slug of ['hat-links', MEMBERS, SESSIONS])
      if ((config.collections ?? []).some((c) => c.slug === slug)) throw new Error(`hats: a collection "${slug}" already exists.`)

    const ids = (u: unknown) => new Set(opts.hatsOf(u as HatsUser).map((h) => h.id))
    // Losing a hat ends every session switched into the account: it comes back in through the switch, re-checked.
    const afterChange: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
      if (operation !== 'update' || !previousDoc) return doc
      const now = ids(doc)
      if ([...ids(previousDoc)].some((h) => !now.has(h))) await revokeSessions(req.payload, { and: [{ user: { equals: String(doc.id) } }, { via: { exists: true } }, { via: { not_equals: null } }] }, 'lost a role', req)
      return doc
    }
    const afterDelete: CollectionAfterDeleteHook = async ({ id, req }) => {
      await revokeSessions(req.payload, { or: [{ user: { equals: String(id) } }, { via: { equals: String(id) } }] }, 'account deleted', req)
      await asPlugin(req, () => req.payload.delete({ collection: MEMBERS as never, where: { user: { equals: String(id) } }, overrideAccess: true, req }))
    }
    const afterLogout: CollectionAfterLogoutHook = async ({ req }) => {
      const sid = (req.user as HatsUser | null)?._sid
      if (sid) await req.payload.update({ collection: SESSIONS as never, where: { sid: { equals: sid } }, data: { revokedAt: new Date().toISOString() } as never, overrideAccess: true, req })
    }

    const onInit = config.onInit
    return {
      ...config,
      collections: [
        ...(config.collections ?? []).map((c) =>
          c.slug === opts.users
            ? {
                ...c,
                hooks: {
                  ...c.hooks,
                  afterChange: [...(c.hooks?.afterChange ?? []), afterChange],
                  afterDelete: [...(c.hooks?.afterDelete ?? []), afterDelete],
                  afterLogout: [...(c.hooks?.afterLogout ?? []), afterLogout],
                },
              }
            : c,
        ),
        ...hatCollections(opts),
      ],
      endpoints: [...(config.endpoints ?? []), ...hatEndpoints],
      admin:
        opts.adminSwitch === false
          ? config.admin
          : { ...config.admin, components: { ...config.admin?.components, actions: [...(config.admin?.components?.actions ?? []), '@extantape/payload-plugin-hats/client#HatSwitcher'] } },
      custom: { ...config.custom, hats: opts },
      onInit: async (payload) => {
        await onInit?.(payload)
        wrapStrategies(payload, opts)
      },
    }
  }
