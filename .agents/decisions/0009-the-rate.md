# 9. Pace is use against time; the rate comes from the quota's own movement

Status: accepted, 2026-11-05. Records what pace does today.

## Context

A percent alone says nothing about whether a quota will last.

## Decision

- **The status.** A quota is under or over pace when its use is below or above the share of its window gone.
- **The rate level** (idle, steady, brisk, burst, too fast) comes from how fast the quota itself moves. `rateOf` in
  `model.ts` owns it, and every surface reads its verdict: the band, the status line, the pane, alerts, auto mode.
- **Projections:** when the quota runs out at the current rate, and what it will read at the reset.
- **Several quotas.** A weekly quota per model paces that model alone. The tightest quota decides the advice.

## Consequences

- One verdict per quota, the same on every host and surface.
