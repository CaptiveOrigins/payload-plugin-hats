import type { Payload, PayloadRequest, TypedUser } from 'payload'

/** One role an account can act in. `sensitive` hats need the second factor before switching into them. */
export type Hat = { id: string; label: string; sensitive?: boolean }

/** A user record as the plugin sees it. */
export type HatsUser = TypedUser & { id: string | number; email?: string | null; _sid?: string }

/** What the plugin knows about the request's session (also on `user._hats`, not enumerable). */
export type HatsState = {
  /** This session's Payload session id. */
  sid: string
  /** The hat worn, or null when the account wears all its roles (a plain sign-in). */
  hat: string | null
  /** The account that actually signed in, when this session was switched to from it. */
  via: string | null
  /** The linked set, when this session was switched into. */
  link: string | null
}

export type HatsOptions = {
  /** The auth collection. Default `users`. */
  users?: string
  /**
   * The hats an account can wear, narrowest first, from its own roles. An account with one hat (or none) has
   * nothing to switch between. The last hat is the account's full set of roles.
   */
  hatsOf: (user: HatsUser) => Hat[]
  /**
   * The user as seen while wearing `hat`: return a copy with roles narrowed, so every access rule that reads roles
   * from `req.user` follows the hat. Never add a role the user doesn't have: the plugin refuses a result that
   * offers a hat the account doesn't hold.
   */
  wear: (user: HatsUser, hat: string) => HatsUser
  /** Who approves link requests. Default: nobody, so linking stays off until the site says who. */
  canApproveLinks?: (args: { req: PayloadRequest; user: HatsUser }) => boolean | Promise<boolean>
  /** The site's second factor, asked before switching into a sensitive hat. */
  stepUp?: {
    /** Whether the account has a second factor set up at all. */
    available: (user: HatsUser) => boolean
    /** Check a code for `user`. Resolve true only for a good code. */
    verify: (args: { req: PayloadRequest; user: HatsUser; code: string }) => boolean | Promise<boolean>
    /** How long a good code is remembered, per account, in minutes. Default 180 (three hours). */
    rememberMinutes?: number
  }
  /**
   * Who sees the switch. Default: anyone whose own account, or another account in their linked set, has more than
   * one hat. Switching is refused where the switch isn't shown.
   */
  showSwitch?: (args: { user: HatsUser; hats: Hat[]; linked: { user: HatsUser; hats: Hat[] }[] }) => boolean
  /** A reason switching is refused right now (e.g. "Stop masquerading first."), or null. */
  blocked?: (req: PayloadRequest) => string | null | Promise<string | null>
  /** Most accounts in one linked set. Default 4. */
  maxLinked?: number
  /** Sends the link-confirmation email. Default: `payload.sendEmail`. */
  sendEmail?: (args: { payload: Payload; to: string; subject: string; text: string }) => Promise<unknown>
  /** The confirmation link for a token. Default: this site's `/api/hats/confirm?token=…`. */
  confirmURL?: (args: { req: PayloadRequest; token: string }) => string
  /** Called after anything the audit log should know: linking, approving, unlinking, switching, revoking. */
  onEvent?: (event: HatsEvent) => void | Promise<void>
  /** Put the switch in the admin header. Default true. */
  adminSwitch?: boolean
  /** Hours a confirmation link works. Default 24. */
  confirmHours?: number
}

export type HatsEvent =
  | { type: 'link-requested'; req: PayloadRequest; link: string; by: string; account: string }
  | { type: 'link-confirmed'; payload: Payload; link: string; account: string }
  | { type: 'link-approved'; req: PayloadRequest; link: string; account: string; by: string }
  | { type: 'unlinked'; payload: Payload; link: string; account: string; by: string | null }
  | { type: 'switched'; req: PayloadRequest; from: string; to: string; hat: string; via: string; steppedUp: boolean }
  | { type: 'sessions-revoked'; payload: Payload; sessions: number; reason: string }

export type ResolvedHatsOptions = Required<Omit<HatsOptions, 'stepUp' | 'canApproveLinks' | 'blocked' | 'onEvent' | 'confirmURL'>> &
  Pick<HatsOptions, 'stepUp' | 'canApproveLinks' | 'blocked' | 'onEvent' | 'confirmURL'>

export const LINKS = 'hat-links'
export const MEMBERS = 'hat-members'
export const SESSIONS = 'hat-sessions'
