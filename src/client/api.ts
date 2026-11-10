/** What `GET /api/hats` answers, and the calls the components make. No Payload UI dependency, so a site can use them too. */
export type MenuHat = { id: string; label: string; sensitive?: boolean; needsCode: boolean }
export type HatsMenu =
  | { signedIn: false }
  | {
      signedIn: true
      account: { id: string | number; label: string }
      signedInAs: string
      hat: string | null
      hats: MenuHat[]
      linked: { id: string | number; label: string; hats: MenuHat[] }[]
      link: string | null
      set: { id: string | number; label: string; status: 'requested' | 'confirmed' | 'approved'; you: boolean }[]
      canLink: boolean
      showSwitch: boolean
      maxLinked: number
    }

export type Answer = { ok: boolean; status: number; message: string; reason?: string; needsCode?: boolean; body: Record<string, unknown> }

type Words = { offline: string; failed: string; reasons?: Partial<Record<string, string>> }

async function send(url: string, init?: RequestInit, words: Words = { offline: 'Couldn’t reach the site. Check your connection and try again.', failed: 'Something went wrong. Try again.' }): Promise<Answer> {
  try {
    const res = await fetch(url, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const errors = body.errors as { message?: string; data?: { reason?: string } }[] | undefined
    const reason = (errors?.[0]?.data?.reason ?? body.reason) as string | undefined
    // The site's own words for this reason, when it gave some; otherwise the server's English.
    const message = String((reason && words.reasons?.[reason]) ?? errors?.[0]?.message ?? body.message ?? (res.ok ? '' : words.failed))
    return { ok: res.ok, status: res.status, message, reason, needsCode: body.needsCode === true, body }
  } catch {
    return { ok: false, status: 0, message: words.offline, body: {} }
  }
}

export const hatsApi = (apiRoute = '/api', words?: Words) => ({
  menu: async () => (await send(`${apiRoute}/hats`, { cache: 'no-store' }, words)).body as HatsMenu,
  switchTo: (to: { account?: string | number; hat: string; code?: string }) => send(`${apiRoute}/hats/switch`, { method: 'POST', body: JSON.stringify(to) }, words),
  link: (email: string) => send(`${apiRoute}/hats/link`, { method: 'POST', body: JSON.stringify({ email }) }, words),
  unlink: (account: string | number) => send(`${apiRoute}/hats/unlink`, { method: 'POST', body: JSON.stringify({ account }) }, words),
})

/** Plain words for a member's status, for the account page. */
export const statusText = (status: string, you: boolean) =>
  status === 'approved'
    ? 'Linked'
    : status === 'confirmed'
      ? 'Confirmed. Waiting for an administrator to approve it.'
      : you
        ? 'Waiting for you to confirm from this account’s email.'
        : 'Waiting for its email to be confirmed.'

/** Every word the components show, so a site can pass its own translations. English by default. */
export const defaultText = {
  switchHint: 'switch account or role',
  switchGroup: 'Switch account or role',
  switchFallback: 'Switch',
  actAs: 'Act as',
  asksForCode: 'asks for a code',
  signedInAs: (signedIn: string, acting: string) => `Signed in as ${signedIn}, acting as ${acting}.`,
  codeLabel: (hat: string, account: string | null) =>
    account ? `To act as ${hat} on ${account}, enter a code from that account’s authenticator app.` : `To act as ${hat}, enter a code from your authenticator app.`,
  enterCode: 'Enter the code.',
  switchButton: 'Switch',
  back: 'Back',
  offline: 'Couldn’t reach the site. Check your connection and try again.',
  failed: 'Something went wrong. Try again.',
  linkedHeading: 'Linked accounts',
  linkedIntro: (max: number) =>
    `Link up to ${max} of your own accounts to switch between them without signing in again. Each keeps its own email and roles. Both emails confirm the link, then an administrator approves it.`,
  thisAccount: '(this account)',
  status: statusText,
  unlinkAsk: (label: string | null) => `Unlink ${label ?? 'this account'}?`,
  unlink: 'Unlink',
  unlinkNamed: (label: string) => `Unlink ${label}`,
  keep: 'Keep',
  setFull: 'This set has the most accounts it can hold.',
  emailLabel: 'Email of another account of yours',
  send: 'Send confirmation emails',
  youUnlinked: 'This account is no longer linked.',
  unlinked: 'Unlinked.',
  /**
   * Your words for the server's answers, by reason: signIn, blocked, notLinked, notAvailable, chooseHat,
   * noSecondFactor, setUpTwoStep, needsCode, wrongCode, linkingOff, enterEmail, setFull, linkSent, notInSet.
   * A reason left out shows the server's English.
   */
  reasons: {} as Partial<Record<string, string>>,
}
export type HatsText = typeof defaultText
