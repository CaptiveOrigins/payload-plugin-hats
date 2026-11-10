# Changelog

## 0.1.1 (2026-11-10)

- **`stepUp.available` may be async.** A site's two-step state is often a hidden field that isn't on the signed-in user, so the check can now look it up. A false answer still refuses ("Set up two-step sign-in on that account first."). Sites that pass a plain boolean function need no change.

Tested: 17 tests; the step-up tests now run through an async check.

## 0.1.0 (2026-11-10)

First release: linked accounts, role hats with narrowing before `req.user`, step-up for sensitive hats, and revocation.
