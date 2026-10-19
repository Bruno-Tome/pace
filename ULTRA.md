# Ultra pace: a test run

A small real goal to watch ultra pace on: the plan, the work red first, a review, the check, the gear moving and a
fan-out. Start it with `/pace ultra ULTRA.md 30` and watch the band and the timeline.

## Goal
The plan sidebar's input handling is pure and tested, and the timeline's follow rule covers every plan shape.
Done when:
- `keyOf` (a key or an SGR wheel turn → a scroll key, null for anything else) lives in hooks/timeline.ts, with unit tests for the arrows, PgUp/PgDn, Home/End in both escape forms, j/k/g/G, space, the wheel both ways, and a key it ignores
- bin/plan-viewer.ts imports `keyOf` and parses no keys of its own
- `followOffset` and `nowRow` have tests for a plan with every step done, one with none done, and one shorter than the window
- `tsc`, `claude plugin validate .` and `claude plugin test .` pass
Check: `npx --yes -p typescript@5 tsc -p . && claude plugin validate . && claude plugin test .`

## Steps
- [x] Move `keyOf` into hooks/timeline.ts, red first: tests in a new tests/keys.test.ts for the arrows, PgUp/PgDn, Home/End in both escape forms, j/k/g/G, space, the SGR wheel both ways, and an ignored key (parallel)
- [x] Tests in a new tests/timeline.test.ts for `followOffset` and `nowRow`: a plan with every step done, one with none done, one shorter than the window; fix what they find in hooks/timeline.ts (parallel)
- [x] bin/plan-viewer.ts imports `keyOf` from hooks/timeline.ts and drops its own parsing; a smoke run of the sidebar still scrolls
- [x] Run the check, read every Done when line against the code, and claim the goal

## Revisions
- turn 1 · planned 4 steps: two independent ones marked (parallel), each with its own test file so they never touch the same file; the sidebar change waits on `keyOf`; the last step checks and claims
