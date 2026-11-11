# Changelog

## Unreleased

- **`limit` and `blocked` fail closed.** `limit` must answer exactly `true` to allow a link request; any other truthy answer is now refused with `tooMany` (429), as a throw already was. A `blocked` that throws, or answers anything but a reason or `null`, now refuses switching, linking and unlinking with 409 `blocked` and a general reason. Before, a throw escaped as a 500. Tested: 26 tests (22 server, 4 client), 5 mutation checks.

## 0.1.3 (2026-11-10)

- **A session with nothing left to wear is signed out.** If a site's `hatsOf` gives an account no hats at all (for example, because the site disabled it), a session the plugin keeps a record for, one switched in from another account or one wearing a hat, is now revoked and signed out. Before, with no hat to narrow to, it was handed the account with every role. A plain sign-in with no record is unchanged: refusing a disabled account at sign-in is the site's job.

Tested: 22 tests (18 server, 4 client). The new test, which disables an account with a direct write so no hook runs, fails without the change.

## 0.1.2 (2026-11-10)

Security fixes from a review of 0.1.1.

- **A revoked session stays signed out.** Payload writes an account's whole list of sessions at once, so a sign-in at the same moment as a revocation could write the revoked session back. Its record had already been deleted, so it then looked like a plain sign-in with every role. Records are now kept, marked `revokedAt`, and a session with one is signed out (and taken off the account again). This covers unlinking, an approver's delete, a lost role, a deleted account, signing out, and the session left behind when switching accounts.
- **Old session records are cleaned up**, at most 50 per switch: only those that expired over a day ago and whose Payload session is gone, so a session Payload kept alive keeps its hat. `cleanupSessions` is exported for a site's own job.
- **`wear()` must narrow.** A `wear()` that returns the user object unchanged is refused, so a site's mistake can't quietly leave every role on.
- **`limit` option** for link requests, called with the acting account and the email. A no, or a limit that fails, refuses with `tooMany` (429) and sends nothing.

Tested: 21 tests (17 server, 4 client). The new tests include a revoked session written back into the account (it stays signed out; this test fails without the fix), clean-up keeping a refreshed session's record, the `wear()` guard, and the limit refusing (and failing closed). Not yet tried on a site.

## 0.1.1 (2026-11-10)

- **`stepUp.available` may be async.** A site's two-step state is often a hidden field that isn't on the signed-in user, so the check can now look it up. A false answer still refuses ("Set up two-step sign-in on that account first."). Sites that pass a plain boolean function need no change.

Tested: 17 tests; the step-up tests now run through an async check.

## 0.1.0 (2026-11-10)

First release: linked accounts, role hats with narrowing before `req.user`, step-up for sensitive hats, and revocation.
