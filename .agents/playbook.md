# The playbook: how a change to pace is made

The guardrails and the architecture are in [README.md](README.md); this is the order of work that keeps to them,
step by step. Each step names what to run and what it should show.

## 1. Look before changing

- **Read the data, not the code's opinion of it.** Measure what is on disk (`~/.local/state/pace/feeds/`, `log/`,
  `~/.claude/pace-state*.json`): sizes, counts, unique against total, the largest values. Write the analysis as a
  script in the scratchpad; print only the answer.
- **Reproduce a bug as a script first.** Call the core function with the shape the data has (five feeds carrying
  one copy each, say) and print what it returns. The script's output is the failing test's expected value.
- **Processes you start are yours to end.** No poll without a way out (`until … || <the thing is gone>`), no `find /`
  or other unbounded search; a background task gets a timeout. A leftover found later is traced to its parent
  (`ps -o ppid`) before it is killed: pace's own code or an agent's tool call.

## 2. Decide where the rule lives

- A rule (a merge, a level, a format, a fold) is a pure function in `core/`, with its unit test in `tests/`.
- I/O stays in the adapter of each host, and each host has its own I/O:

  | host | writes | reads |
  |---|---|---|
  | Claude Code | `hooks/register.tsx`, through `$.fs` (whole files only, no append, no delete: `$.process.run` for `mv`/`rm`) | same |
  | Codex, pi, ACP, Hermes, `bin/band.ts` | `adapters/log.ts` (`appendLog`, `writeFeed`, `pruneLog`) | `readFeeds`, `sessionFeeds`, `withHistory` |
  | Herdr mods | nothing | `adapters/herdr/log.ts` (`HerdrLog`), through `exec` and `readTextFile` |
  | Antigravity | its own history file, its feeds from it | `readFeeds` |

- A change to what is stored (a feed, the log, a checkpoint) is a decision: an ADR in `decisions/`, additive,
  read back safely from older data, and a line in `CHANGELOG.md` under *Unreleased*.

## 3. Red, green, on every host

- Red first, at the owner: the unit test for the rule, then the test that shows it where the user sees it (a
  `tests/claude/` integration test, a `*.node-test.ts` end to end in a scratch home, `scripts/herdr.ts check`).
- A stub that returns the wrong value makes the red an assertion, not an import error.
- A test whose premise the change retires on purpose (a feed that no longer carries history) is changed to read
  what the user sees through the new path, and the change says why. A test written after its code says so.
- Wire every host in the table above before calling it done; the checks under *Checks* in the README all pass.
  The Herdr core suite runs under a time budget: a failure there under heavy load is rerun before it is believed.

## 4. Never work anything out twice

Readers run in many copies (each Herdr pane, each session) and often (every event, every second). For anything
on a read path:

- **Measure the stages** on real data with a scratch script (`performance.now()` around read, parse, hydrate,
  draw), then profile the slow one: `node --cpu-prof --cpu-prof-dir=<scratch>`, and sum self time by function.
- **Read only what changed:** a log file on from its last offset (it only grows; a shorter read waits), a feed
  only once its size, time or text changed, a finished day once from its checkpoint.
- **Work out only what changed:** keep state in a `History` that recomputes a quota only when one of its parts
  changed, and returns the same objects otherwise. Key memos by object identity and versions, never by content
  you have to rebuild to compare.
- **Fold once:** what is final (a finished day) is folded and saved; what is folded is never folded again
  (`unionMax`, not `mergeSpend`, to join folded copies).
- **Draw only when something shown changed:** a view keeps the key of its inputs (feed identities, size, minute)
  and skips its steps when it is the same. A burst of changes is read once (a reload asked for while one runs
  runs once after it).
- Check the result with the same script: nothing new, one event on another quota, one on a busy quota, a minute
  later, an hour later.

## 5. Touching the user's data

- Back up first, into the scratchpad. Dry run with counts, then apply.
- Compare before and after per quota (readings, prompts, spend) and explain every difference.
- Data pace itself keeps (feeds, log) is migrated by a one-off script, not by product code.

## 6. Commit

- Commits wait for the user. Branch off `main` first.
- One commit for each concern. When a file holds two concerns, stage the first concern's version of it through the
  index (`git hash-object -w` and `git update-index --cacheinfo`), export the index (`git checkout-index -a
  --prefix=<scratch>/`) and run the checks there, so each commit stands alone.
- The message says why, with the numbers measured.
