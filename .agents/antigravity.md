## Antigravity

> Verified live on `agy` 1.5.1 since this was written: see [ADR 0020](decisions/0020-antigravity-cli.md). Under the
> CLI the server runs inside `agy`, its token from `ANTIGRAVITY_CSRF_TOKEN`; state is in `~/.gemini/antigravity-cli/`;
> payloads carry `invocationNum`, not `executionId`; `/pace` is answered as the turn's message.

Google Antigravity comes in three surfaces that share one agent: Antigravity 2.0 (an Electron desktop app,
`com.google.antigravity`), the Antigravity IDE (a VS Code fork) and the CLI `agy`. Each runs the same Go
`language_server` (in 2.0: `Antigravity.app/Contents/Resources/bin/language_server`), which runs the agent loop, calls
the hooks and serves a local RPC. pace reaches Antigravity through those two, not through a VS Code extension: hooks
are documented and work in every surface, where an extension would reach the IDE alone.

What is known, and from where (2.0 version 2.29.0, read from its bundle; the builtin skills in
`~/.gemini/antigravity/builtin/skills/agy-customizations/docs/hooks.md` and `plugins.md`):

- **Hooks.** `hooks.json` in a customization root (`~/.gemini/config/` globally, `.agents/` in a project) or in a
  plugin (`~/.gemini/config/plugins/<name>/hooks.json`), keyed by a hook's name: `{"pace": {"PreInvocation": [...],
  "Stop": [...]}}`. Events: `PreToolUse`, `PostToolUse` (with a `matcher`), `PreInvocation` (before each model call),
  `PostInvocation`, `Stop` (flat lists of `{type: 'command', command, timeout}`). The binary also has a `SessionStart`
  hook, undocumented. Hooks run synchronously and block the agent loop; each reads JSON on stdin and must print a JSON
  object. The payload does not name its event, so the command line does.
- **The payload** (`exa.hooks_pb.HookArgsCommon`, camelCase): `conversationId`, `workspacePaths`, `transcriptPath`,
  `artifactDirectoryPath`, `executionId`, `modelName` (`auto` possible), `lastUserInput`, `agentName`,
  `parentConversationId`, `rootConversationId`; `PreInvocation` adds `invocationNum` and `initialNumSteps`; `Stop`
  adds `terminationReason`, `error`, `fullyIdle`. A `PreInvocation` hook can answer `{"terminationBehavior":
  "terminate"}`, which ends the run before the model is called. Proto3 JSON leaves zeros out.
- **Readings.** The language server's `exa.language_server_pb.LanguageServerService/GetUserStatus` answers
  `userStatus.cascadeModelConfigData.clientModelConfigs[]`, each a model with its `label` and `quotaInfo:
  {remainingFraction, resetTime}` (RFC 3339; a fraction of 0 is left out). It is Connect over HTTP on loopback, on a
  port the server picks (`--random_port`), behind the `x-codeium-csrf-token` header, whose value is the server's
  `--csrf_token` argument. Antigravity's quotas are per model (or group of models) and say no window length: a reset
  within five hours is a 5-hour window, a later one a week.
- **No dollars, no cache.** Antigravity reports neither: the snapshot sets `noCache` and carries no spend, as Codex's.
- **Context.** The server tracks it (`ContextWindowUsage {estimatedTokensUsed, maxContextTokens}`) but only in its
  agent-state stream; neither the hooks nor the transcript carry tokens. The feed leaves `context` out.
- **Transcripts** are JSONL at `<appDataDir>/brain/<conversation>/.system_generated/logs/transcript.jsonl`, a step a
  line (`type: USER_INPUT`, `created_at`); the hooks are enough, so pace does not read them.

Not verified here, since the app is not installed on this machine (only `~/Downloads/Antigravity.dmg`): that the
server's RPC port speaks HTTPS with a self-signed certificate (the hook tries HTTPS, then HTTP); that
`terminationBehavior: terminate` keeps a `/pace` prompt from the model; that the chat lets `/pace` through to the
hooks; that the IDE and the CLI read `~/.gemini/config/plugins/` as 2.0 does (context-mode found `agy` does).

### Whose quota

Antigravity's own: a new provider, `'antigravity'`, and a new host of the same name. Not `'gemini'`: the quotas
cover Antigravity's Claude and GPT-OSS models too, and the Gemini CLI's quota is a different pool. Both are contract
changes the lead makes (`PaceHost`, `PaceProvider`, `HOSTS`, `PROVIDERS` in `core/host.ts`); until then
`adapters/antigravity/feed.ts` types its feed locally.

Each model's quota is a key of its own: `five_hour_<model>` for a 5-hour window, `seven_day_<model>` for a week, with
the model's `name` (`Gemini 3.1 Pro`; a variant in brackets, `(High)`, is the same quota). A model once seen on a week
stays on it, so a week's last five hours are not read as a 5-hour window. `five_hour_<model>` is new to the core: see
the proposal below.

### How readings are obtained

The hook asks the language server that runs it: it walks up from its own process to the `language_server` with a
`--csrf_token`, lists the ports that process listens on (`lsof`), and posts `GetUserStatus` to each in turn on
127.0.0.1, with a short timeout. It asks at most once a minute, or on `/pace refresh`. Nothing leaves the machine
from pace; the server answers from what it already knows of the account. No estimate is needed: the readings are
real. If the server cannot be reached, the feed carries prompts and the last readings.

### The feed

`adapters/antigravity/hook.ts` runs on `PreInvocation` and `Stop` and writes
`~/.local/state/pace/feeds/antigravity-<conversation>.json`: `{host: 'antigravity', provider: 'antigravity', session,
terminal?, cwd: workspacePaths[0], at, snapshot}`. The history is shared by every Antigravity conversation, since the
readings are the account's, in `~/.local/state/pace/antigravity/history.json`, under a lock: the readings, the prompts,
and the runs already counted. A prompt is a `PreInvocation` of a run not counted yet (`executionId`, else
`initialNumSteps`), not a subagent's (`parentConversationId`), not `/pace`. A subagent's hooks write the root
conversation's feed (`rootConversationId`).

### What it draws, and `/pace`

Antigravity has no surface a hook can draw in, so pace draws beside it. `/pace` reaches the hook as `lastUserInput`
on `PreInvocation`; the hook carries it out once per run and answers `terminate`, so the model never gets it. The
answer is a macOS notification, never the conversation. Following `.agents/decisions/0001-herdr-first.md`: in Herdr
(`agy` in a Herdr terminal sets `HC_TERMINAL_ID`) every view opens there first; outside Herdr, or when Herdr fails, in a
Terminal window running `bin/band.ts`.

| Command | Antigravity |
| --- | --- |
| `/pace`, `split`, `pane`, `window` | the charts: in Herdr, else a Terminal window (`bin/band.ts --pane <feed>`) |
| `band` | the band: in Herdr, else a Terminal window |
| `fleet` | the fleet: in Herdr, else a Terminal window (`bin/band.ts --fleet`) |
| `refresh` | the readings asked for again, the feed written |
| `hide`, `show`, `line on/off` | says Antigravity has no band or status line of pace's, and that `/pace band` opens one |
| `on`, `off`, `warm …` | says they are not in Antigravity: its hooks cannot change the model, and it reports no cache |
| `auto …`, `ultra …`, `plan`, `timeline` | not in Antigravity yet; the `Stop` hook's `decision: continue` could carry auto mode later |

### Installing

`node scripts/antigravity.ts install` writes a plugin, `~/.gemini/config/plugins/pace/`: `plugin.json`, and
`hooks.json` running this repo's `adapters/antigravity/hook.ts` on `PreInvocation` and `Stop`. Only with the user's
go-ahead, since the hooks run in every conversation.

### Contract changes the lead makes

1. `core/host.ts`: `PaceHost` and `HOSTS` add `'antigravity'`; `PaceProvider` and `PROVIDERS` add `'antigravity'`.
   Test (`tests/host.test.ts`): `feedOf` reads back a feed with `host: 'antigravity', provider: 'antigravity'`, and
   `fleetOf` gives it a row of its own. CHANGELOG under *Unreleased*.
2. `core/quota.ts`: a model's own 5-hour window, `five_hour_<model>`. `isPerModel` takes both prefixes; `quotaKeys`
   keeps `five_hour_` keys; `quotaName` `5-hour · <Model>`, `shortName` `<Model> 5h`; `drawsOn` reads the family after
   either prefix; `order` sets them after `seven_day`. `windowOf` already gives five hours. Test (`tests/quota.test.ts`):
   a history with `five_hour_gemini_3_1_pro` (name `Gemini 3.1 Pro`) knows that quota, names it `5-hour · Gemini 3.1
   Pro`, paces it over five hours, and a Claude model does not draw on it.
3. `adapters/herdr/open.ts` and the mod's `{view: 'pane', provider}` take the new provider once (1) is in; nothing to
   change but the type.
