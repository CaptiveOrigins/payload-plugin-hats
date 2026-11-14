# First-public-push audit

Run 2026-11-09 by the Web Platform session, before the repo goes public (per ~/Code/CLAUDE.md). Visibility is changed by the owner, not by this audit.

| Check | Result |
| --- | --- |
| Commit authors (all history) | Only the noreply address (11632652+mgilardi@users.noreply.github.com), 6 commits |
| Secrets in history (Stripe, AWS, GitHub, Slack, Resend keys, private keys, database URLs with passwords) | None found. The test secret `test-secret-not-for-production` and test passwords are made up |
| Email addresses in tracked files | Only `@example.invalid` test addresses, `someone@example.com` in a code comment, and the noreply addresses |
| Server addresses, IPs, private hosts | None. `site.example` and `localhost` in tests and defaults |
| Build output, dependencies, env files committed | None (`dist/`, `node_modules/`, `.env` are ignored) |
| Private terms (`scripts/leak-check.sh` locally, with ~/.leak-private-terms) | Passed |
| Leak check in CI | Yes, first step of `.github/workflows/ci.yml` |
| LICENSE | MIT, now "Copyright (c) 2026 EXTANT APE" (added in this audit) |
| `package.json` | `private` removed so it can be published; license, repository, homepage and `files` set |
| Release workflow and RELEASING.md | Added, the same as the other general Payload plugins |
| README status line says what has and hasn't been tested | Yes |
| Details of a real site | Removed from the current files in this audit (see below) |

## Finding: platform details in history

An early design-note commit described how one private site would wire the plugin. It named that site's private files and part of its security setup. The current files don't. No secret, address or personal detail was involved.

**Owner's choice, 2026-11-09 (Helm's chat): B, "fresh first commit".** The public history starts with one new commit of the current tree, made by the owner before the visibility change. The earlier history is kept only in a private backup, not on GitHub. The current files were checked again for this, this file included.

Result: clean. The finding is resolved by the fresh first commit.
