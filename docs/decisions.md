# Decisions

Dated decisions for this repo, newest last.

- 2026-11-09: created from the ops starter kit, area `captive-origins`.
- 2026-11-09: design approved, with three additions that are now built and tested:
  1. **No self-approval.** An approver who is in the set, or who signed in as an account in it, is refused. The owner's own links need another approver.
  2. **Revocation is immediate.** Unlinking (self-serve), an approver deleting a row, an account losing a hat, or an account being deleted removes the Payload session of every session switched into or through it. The set is also re-checked on every request, so a switched session ends even if a revocation was missed.
  3. **Who sees the switch.** Only when the account, or another account in its set, has more than one hat. Where the switch isn't shown, switching is refused too.
- 2026-11-09: defaults: at most 4 accounts in a set; a second factor is remembered for 3 hours per account (`stepUp.rememberMinutes`); confirmation links last 24 hours.
- 2026-11-09 (build): **hat state lives on the server, not in a cookie.** The design note had a signed `hats-wearing` cookie. Built instead: a `hat-sessions` record keyed by Payload's session id. Nothing in the browser can be forged or deleted to change the hat, and revoking means removing Payload's own session.
- 2026-11-09 (build): **a plain sign-in wears all the account's roles**, as before the plugin. Hats narrow from there; switching back up into a sensitive hat asks for the second factor. A session switched into another account starts in the hat chosen at the switch. A stored hat the account no longer holds falls to the narrowest, never the widest.
- 2026-11-09 (build): **the second factor is the target account's.** Switching into account B's sensitive hat asks for B's code, remembered per account.
- 2026-11-09 (build): **approval uses Payload's own admin form.** Approvers set a confirmed row's status to Approved; a hook refuses every other change. Deleting the row unlinks.
- 2026-11-09 (build): **a link request never says whether the other account exists**, is already linked, or is the requester's own: the answer and status are always the same.
