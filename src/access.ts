/**
 * Only an answer of exactly `true` passes. Anything else is a no: `false`, a truthy value such as `1`, `'yes'` or
 * `{ valid: false }`, and an error thrown or rejected (so a broken check refuses with a 401 or 403, never a 500).
 */
export async function exactlyTrue(check: () => unknown): Promise<boolean> {
  try {
    return (await check()) === true
  } catch {
    return false
  }
}

/** Said when the site's `blocked` check fails or answers something other than a reason or null. */
export const CANT_CHECK = 'Switching isn’t available right now. Try again later.'

/**
 * The site's `blocked` answer as a refusal reason, or null to go ahead. Only `null` (or no answer, `undefined`) goes
 * ahead. A non-empty string is the site's own reason. Anything else, `''`, `false`, `1` or an object included, and an
 * error thrown or rejected, is still a refusal, with a general reason (so a broken check refuses with a 409, never a 500).
 */
export async function blockedBy(check: () => unknown): Promise<string | null> {
  try {
    const why = await check()
    if (why === null || why === undefined) return null
    return typeof why === 'string' && why.trim() ? why : CANT_CHECK
  } catch {
    return CANT_CHECK
  }
}
