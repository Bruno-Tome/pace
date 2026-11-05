# 17. The quota is the unit: provider and account, shared by every harness

Status: accepted, 2026-11-05. Being built.

## Context

- Today, windows, prompts and spend are shared within a harness. Claude Code's store covers its own sessions, Codex's
  hook merges Codex's sessions, and pi merges pi's.
- Yet Claude Code and pi on one Claude sign-in spend the same quota, and so do Codex and pi on one ChatGPT sign-in.
  Each harness sees only part of the rate.
- A user may also hold several accounts with one provider, such as a personal and a team ChatGPT. Those are separate
  quotas, and pace merges them today.

## Decision

- **A quota is `provider/account`.** Every feed names the account it spends (`account`, additive). Each adapter
  detects the account from its harness's own sign-in:

  | Host | Where the account comes from |
  | --- | --- |
  | Claude Code | `~/.claude.json`, `oauthAccount.emailAddress` |
  | Codex | `~/.codex/auth.json`, the `email` claim of `tokens.id_token` |
  | pi | its OAuth token's email where it carries one; on ChatGPT it carries none (see below) |
  | Antigravity / Gemini | `~/.gemini/google_accounts.json`, `active` |

- **The account is a keyed hash of the sign-in's email.** Every adapter hashes the email its harness signed in
  with (trimmed, lower-cased) with one key: HMAC-SHA-256 under a random key pace makes once,
  `~/.local/state/pace/key` (mode 600), and keeps the first 16 hex digits. The same email gives the same id in
  every harness, so a Claude Code and a pi session on one account meet with no question asked. The email, the
  token and the key never go in a feed, a view or a log; without the key the id can't be traced back to the email.
- **Accounts are listed by number and id:** `Codex account 1 · 1233ab…`. The number is the order pace first saw the
  account in, kept with the key.
- **Every harness on one quota shares its windows.** Readings, prompts and spend pool per quota in
  `~/.local/state/pace/quotas/<provider>-<account>.json`, merged free of order and only growing
  ([0007](0007-shared-store-merges.md)).
  - A Claude Code reading paces pi's sessions on the same account.
  - pi's spend counts toward the rate Claude Code shows.
  - An estimate ([0008](0008-readings-first-estimates-marked.md)) is calibrated by real readings of its own account
    only.
- **Switching accounts is seamless.** When a harness's active account changes, its next samples go to the new quota,
  and the old quota keeps its history. The fleet shows one row per quota, and Send work picks the account with the
  most room.
- **When the account is unknown,** the feed leaves `account` out and pools by provider, as it does today. Old feeds
  read the same way.

## Consequences

- `fleetOf`, the pi estimate and the Codex sibling merge key on the quota instead of the provider.
- The per-harness merges in the writers become one shared quota store.
- pi on ChatGPT: its token names no email. When exactly one account of the provider is known on the machine, pi's
  sessions join it; otherwise they pool by provider, as before. Never a question to the user.
