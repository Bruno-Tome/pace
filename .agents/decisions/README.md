# Decisions

Each decision pace is built on, one file each. All are accepted (2026-11-05).
Number a new one after the last, and never rewrite an accepted one: supersede it with a new one that links back.

## What pace is

- [2. What pace is: subscription quotas paced against the clock](0002-what-pace-is.md)
- [4. Local only: no telemetry, nothing off the machine](0004-local-only.md)
- [5. `/pace` answers outside the conversation](0005-answers-off-the-transcript.md)

## How it is built

- [3. A pure core and thin adapters](0003-pure-core-thin-adapters.md)
- [6. Feeds: one file per session, one contract for every host](0006-feeds.md)
- [7. Shared data merges, never overwrites](0007-shared-store-merges.md)
- [14. One `/pace` grammar, read once for every host](0014-one-command-grammar.md)
- [16. Red before green, green on every host](0016-test-first-every-host.md)

## What it does

- [8. Real readings first; estimates are inferred from spend and marked](0008-readings-first-estimates-marked.md)
- [9. Pace is use against time; the rate comes from the quota's own movement](0009-the-rate.md)
- [10. The prompt cache is tracked, and kept warm on request](0010-prompt-cache-and-warm-mode.md)
- [11. On pace mode: spend less while a quota runs ahead](0011-on-pace-mode.md)
- [12. Auto mode: a checklist worked through at the quota's pace](0012-auto-mode.md)
- [13. Ultra pace: a goal, a plan pace owns, gears by headroom](0013-ultra-pace.md)
- [15. The fleet: every quota side by side, work sent where there is room](0015-the-fleet.md)

## Hosts

- [1. Herdr first: every command goes through Herdr, the harness's own UI is the fallback](0001-herdr-first.md) 
- [20. Antigravity, in its CLI](0020-antigravity-cli.md)
- [23. Hermes: one plugin for session mode and bot mode, the core in a Node bridge](0023-hermes.md)

## Being built

- [17. The quota is the unit: provider and account, shared by every harness](0017-quota-is-provider-and-account.md)
- [18. One stable core API: ports shaped like ACP](0018-core-api-acp-ports.md)
- [19. An ACP adapter: pace between any ACP client and any ACP agent](0019-acp-adapter.md)
- [21. Ultra pace's gears, per provider](0021-ultra-gears-per-provider.md)
- [22. The core draws for surfaces, not for harnesses](0022-surfaces-not-harnesses.md)
- [24. History in an append-only log, feeds back to live state](0024-append-only-log.md)
