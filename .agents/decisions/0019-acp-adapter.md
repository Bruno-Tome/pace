# 19. An ACP adapter: pace between any ACP client and any ACP agent

Status: accepted, 2026-11-05. Being built.

## Context

- Zed and other clients run agents over ACP. So do adapters for the Claude agent and for Codex, and `gemini --acp`
  (installed here: Gemini CLI 0.46).
- An ACP proxy sees every prompt, every `usage_update` and every turn's end, and can send prompts and config changes
  of its own. ACP's proxy-chains RFD defines that role.

## Decision

- **The proxy.** `adapters/acp/` gets a proxy (`bin/pace-acp.ts`). It runs as `pace-acp -- <agent command>`, or as a
  proxy in a conductor's chain. It speaks ACP to both sides, and translates the traffic into `core/api.ts`
  ([0018](0018-core-api-acp-ports.md)) both ways.
- **What it gives every ACP agent, with no host-specific code:**
  - prompts, context and cost;
  - `/pace`, advertised through `available_commands_update` and answered without reaching the agent;
  - auto mode, through `session/prompt`;
  - on pace mode and ultra pace's gears, through `session/set_config_option`, when the agent offers a model or a
    thinking level;
  - warnings, as notices.
- **Readings still come from the provider's source** (the usage endpoint, Codex's rollout, Antigravity's server),
  keyed by the account ([0017](0017-quota-is-provider-and-account.md)). ACP carries none. With no reading, the
  estimate from cost applies ([0008](0008-readings-first-estimates-marked.md)).

## Consequences

- A new harness that speaks ACP is supported with no new adapter.
- **Every adapter is hooks and ACP together.** Hooks (or an extension) meter what the harness's own TUI does and draw
  in it where the harness lets a plugin draw; ACP meters and drives the sessions an ACP client runs. Both translate
  into the same `core/api.ts` events, so one session metered both ways is one session.
- **Open:**
  - which RFDs (proxy chains, usage, notices) are stable enough to rely on, and which to treat as optional;
  - whether Herdr launches agents over ACP. If it does, Herdr itself could run the proxy.
