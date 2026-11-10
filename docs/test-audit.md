# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

## 2026-11-09: server side built

All in `test/hats.test.ts`, against a real Payload 3.92 on an in-memory MongoDB replica set, with a made-up role ladder and a fake second factor.

| Promise | Test |
| --- | --- |
| A hat narrows `req.user` for the Local API, REST and GraphQL | "starts in every role…", "narrows the user REST and GraphQL requests are built with" |
| Whitehat canary: an administrator wearing Member reads no admin-only records | "starts in every role…" |
| Hat state never appears in a response | "starts in every role…" |
| Switching up needs the second factor; a wrong code is refused; a good one is remembered, then asked again after 3 hours | "asks for the second factor…" |
| No second factor, no sensitive hat; no hat the account doesn't hold | "refuses a sensitive hat…" |
| A missing or stale hat falls to the narrowest; `wear()` can't widen or keep a sensitive hat | "falls to the narrowest hat…" |
| The switch is hidden and refused where there's nothing to switch to; refused while masquerading | "hides the switch…" |
| Both emails confirmed, approver outside the set, tokens single-use, mail scanners confirm nothing, rows can't be rewritten | "needs both emails confirmed…" |
| Expired links refused; a request reveals nothing about other accounts | "refuses an expired link…" |
| At most 4 accounts, one set per account | "holds at most four accounts…" |
| Switching only within an approved set; the old session ends; the target's own code; credit goes to the target | "switches within an approved set…", "refuses accounts outside the set…" |
| Revocation on unlink, an approver's delete, a lost role, and a missing membership | "ends switched sessions…" |
| Events for the audit log | "records who did what…" |

- Gaps skipped: an account deleted while switched into (same revoke path as a lost role, covered there); logout cleanup of the session record (housekeeping, nothing to leak).
- Client (`test/client.test.ts`): the calls read Payload's error shape and the plugin's own, ask for a code when told to, and say plainly when the site can't be reached; status wording. The set shown to a requester hides an account nobody has confirmed (in "refuses an expired link…").
- Browser pass, 2026-11-09, a local copy of a real site with made-up accounts (Playwright + axe, WCAG 2.2 AA tags):
  - Keyboard open, Escape back to the button, Tab through choices.
  - Switch to a linked account. Wrong code refused; a real TOTP code accepted.
  - Linking section in light and dark. Approval through Payload's form sets Approved By.
  - axe: 0 on the plugin's parts. Fixed on the way: dark-mode contrast, the code wording when acting through another account, the panel's wrapping in the admin header, and a readable set title instead of an id.
  - Payload's own form widgets (react-select, date picker, field descriptions) show axe findings on every collection; not ours.
- Not tested: a real screen reader, real email delivery.
