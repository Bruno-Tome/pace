# Changelog

## Unreleased

- **Nothing worked out twice.** A finished day is folded once into a checkpoint (`log/<day>/checkpoint.json`); readers
  keep a `History` that reads only what the log added and works out only the quotas it touched, giving back the same
  feeds when nothing changed. Feeds are parsed again only when they change. The Herdr mods read a burst of changes
  once and draw a view again only when what it shows changed. Measured on 2026-11-06: a reader's pass over the feeds
  and the log went from about 75 ms each time to 0.4 ms with nothing new, 0.4 ms for a prompt on another quota and
  5 ms for one on a busy quota.
- **History moves to an append-only log** ([ADR 0024](.agents/decisions/0024-append-only-log.md)). Each session
  appends the readings, prompts and costs it saw itself to `~/.local/state/pace/log/<day>/<host>-<session>.jsonl`, a
  line an event; feeds are written slim (their `samples` and `prompts` empty, no `spend` or `modelPrompts`), and every
  reader hydrates them from the log (`core/log.ts`). Measured on 2026-11-06: 6.4 MB of feeds held 572 KB of history,
  each reading copied 24 times, each feed of about 200 KB written whole at every event. Feeds written before this still
  count while they last. Eight days are kept; the day folders and feeds older than that are deleted, at most once a
  day. Antigravity still writes its feeds from its own history file, which they carry; readers count it the same way.
- **Spend no longer compounds across feeds.** Merging every feed's copy of the spend as one list summed the copies,
  so each merge multiplied the spend by the number of feeds (seen at up to 1.8e308 dollars a bucket). Copies merge a
  pair at a time (`mergeCopies`), and a bucket past $10,000 is dropped before it can win a merge.
- The fleet's Send work opens as a pane too (**in a pane**, beside **Send work ⇥**): it stays open, follows the fleet
  live and clears for the next task once an agent starts. The pane is recorded under Herdr's shared `fleet.panes`, so
  a second click focuses it. The popup is as before.
- From the review by four agents on four accounts (`.agents/review-2026-11-05.md`):
  - Metering keeps each account's readings its own. `meter` takes readings only from feeds of the session's account,
    and from none while a session that cannot tell has two accounts on its provider. Prompts and spend still pool.
    The adapters' own guards are gone.
  - Claude Code pools the prompts and spend of the other harnesses on its Claude account into its snapshot
    (`pooled`, reading the feeds at most once a minute).
  - A turn count past 10,000 is refused (`MAX_TURNS`), so auto mode always stops.
  - Hosts declare the modes they keep (`Host.keeps`, additive), so `/pace on` over ACP no longer claims a mode that
    nothing runs. A host that can neither ping nor compact says warm mode is not there, instead of pointing in a
    circle.
  - `pace-acp` meters sessions the client loads or resumes, and refuses a host or provider no reader accepts.
  - Hermes keeps one feed file per session and quota, and tells a restarted bridge its sessions again.
  - Making pace's key and numbering accounts is safe in parallel processes.
  - Antigravity's per-model quotas are named as Antigravity's ("Claude Opus 4.6 (Antigravity)").

- Fixes from the live test of every harness (`.agents/live-test.md`):
  - Antigravity's plugin ships a `pace` skill, so `agy` knows `/pace` and never completes it to another skill. The
    hook reads `/pace:pace` as `/pace`.
  - A Herdr chart pane is keyed by provider and account (`HerdrView.account`, additive), so two accounts of one
    provider no longer share a pane.
  - A session that cannot tell its account (pi on ChatGPT) learns from no other account's feeds once its provider
    has two here (`learnsFrom`).

- Hermes Agent (ADR 0023): `'hermes'` is a host (additive). A Python plugin (`adapters/hermes/plugin`, installed by
  `node scripts/hermes.ts install`) runs in `hermes chat` and in the messaging gateway, and hands its events to a Node
  bridge (`bin/pace-hermes.ts`) that runs the core. Each provider call's tokens, cache and context come from
  `post_api_request`, and the account's real windows from Hermes's `fetch_account_usage` (`adapters/hermes/events.ts`
  maps them). `/pace` is answered in place, in the session or the chat. Auto mode's prompts go into the same session or
  chat. A bot has its chat alone, so every view is drawn into it. `adapters/views.ts` is the view-opening shared by the
  two Node bridges. The plugin also handles:
  - Background calls (`post_auxiliary_call`) and subagents' calls are their session's, with no prompt counted, and
    `/pace` keeps its session.
  - A session moving between Claude and ChatGPT keeps a history on each.
  - A pooled credential names its account (`adapters/account.ts`, `accountForIdentity`). It is Codex's own account
    when Codex is signed in here on it.

- Ultra pace's gears on every provider (ADR 0021, `core/gears.ts`): a ladder of the models and thinking levels a host
  offers, ranked lightest first by the provider's families. `core/throttle.ts` picks the notch on any ladder (Claude's
  by default, so Claude Code's gears are unchanged); `startGears` and `shiftGears` run a plan with gears on a host other
  than Claude Code. `/pace ultra` now runs in pi (`pi.setModel`, `pi.setThinkingLevel`) and over ACP
  (`session/set_config_option` on the agent's `model` and `thought_level` options): the plan as auto mode, a gear shift
  at every turn's end. The goal-owned plan, its check and fan-out stay Claude Code's. Contract, additive:
  `PaceAuto.gears` (`PaceGears`), and `PaceGear.effort` widened to any host's thinking level.
- Antigravity installed here: the plugin in `~/.gemini/config/plugins/pace`, and an `agy` shell function in
  `~/.zshrc` that starts it with a CSRF token of its own.

- The core's API (`core/api.ts`, ADRs 0018 and 0022): a host declares its surfaces (Herdr, a split, a window, a pane,
  an overlay, the band, the status line, toasts, an answer) and what pace can do to its agent; `route()` decides what
  each `/pace` command comes to there, `stepOf()` what auto mode's decision does, `warmStep()` warm mode's, and
  `viewLines()` draws any view for any surface. Codex, pi, Antigravity and Claude Code all route through it;
  `adapters/codex/commands.ts`, `piAction`, `piStep`, `piWarm` and `agyAction` are gone, their tests moved to
  `tests/api.test.ts`. Small changes on the way: pi's `/pace split` shows the charts in tmux (it showed the band), the
  status-line answer says "status line" on every host, the in-place band's answer says Herdr can open it, and Claude
  Code's `/pace band` outside Herdr says the band is above the prompt.
- Metering is one rule (`core/meter.ts`): every host's feed is built from what it metered, merged with every live
  feed on its quota, real readings only. pi's spend now counts with every harness's on its quota.
- Accounts (ADR 0017): `PaceFeed.account`, additive, a keyed hash of the sign-in's email (`core/account.ts`; the key
  in `~/.local/state/pace/key`, mode 600; accounts numbered in `accounts.json`, ids only). Claude Code, Codex, pi and
  Antigravity name theirs; pi on ChatGPT, whose token names no email, joins the one account its provider has here.
  The fleet has one row per quota, `Codex account 1 · 1233ab…`; `FleetRow` gains `account` and `name`,
  `FleetMember` gains `session`.
- Antigravity is a host and a provider (`'antigravity'` in `PaceHost` and `PaceProvider`), with a 5-hour window per
  model (`five_hour_<model>`). Its CLI (`agy` 1.5.1, verified live): the language server runs inside `agy`, whose
  CSRF token comes from `ANTIGRAVITY_CSRF_TOKEN`; the hook finds it there, asks over HTTP then HTTPS, and answers
  `/pace` as the message of the turn it ends rather than in a macOS notification.
- The ACP proxy (`bin/pace-acp.ts`, `adapters/acp/proxy.ts`, ADR 0019): `pace-acp -- <agent>` passes every message
  through, meters prompts, cost (`usage_update`) and context into the feed, answers `/pace` without the agent seeing
  it, adds `/pace` to the agent's commands, and runs auto mode by sending the agent its next prompt. Under `agy acp` it
  starts the agent with a token of its own and reads its quotas.

- pi: `adapters/pi/extension.ts`, a pi extension (`node scripts/pi.ts install`) that writes the session's feed
  (`host: 'pi'`) and draws the band above pi's editor and the quotas in its footer. A session paces the quota of its
  subscription sign-in, ChatGPT's as Codex's and Claude's as Claude's; on an API key it writes nothing. pi is told no
  readings, so they are estimated from its spend (`core/estimate.ts`): a window's spend over what it holds, learned
  from a usage limit reached or a live feed's real readings. Until then the band shows each window's spend.
- pi: `/pace` is a pi command (`adapters/pi/commands.ts` decides, the extension carries it out): the views in Herdr,
  the charts or the fleet over pi, the band in a tmux split, `hide`/`show`, `line on`/`off`, `refresh` and on pace
  mode, which lowers pi's thinking level one step for a run while the rate would gas a quota out. Warnings are said
  once per window. Auto mode, ultra pace and the plan's timeline say they are not in pi yet.
- pi: its prompt cache, read from each reply's cache tokens with an hour's TTL; on pace mode compacts a heavy context
  while the cache is warm and keeps a large idle one warm; `/pace warm compact`. Auto mode (`auto`, `off`, `resume`,
  `burst`): the instructions in the system prompt, each next prompt sent after a run, holds on pi's clock, a handoff
  compacting. The plan's timeline in a tmux split or over pi. Ultra pace says it is not in pi yet.
- `resumed()`, a run picked back up with more turns when it ran out, is the core's (`core/auto.ts`), shared by Codex and
  pi.
- Herdr first: in Herdr every `/pace` view opens there first, `pane` and `window` too, and falls back to the harness's
  own when Herdr cannot (`.agents/decisions/0001-herdr-first.md`). Claude Code's `/pace pane` and `/pace window` in
  Herdr now open the charts in a Herdr pane.
- Codex: every `/pace` command. Views open in Herdr first, else in a tmux split or a macOS window, else drawn into the
  answer (`bin/band.ts --pane` draws the charts); the plan's timeline likewise. Auto mode runs through the hooks:
  the prompt goes on with auto mode's instructions, the Stop hook sends each next prompt, waits out a hold of up to
  nine minutes and pauses a longer one, and an Interrupt hook pauses the run. Ultra pace, on pace mode, warm mode and
  the band's preferences say why Codex's hooks cannot run them. Warnings show in Codex's UI once per window. The
  Stop hook now runs synchronously with a 600-second timeout, and an Interrupt hook is added: update
  `~/.codex/config.toml` from the README. A `/pace` prompt with arguments pace does not know is answered with what
  `/pace` takes rather than sent to the model, as in Claude Code.
- `/pace`'s arguments are read once for every host, `core/command.ts`; Claude Code's `/pace` reads them there, its
  behavior unchanged.
- Contract, additive: `PaceHost` adds `'pi'`; `PaceReading` adds `estimated?: true`, which the band and the status
  line mark with `~`; a feed's snapshot adds `estimated?: true` for a host that estimates its quotas. Older feeds
  read as before.
- The fleet counts an agent under the provider its feed names, so a pi agent signed in with ChatGPT counts under
  Codex. The Codex hook carries the prompts of every live feed on Codex's quota, pi's too, not only Codex's.
- The fleet lists what is running: a terminal that ran two sessions shows its newest, and in Herdr an agent whose
  terminal is gone is left out rather than listed as idle. The Herdr panel says how old its figures are once they
  are a minute old, a failed claim of its pane no longer stops it drawing, and a failed watch of the feeds is tried
  again instead of given up on.
- Herdr: a second mod, `fleet`, built by the same `node scripts/herdr.ts install`. It joins every agent Herdr runs to
  pace's and ql's feeds by terminal, and shows them by provider, by repo (two agents on one tree flagged) or by
  urgency, with the provider to send work to and why. **Send work ⇥** starts `claude` or `codex --no-daemon` with a
  task in a new tab, after asking once more. The model and its drawing are `core/fleet.ts`; `scripts/herdr.ts`
  builds and checks every mod in its `MODS` table.
- pace runs beyond Claude Code. Every session writes a feed, `~/.local/state/pace/feeds/<host>-<session>.json`
  (a `PaceFeed`, version 1: host, provider, session, Herdr terminal when there is one, folder, time, snapshot and
  context use), written aside then moved into place, whenever it changes and once a minute to stay live. Feeds are read
  defensively and dropped after 6 hours without a write.
- Codex CLI: `adapters/codex/hook.ts`, a Codex hook for `SessionStart`, `UserPromptSubmit`, `PostToolUse` and
  `Stop`, reads the session's rollout on from where it left off and writes the session's feed. Its readings are
  Codex's `codex` rate limit (`primary` the 5-hour window, `secondary` the week); the `premium` limit Codex
  0.153–0.155 wrote with no windows is skipped. The README has the config to add; pace never writes Codex's
  config itself.
- `bin/band.ts`: the band, live, in any terminal, for the newest feed, a Herdr terminal's agent or a feed file; or
  `--fleet`, every provider's quotas with the agents on each.
- Herdr: a mod (`node scripts/herdr.ts install`) with the fleet, every provider ordered by the room its quotas leave,
  and the agents on each, a line each with Herdr's status of their terminal; click an agent to go to it. `band ⇥`
  opens the agent's band in a Herdr pane under it, and `charts ⇥` the harness's `/pace` pane, charted from all its
  live sessions together.
  The mod draws whichever view its pane's props ask for.
- `/pace` in Herdr opens pace in a Herdr pane beside the session, ahead of tmux: the harness's charts, or with
  `band` the session's band and with `fleet` the fleet. In Claude Code `/pace` does it; in Codex the hook catches a
  `/pace` prompt (sent by the custom prompt `adapters/codex/pace.md`, `/prompts:pace`), opens the view and blocks
  the prompt before the model. A `/pace` prompt is not counted as a prompt. In Codex, `node scripts/codex.ts
  install` adds `/prompts:pace` and the skill `$pace`; the hook catches `$pace` too, and the skill falls back to
  running `node adapters/codex/open.ts` when the hook is not trusted. A view already open is focused rather
  than opened again: each pace pane records its view under its pane in Herdr's shared state, `pace.panes`.
- Herdr's panes no longer open empty. Drawing every session's week of history ran past the time Herdr gives a
  mod for one call, and Herdr kept the empty first frame. A feed now carries its harness's whole history (the
  Codex hook merges the other live Codex sessions'), so the fleet takes the session with the newest reading
  rather than merge eleven copies of one history; the mod draws in steps, one call each; and a quota's price is
  worked out in one pass over the spend. `node scripts/herdr.ts check` now checks each step on a week of feeds.
- In Herdr a bar is drawn as blocks exactly its columns wide: `█` and `░` come from a fallback font wider than the
  panel's columns, which pushed the rate off the right edge.
- Herdr's panes fit their room: rows as tight as a terminal's, so a chart's braille rows meet, and the charts
  grow to fill the pane's height as Claude Code's docked pane does. The rule moved to `fittedLayout` in
  `core/view.ts`, which both use.
- A host with no prompt cache (Codex) gets no cache row on its band: the core `Snapshot` gains `noCache`.
- The pure core moved from `hooks/` to `core/`; Claude Code's usage parsers are `hooks/usage.ts`. No change for
  the user.
- The core suite also runs on Node (`testing/node.ts`) and inside Herdr's runtime (`node scripts/herdr.ts check`).
  Tests that need Claude Code's engine are in `tests/claude/`.
- Merging readings no longer slows with their number: each set of quotas' last reading is kept by key rather than
  searched for.
- The split comes to the Claude desktop app. There `/pace` (and `/pace split`, which no longer answers "Not
  inside tmux") opens a pane that is the split: its title and run, the `on` / `off` / `do` command bar as native
  buttons lit while on, each key its hotkey, and the body under it. `auto…`, `ultra…` and `plan…` show a list of
  the plans the session knows and a path field; a digit button per quota draws it alone. VS Code draws the same;
  the terminal and mobile keep the pane as it was. New state value `pace.splitUi` (what the buttons chose),
  empty at first. `view.ts` gains `splitParts` and `picked`; `screenOf` draws what it did.
  Its lines are drawn in the desktop's monospace face, and each chart is an SVG instead of braille rows: usage as
  a filled area with a point at every reading, even pace and the projection dashed, a mark at now, at a height of
  its own (braille in the desktop's font lost its dots and stretched its rows). `chart.ts` gains `chartSvg`; a
  `Seg` may carry an `svg` picture, which a surface without SVG draws as nothing.
- Each session feeds its own split. The window's state, keys and launcher were one set of files every session
  shared, so a split showed whichever session wrote last (another project's roadmap) and a button pressed in one
  split ran in every session feeding one. They are now `~/.claude/pace-state-<session>.json`,
  `pace-keys-<session>.json` and `pace-view-<session>.command`; the shared files are no longer written or read.
  A split opened before this change keeps reading the old file: close it and open it again.
- The split's command bar sits under the title, and each button is lit while what it flips is on (`[p] on pace`,
  `[w] warm compact`, `[b] band`, `[l] status line`, `[a] auto`, `[u] ultra`, `[s] burst`); the row of modes spelled
  out above the charts is gone. The body under the bar scrolls (↑ ↓, PgUp PgDn, the mouse wheel) instead of
  squeezing to fit: a plan no longer shrinks the charts, which keep at least 6 rows, and the last row says how
  much is left below.
- The split names its own keys where it used to name `/pace` commands: the run row under the title ends `[a] off`,
  `[u] off`, `[a] resume` or `[p] off`, warm mode reads `[w] steps it`, and with no usage yet `press r`. The pane
  inside Claude Code still names the commands.
- The split's command bar is three rows: `on`, the modes that are on with their keys (`nothing` when none is);
  `off`, the ones you can turn on; `do`, the rest. Every `/pace` command now has a key: `[f] plan…` picks the
  plan whose timeline shows, `[i]` opens the pane, `[m]` the window, and a paused run gains `[x] stop` beside
  `[a] resume`. Warm mode's button reads `[w] warm` while off, not `warm off`. `UiState.picking` gains `plan`.
- The split is the whole mod in one view. A modes block at the top says what is on (on pace mode, warm mode, the
  band, the status line) and shows the run under way: its plan and turn, and under ultra pace its goal, gear,
  phase and check. Two plans draw side by side on a wide split, as the plan sidebar does. A command bar at the
  bottom offers every `/pace` command as a button, by key or by click: `[a] auto…` and `[u] ultra…` pick a plan
  from those the session knows (`t` types a path), and while a run is on the bar offers `auto off`, `burst`,
  `resume` or `ultra off`; `[p]` `[w]` `[b]` `[l]` flip on pace mode, warm mode, the band and the status line.
  `[t] timeline` (`/pace timeline`) opens the plans' timelines in a second split carved under the Pace split, and
  closes it again; quitting the split closes it too (the viewer sends `close`).
  The answer shows under the title for 10 seconds. The window's keys file now carries any `/pace` argument
  (`warm` alone still steps warm mode); the feed gains `also`, `prefs`, `known` and `notice`, all optional. The
  keys that were in the title (`w warm · r refresh`) live in the bar.
- The pane wraps its lines to its width: a narrow split used to cut the per-quota figures, the context line, the
  cache bar, the legend and the pace summary mid-word.
- A model with a week of its own is paced by that week alone. On a plan with a Fable week, the 5-hour window's rate,
  `out in` and notices now count only the other models, by their share of the dollars (else the prompts) over the
  last 15 minutes; a Fable burst used to make the shared window `too fast` in every session. The window's fill and
  pace status still count every model. New `pacedBy` in `quota.ts`; plans with no per-model week are unchanged.
- A burst ends when the prompting does. Readings come only with use, so after a busy stretch its last few minutes
  stood as the rate for up to 15 minutes: `9% On pace ↻ 4h24m │ ▲ burst · out in 2h9m`. With no prompt or spend
  since the last reading, the quota now counts as unmoved up to now.
- A model's own week (Fable's) moves while another session's subagents spend it with no prompt anywhere: the
  usage check now runs every 3 minutes (was 15) after any session's spend, not only after a prompt.
- Under a minute reads `<1m`, not `0m` (`out in <1m`); 999.5k tokens and up read `1M`, not `1000k`; nothing spent
  reads `$0.00`, not `<$0.01`.
- Ultra pace integrates a fan-out once every subagent has reported, even across a reload. The reports were kept in
  memory, so a subagent editing pace's own code reloaded it and lost the reports already in: the run waited on
  subagents that had finished. They are now kept with the run (`fanout.reported` in `PaceUltra`), and a subagent
  Claude Code no longer lists at work counts as reported. A 0-subagent gear says to work inline, and a session
  stored with a timestamp of `NaN` or `Infinity` is forgotten like any old one. `/pace ultra resume` on a run
  waiting on its fan-out integrates what the subagents did, and the wait says how Claude Code lists each subagent.
- The band's sheen crosses each bar to its last cell. It wrapped after a fixed 40 frames (20 in cruise, 14 in push),
  so on a bar wider than that it turned back short of the end.
- `/pace ultra preview` plays ultra pace's push animation on the band for 20 seconds, whatever the quota says.
- The plan's timeline shows the roadmap and an ultra run's own plan side by side, each with its own count of steps
  done. `/pace plan A.md B.md` puts any two plans side by side; the tmux sidebar opens twice as wide for two.
- The band powers up while ultra pace runs: in cruise the sheen comes round twice as often; in push it goes super
  saiyan, a wide gold sheen three times as often, the filled cells crackling gold and the `▶` on ultra pace's row
  flickering through sparks.
- A quota pace sees no prompt for is no longer idle while it moves: where its readings measure its movement, idle
  means it has not moved, whoever moved it. A Fable subagent in a session prompting Opus, another session or
  claude.ai now shows on the Fable week's rate in every session, instead of `idle`. Prompt counts decide idle only
  until there are readings enough.
- Ultra pace (`/pace ultra [plan] [turns] [floor..ceiling]`, `ultra off`, `ultra resume`): auto mode given a goal
  instead of a checklist. The plan's `## Goal` holds the goal, its *Done when* lines and a `Check:` command, run by pace
  as it was when the run started. Claude plans, works one step a turn red first, reviews the plan every 5 steps or on
  `PACE: REPLAN`, and claims the goal with `PACE: GOAL`. Ticked steps are locked unless a revision line says why. It
  stops on a passing check, 3 failed checks or 3 quiet reviews in a row, or 80 turns. A gear set by the tightest
  quota (push, cruise, ease) picks the main thread's model (on a cold cache) and effort, the subagents' model and
  how many run at once, and fans `(parallel)` steps out to background subagents in push. It shows under the band,
  in the status-line entry and on the plan's timeline.
- The plan's timeline scrolls instead of folding steps away. The pane draws every step, opens on the step under
  way, and scrolls with the wheel or the arrows. The tmux sidebar follows the step under way until you scroll it:
  arrows or j/k, PgUp/PgDn or space, Home/End or g/G, the mouse wheel; f follows again.
- Usage pace cannot see (claude.ai, another machine) no longer makes a dollar look dearer: a span in which a quota
  moved while no session here spent anything is left out of how much of it a dollar uses.
- The rate is the quota's own movement in points an hour wherever its readings measure it: a least-squares fit
  through the last 15 minutes of readings for the 5-hour window, the last 3 hours for a week. Burst, too fast,
  `out in`, `→ % at reset` and auto mode's holds follow it. Before, the rate was the last hour's dollars (or
  prompts) times an estimated cost, so a burst that had ended kept the rate high: auto mode held a fresh window at
  10% as "gasses out in 1h 26m" while it moved 2 points in 7 minutes. The estimate from dollars and prompts still
  fills in until there are readings enough.
- `/pace auto burst` keeps auto mode going at full speed: it no longer holds while the rate would gas a quota out,
  and a pacing hold under way ends at once. A quota already gassed out still holds until its reset. `/pace auto
  burst off` brings the holds back. `PaceAuto` gains an optional `burst: true`.
- Dollars a subagent earns on another model count toward that model's week, not the session's: the spend a cost
  reading brings goes to the one model that answered since the last reading, and to none (every quota) when
  several did.
- `/pace auto` inside tmux sends its first prompt again. Opening the plan's sidebar ran after the prompt was
  scheduled, so the prompt fired while the command still held the turn, was refused, and auto mode sat on turn 1.
- Auto mode stops when Claude is waiting on you. Its instructions have Claude end with `PACE: BLOCKED <what it
  needs>` when it hands you a task or needs your feedback, and a turn that ends on a question with no `PACE:` line
  reads as blocked too, the question as its reason. Before, such a turn read as `PACE: NEXT` and pace prompted on
  while you were away.
- The contract adds ultra pace's shapes, ahead of the mode itself: `PaceAuto` gains an optional `ultra: PaceUltra`
  (the goal, its check, the phase, the counters for its guards, the model bounds, the gear, any subagents out on
  a fan-out and a review owed through a hold) and `PaceGear` (model, effort, subagents, their model, fan-out). A run stored without it, or with one
  that does not parse, reads as plain auto mode.
- The plan's timeline reads no steps from a `## Goal` or `## Revisions` section, and drops a step's `(parallel)`
  mark from its text. A step in the window's state file (`~/.claude/pace-state.json`) adds an optional
  `parallel: true` when it carries the mark.
- The `/pace` split shows the new modes and the roadmap: auto mode's run or on pace mode under its title, with
  `effort a level lighter` while the rate would run a quota out, and the plan's timeline (auto mode's plan, the one
  `/pace plan` named, or `ROADMAP.md`) under the charts when it has a checklist. The window's state file
  (`~/.claude/pace-state.json`) adds an optional `plan` with the plan's name and steps.
- The modes row puts what a mode is doing before the command that turns it off, and on pace mode's row says
  `compacts heavy contexts, keeps the cache warm · /pace off`.
- The Chinese README is gone; the README is in English only.
- `/pace plan [file]` opens the plan's timeline in a sidebar, and starting auto mode opens it too: inside tmux a
  narrow split on the right of Claude, elsewhere a pane, docked beside the transcript in fullscreen. It shows the steps
  done, the step under way and the step up next, read from the plan's checklist each time a turn ends, under a
  header with the count done, a progress bar and what auto mode is doing. A long step wraps under its own text with
  the timeline's line beside it, its `· under way` or `· up next` kept on one row. A long plan folds the steps far behind and
  far ahead. It is animated: the steps come in from the top, a dot runs into the step under way, and a step ticked
  off pops into a check.
- `/pace auto` with no plan file works through `ROADMAP.md`.
- Auto mode's last turn, done or blocked, ends with a report: what got done, why it stopped, what needs you with
  its reason and urgency, how to do it, and the plan's checklist as it now stands.
- The status-line entry is built from the band's own rate cell, so the two always agree:
  `5h 60% ▲ burst · out in 20m at this rate │ Fable wk 68% ● → —`. Quotas are now separated by `│`.
- On pace mode, and so auto mode, thinks one effort level lighter while the rate would run a quota out before its
  reset (a burst, or too fast with a known run-out), and goes back to the effort you set once the rate is steady.
  It lowers the effort rather than the model, since a new model starts with a cold cache.
- A burst says it is the recent rate: `▲ burst · out in 2h51m at this rate` on the band and
  `5h 11% ▲ burst · out in 2h51m at this rate` on the status line, so it no longer reads against an `Under pace`
  status beside it.
- A quota over pace with no per-prompt cost yet reads `▲ over pace · no cost yet` in the band and the status line,
  `over pace` in the pane, instead of a red, flashing `→ — at reset too fast`. Red and flashing wait for a cost
  that shows the rate runs the quota out. Its rate level is still `fast`, so alerts and auto mode's holds are unchanged.
- A window whose reset has passed shows the new window from that moment, at 0% and counting toward its next
  reset, until a reading of it arrives. Before, the band said `Window ended` and the status line kept the old
  window's percent (`5h 65%`). `$.pace.snapshot()` reports the new window's percent and reset the same way.
- Auto mode, on pace mode and warm mode are scoped to the session that turned them on, stored under its id, so
  `claude --resume` picks a run back up. Before, they lived in prefs every session shared: an auto run started in
  one session drove any other that started or reloaded. Modes an older pace stored there are ignored. A session's
  modes are forgotten a month after it last changed them.
- Auto mode no longer prompts turns that only wait. Claude ends a turn with `PACE: WAITING <what>` while background
  work runs, and pace sends nothing until a turn of its own starts or 15 minutes pass. Two turns in a row that move
  neither the plan nor the handoff file stop the prompting, with waits of 5, 10, 20 and 30 minutes.
- A context whose window is not known reads its size alone (`context 180k`) instead of `Infinity%`, and no longer
  reads as heavy: auto mode stops handing off on every turn and on pace mode stops compacting it.
- A rate limit reported without a percent, or a stored reading of `NaN` or `Infinity`, is dropped instead of read
  as on pace.
- Auto mode's hold ending during a turn of your own sends nothing on top of it: that turn's end decides. A
  resumed session whose run was holding picks the plan back up when the hold ends.
- A subagent starting a turn of its own no longer keeps warm mode and on pace mode from keeping the cache warm.
- `/pace line off` clears the status-line entry after a hot reload too: a freshly loaded module says its entry
  once instead of assuming none is shown.
- Each quota shows where your rate takes it: the percent it lands at by its reset (`→ 71% at reset`), or when it
  runs out (`out in 38m`). It replaces the `rate of budget %/h` score, whose budget grew without bound as a
  window neared its reset. `$.pace.snapshot()` adds `percentAtReset` to each quota's rate.
- A model's own week counts only that model's prompts and spend: prompting Opus no longer makes the Fable week
  too fast. Prompts and spend record the session's model; ones recorded before still count everywhere.
- Too fast flashes red only while you are prompting: a quota with no prompt in the last 15 minutes reads idle,
  however far over pace it is or whatever a running turn still spends. Alerts and auto mode's holds follow.
- Each quota keeps its own score: the band, the status line and the pane rate every quota in points of it an hour
  against its own budget (`19 of 20%/h`, `0.3 of 0.44%/h`), instead of repeating the prompts or dollars an hour
  every quota shares. `$.pace.snapshot()` adds `percentPerHour` and `percentBudgetPerHour` to each quota's rate.
- The status-line row puts each quota's rate beside it, without the band's column padding.
- The pane's advice names the quota mid-sentence (`the week · Fable`) and says its budget in prompts or dollars.

## 0.8.0

pace, a terminal-first take on [weektoken](https://github.com/3dnow/claude-mods/tree/main/weektoken)'s idea, with
its own quota model. What differs from weektoken:

- Terminal surfaces: a band above the prompt, a status-line entry or row, and `/pace`'s full-screen window
  (two columns when wide; keys `1`–`9`, `w`, `r`, `q`).
- `/pace` runs at once, mid-turn too, and answers in a toast: nothing lands in the conversation.
- Statuses: under pace, on pace, over pace, and **gassed out** for a spent quota.
- The rate against each quota: steady, brisk, burst, too fast.
- Shared spend across parallel sessions: pacing in dollars an hour against what each quota has left, and a
  per-prompt cost from the first prompt.
- The prompt cache: a countdown and the next prompt's cost, warm vs cold, in tokens and dollars.
- Warm mode keeps an idle cache from lapsing.
- Usage warnings at 80%, 95%, a rate that gasses a quota out, and gassed out: once per window, as a toast and a
  notification.
- On pace mode (`/pace on`) for long-running sessions: compacts a heavy context while its cache is warm.
- Auto mode (`/pace auto <plan>`): works through a plan with no one at the keyboard, with handoffs, subagents on
  lighter models, holds for pacing, and an onboarding pane.
- `$.pace.snapshot()` for other mods.
