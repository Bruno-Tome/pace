# 8. Real readings first; estimates are inferred from spend and marked

Status: accepted, 2026-11-05. Records what pace does today.

## Context

Claude Code reads the usage endpoint, and Codex writes its limits to the rollout. pi on a ChatGPT sign-in is told
nothing of its quotas, and it has to stand alone.

## Decision

- A real reading always wins over an estimate while it is fresh (10 minutes).
- Without readings, a window opens with the first activity after the last window ended. Its use is the spend in it
  divided by the window's capacity in dollars (`core/estimate.ts`).
- The capacity is learned from a usage-limit error (the window held what was spent in it), or from real readings of
  the same quota (`quotaPerDollar`).
- Until a capacity is known, pace shows spend only: dollars, dollars an hour and the reset.
- An estimate carries `estimated: true` and shows with a `~`. No rule learns from an estimate.

## Consequences

- An estimate is only as good as its capacity. Real readings of the same account calibrate it best, which
  [0017](0017-quota-is-provider-and-account.md) makes possible across harnesses.
