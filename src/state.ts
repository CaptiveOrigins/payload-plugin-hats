import { createHash, randomBytes } from 'node:crypto'

import type { Payload, PayloadRequest } from 'payload'

import type { HatsState, HatsUser, ResolvedHatsOptions } from './types.js'

const KEY = '_hats'

/** Attaches the session's hat state to a user without it ever being serialised into a response. */
export function attachState<T extends object>(user: T, state: HatsState): T {
  Object.defineProperty(user, KEY, { value: state, enumerable: false, configurable: true, writable: false })
  return user
}

/** The hat state of a signed-in user (or request), for audit logs and the site's own checks. */
export function hatsStateOf(userOrReq: unknown): HatsState | null {
  if (!userOrReq || typeof userOrReq !== 'object') return null
  const user = 'payload' in userOrReq && 'user' in userOrReq ? (userOrReq as PayloadRequest).user : userOrReq
  return ((user as Record<string, unknown> | null)?.[KEY] as HatsState | undefined) ?? null
}

export const hatsOptions = (payload: Payload) => payload.config.custom?.hats as ResolvedHatsOptions

export const newToken = () => randomBytes(32).toString('base64url')
export const hashToken = (token: string) => createHash('sha256').update(`hats:${token}`).digest('hex')

/** Runs `fn` with the request marked as the plugin's own, then puts the mark back as it was. */
export async function asPlugin<T>(req: PayloadRequest, fn: () => Promise<T>): Promise<T> {
  const before = req.context?.hatsInternal
  req.context = { ...(req.context ?? {}), hatsInternal: true }
  try {
    return await fn()
  } finally {
    req.context.hatsInternal = before
  }
}

export const idOf = (v: unknown) => String(v && typeof v === 'object' && 'id' in v ? (v as { id: unknown }).id : v)
export type { HatsUser }
