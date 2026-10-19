# Ultra pace: a run in push

A run to watch ultra pace drive hard: five independent steps marked `(parallel)`, each with a test file of its own,
for the push gear to fan out to subagents. Start it with `/pace ultra ULTRA-PUSH.md 30` early in a 5-hour window,
while the band says the window is under pace. The gear starts in cruise and climbs to push on the second decision;
then the band goes gold, the bars crackle and the `▶` flickers.

## Goal
Every exported helper behind pace's text and gear has a direct unit test, and any bug those tests find is fixed.
Done when:
- tests/format.test.ts covers `formatDuration`, `clockAt` (quota.ts), `formatTokens` and `formatUsd` (cache.ts), edge values included (0, under a minute, over a day, a million tokens, under a cent)
- tests/quota-names.test.ts covers `drawsOn`, `isWeekly`, `isPerModel`, `theName` and `modelName`
- tests/gear-text.test.ts covers `notchName`, `gearText` and `startingGear`, for every notch and a model id as well as an alias
- tests/prompts.test.ts covers `workPrompt`, `reviewPrompt` (with and without a tail), `integratePrompt`, `verifyPrompt`, `closingPrompt` and `gearNote` (one subagent and several)
- tests/session-keys.test.ts covers `sessionKey`, `isSessionKey`, `sharedOf`, `sessionOf` and `isStale`
- every bug a new test found is fixed in the module it belongs to, and noted in CHANGELOG.md
Check: `npx --yes -p typescript@5 tsc -p . && claude plugin validate . && claude plugin test .`

## Steps
- [x] tests/format.test.ts for formatDuration, clockAt, formatTokens and formatUsd, edge values included; fix what it finds (parallel)
- [ ] tests/quota-names.test.ts for drawsOn, isWeekly, isPerModel, theName and modelName; fix what it finds (parallel)
- [ ] tests/gear-text.test.ts for notchName, gearText and startingGear, every notch, an id and an alias; fix what it finds (parallel)
- [ ] tests/prompts.test.ts for ultra pace's prompt builders and gearNote; fix what it finds (parallel)
- [ ] tests/session-keys.test.ts for sessionKey, isSessionKey, sharedOf, sessionOf and isStale; fix what it finds (parallel)
- [ ] Integrate the subagents' reports, note any fixed bug in CHANGELOG.md, run the check and claim the goal

## Revisions
- turn 0 · written by hand for a push run: five independent steps, each in a file of its own, then one to integrate and check
- turn 1 · kept the 6 steps as written: each parallel step names its own new test file and the module it may fix, so subagents never share a file; the integrate step owns CHANGELOG.md, so no subagent edits it
- turn 2 · format tests found 3 bugs, fixed: under a minute read "0m" (now "<1m"), 999.6k tokens read "1000k" (now "1M"), $0 read "<$0.01" (now "$0.00")
