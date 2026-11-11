# payload-plugin-hats

Linked accounts and role hats for Payload. One person links their accounts and switches between them, and an account with several roles acts in one at a time. Switching up into a sensitive role asks for a second factor.

**Status:** early, 0.x. The server side passes 20 tests against a real Payload 3.92 and MongoDB, with made-up roles and a fake second factor. The two React components were tried in a browser on a local copy of a real site (2026-11-09) with made-up accounts: keyboard, a real authenticator code, the approval form, and axe with 0 findings on the switch, the code prompt and the linking section in light and dark. It isn't in use on any site yet.

## What it does

- **Linked accounts.** Up to 4 accounts per person. Linking needs both emails confirmed and an approver who isn't in the set. Unlinking is self-serve and immediate.
- **Hats.** Wearing a hat narrows the user before `req.user` exists, so every access rule follows it: admin, REST, GraphQL and the Local API with `req`. If narrowing fails, the request is signed out, never given full roles.
- **Step-up.** Switching into a sensitive hat asks for that account's second factor, remembered for 3 hours per account.
- **Revocation.** Unlinking, deleting a row, losing a role or deleting an account ends every session switched into or through it. Switched sessions also re-check their set on every request. An ended session's record is kept, marked revoked, so a session that Payload writes back by accident (two writes to an account's sessions at once) stays signed out. Old records are deleted once their Payload session is gone, at most 50 per switch.
- **Link limits.** Pass `limit` to rate-limit link requests, per person and per email address. When it says no, or fails, the request is refused with `tooMany` and nothing is sent.

Needs Payload sessions (`auth.useSessions`, on by default).

## On its own, and with others

**On its own:** it needs a users auth collection with Payload sessions, plus your `hatsOf` and `wear`, built from the roles you already have. Linking stays off until you set `canApproveLinks`, and switching into a sensitive hat is refused until you give it a `stepUp`.

**Only `true` counts.** `canApproveLinks`, `stepUp.available` and `stepUp.verify` must answer exactly `true` (or a promise of it). Anything else is a no: `false`, `1`, `'yes'`, an object such as `{ valid: false }`, or an error thrown or rejected. A refused step-up answers 403 (`setUpTwoStep` or `wrongCode`) and a refused approval 403, never a 500. If your verifier returns a result object, pass its flag: `verify: async (a) => (await check(a)).valid === true`.

**Works with:**
- **MFA:** MFA's `isOnFor` and `verify` make the `stepUp`. MFA's README has the two lines.
- **Masq:** your `blocked(req)` can refuse switching while masquerading, using Masq's `masqStateOf`. Masq's `canMasquerade` should refuse a switched session, using `hatsStateOf(user).via`.
- **Guardians:** Hats can be the switcher behind Guardians' required `actingFor`, so a guardian who switched into a kid's account is still seen as the guardian.
- **Audit Trail:** pass `onEvent` through Audit Trail's `fromPluginEvent`, and use `hatsStateOf(req)` in its `via`, so an entry says which account signed in and which hat was worn.

None of these are imported. The site connects them in its own config.

**Family:** It's part of the **Identity** family (a working draft): plugins designed to sit together for accounts and access.

## Use

```ts
import { hats } from '@captiveorigins/payload-plugin-hats'

hats({
  hatsOf: (user) => [{ id: 'member', label: 'Member' }, { id: 'admin', label: 'Administrator', sensitive: true }],
  wear: (user, hat) => ({ ...user, roles: hat === 'admin' ? user.roles : ['member'] }),
  canApproveLinks: ({ user }) => user.roles.includes('admin'),
  stepUp: { available: (user) => hasAuthenticator(user), verify: ({ user, code }) => checkCode(user, code) },
  limit: ({ user, email }) => allowAttempt('hatsLink', `${user.id}:${email}`), // optional
})
```

`wear` must return a narrowed copy of the user, never the user itself: Hats refuses the request if it gets the same object back, if a hat adds one the account doesn't hold, or if an ordinary hat keeps a sensitive one.

Endpoints, under the API route:

- `GET /hats` lists the acting account, its hats and its linked accounts.
- `POST /hats/switch { account?, hat, code? }` switches hat or account.
- `POST /hats/link { email }` asks to link another account.
- `GET` and `POST /hats/confirm` handle the email confirmation.
- `POST /hats/unlink { account? }` takes an account out of the set.

Approvers approve in the admin, under Accounts → Linked accounts.

The switch goes in the admin header (turn it off with `adminSwitch: false`). For a site's own pages, `@captiveorigins/payload-plugin-hats/client` has `HatSwitcher` for the header and `LinkedAccounts` for the account page. They need no Payload UI package. By default they take the surrounding text color, and they follow `--hats-ink`, `--hats-paper`, `--hats-line`, `--hats-muted` and `--hats-focus` if you set them.

Every word is replaceable for translation: pass `text` (see `defaultText`). Server answers carry a stable `reason` (for example `wrongCode`), and `text.reasons` gives your words for each; anything you leave out shows the English.

## Commands

```bash
npm test          # Vitest, in-memory MongoDB
npm run typecheck
npm run build
```

## License

MIT. See `LICENSE`.
