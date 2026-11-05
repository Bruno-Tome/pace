# 18. One stable core API: ports shaped like ACP

Status: accepted, 2026-11-05. Being built.

## Context

- The core's entry points grew with each host: `decide`, `stopStep`, `piStep`, `codexAction`, `piAction`, each
  adapter's `nextFeed`. Every adapter repeats the routing, and the "can't do this here" answers.
- The [Agent Client Protocol](https://agentclientprotocol.com) (ACP) already names what pace needs from an agent
  session, and harnesses are adopting it:
  - **Sessions:** `session/new`.
  - **Prompts:** `session/prompt`, with its `stopReason`.
  - **Context and cost:** `usage_update`, from the Session Context Size and Cost RFD.
  - **Compaction:** `compaction_update`.
  - **Model and thinking level:** `session/set_config_option`, with the categories `model` and `thought_level`.
  - **Cancellation:** `session/cancel`.
  - **Others:** slash commands, notices, and a system prompt the client provides.

## Decision

- **The surface.** The core gets one entry, `core/api.ts`, versioned (`PACE_API = 1`) and only ever extended:

  ```ts
  initialize(host: HostInfo): Capabilities           // what the host can carry out
  handle(state: PaceState, event: PaceEvent, now): { state: PaceState; actions: PaceAction[] }
  view(state: PaceState, what: PaceView, now): Line[]
  ```

- **Events in** (ports inbound). Each is named as ACP names it, where ACP has a name:
  - `session/new`, carrying the session, folder, terminal and account ([0017](0017-quota-is-provider-and-account.md));
  - `session/prompt`, from the user or from pace. A `/pace` prompt becomes a command here.
  - `usage_update`: the context, and the cost;
  - `turn_end`: `stopReason` and the answer's text;
  - `compaction_update` and `session/cancel`.
  - pace's own, under ACP's `_` prefix for extensions: `_pace/reading` (a quota reading), `_pace/spend` (dollars and
    cache tokens, until ACP settles end-of-turn usage), `_pace/limit` (a usage-limit error).
- **Actions out** (ports outbound):
  - `session/prompt`, auto mode's next prompt;
  - `session/cancel`;
  - `session/set_config_option`, with `model` or `thought_level`: on pace mode and ultra pace's gears;
  - `_pace/compact`: ACP reports a compaction but has no request for one;
  - `_pace/hold` with its end time;
  - `_pace/notice` (a warning or answer);
  - `_pace/open`, a view with where it goes: Herdr first ([0001](0001-herdr-first.md));
  - `_pace/system`: instructions for the system prompt.
- **Capabilities route the actions.** Each host declares what it can carry out at `initialize`, as ACP clients and
  agents do. The core never emits an action the host can't carry out. It answers the command itself, so "Codex can't
  compact" is said by one owner.
- **Adapters are routers.** An adapter turns its host's hooks or events into `PaceEvent`s, and carries out each
  `PaceAction` by its host's mechanism:
  - Codex: a Stop hook block, or a `UserPromptSubmit` block.
  - pi: `sendUserMessage`, `compact`, `setThinkingLevel`.
  - Claude Code: `$` in `register.tsx`.
  - Any ACP agent: real ACP messages ([0019](0019-acp-adapter.md)).

## Consequences

- `decide`, `stopStep`, `piStep`, `codexAction` and `piAction` move behind `handle`. Each host's timing (Codex's
  nine-minute hook budget) stays in its adapter, as a capability such as `holdUpTo`.
- Every host is tested through one surface: the same event script, a different capability set, and the expected
  actions.
- The move is incremental. `handle` wraps today's functions first, and each adapter switches over with its own tests
  green. The contract guardrail applies to `core/api.ts` as it does to `types/index.d.ts`.
