# 2. What pace is: subscription quotas paced against the clock

Status: accepted, 2026-11-05. Records what pace does today.

## Context

Coding agents on a subscription (Claude, ChatGPT, Google) spend quotas measured in rolling windows: a 5-hour window
and a weekly one, sometimes a weekly one per model. A quota spent too early stops the agent until the window resets.
The harnesses show a percent at best. None show how fast it is moving, or whether it will last until the reset.

## Decision

pace sets each quota against the clock and keeps the work on pace:

- **It shows.** Each quota's use against the share of its window gone (under or over pace), the rate it moves at,
  when it runs out at that rate, and what it will read at the reset. It also shows each prompt's price and the
  prompt cache's timer.
- **It acts, only when asked.** On pace mode, warm mode, auto mode and ultra pace change how the agent works so a
  long run lasts. Each one is turned on per session, by `/pace`.
- **It covers every harness the user runs.** Claude Code first, then Codex, pi and Antigravity, with Herdr as the
  terminal that wraps them all. The fleet sets them side by side.

pace is not a billing tool, a cloud service or an API-key cost tracker. A session on an API key spends no quota,
so pace writes nothing for it.

## Consequences

- Every feature answers one question: does this help the quota last until its reset?
- A harness counts as supported when pace can read or infer its quotas. Drawing in its UI comes second.
