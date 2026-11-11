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
