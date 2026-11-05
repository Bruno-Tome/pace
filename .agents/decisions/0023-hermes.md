# 23. Hermes: one plugin for session mode and bot mode, the core in a Node bridge

Status: accepted, 2026-11-05. Built.

## Context

Hermes Agent (Nous Research, v0.22) runs as an interactive session (`hermes chat`, its TUI) and as a messaging gateway
that answers in Telegram, Discord, Slack or WhatsApp chats (bot mode). The user wants pace in both. Hermes is Python;
pace's core is TypeScript. Hermes offers shell hooks, Python plugins and ACP:

- **Shell hooks** cannot show the user anything or send a prompt, and need consent in the gateway.
- **ACP** (`hermes acp`) reports no cost and no quota, and offers no thinking level.
- **A Python plugin** runs in both modes. It gets every provider call's usage (`post_api_request`), a prompt
  (`pre_llm_call`) and a turn's end (`post_llm_call`). It registers `/pace` (`register_command`), answered before any
  model turn in the session and in a chat. It sends a prompt into a session or a chat (`inject_message`). It can read
  the account's real windows through Hermes's own `fetch_account_usage`.

## Decision

- **A thin plugin, `adapters/hermes/plugin`,** installed by `node scripts/hermes.ts install` into
  `~/.hermes/plugins/pace` and enabled. It hands every event to the bridge as a JSON line, named as ACP names it where
  it can ([0018](0018-core-api-acp-ports.md)): `session/new`, `session/prompt`, `_pace/usage`, `_pace/reading`,
  `turn_end`, `_pace/command`. It carries out `_pace/inject`. It never fails a turn.
- **The bridge, `bin/pace-hermes.ts`,** is one Node process per Hermes process. It runs the core: `meter` for the feed,
  `route` for `/pace`, and `stepOf` for auto mode.
- **The two modes are two hosts** ([0022](0022-surfaces-not-harnesses.md)).
  - A session has the command's answer, and Herdr, tmux and a window beside it.
  - A bot has only the chat. Every view is drawn into it, and auto mode's prompts go into that chat by its session key.
- **Quotas:** Anthropic spends Claude's and `openai-codex` spends Codex's. Any other provider writes nothing. The
  readings are the windows Hermes reads for its own `/usage`, at most once a minute. The account is the provider's one
  account on the machine ([0017](0017-quota-is-provider-and-account.md)), since Hermes stores no email.

## Consequences

- Auto mode runs in bot mode only with `plugins.entries.pace.allow_gateway_injection: true` (set at install here).
- Not yet in Hermes: on pace mode, warm mode, and ultra pace's gears. A plugin has no handle on the model, the
  reasoning level or compaction. `/compress` and `/model … --reasoning` sent through `inject_message` may work in the
  classic CLI; that is unverified.
- **Background calls** (compression, titling, vision, Mixture of Agents: `post_auxiliary_call`) and **subagents'**
  calls (`delegate_task`, `platform: 'subagent'`) are their session's. They refresh its quota's readings, which come
  from the provider and so include them. They leave its context and cache alone. A subagent's turns are not the
  user's prompts, and `/pace` keeps answering for the user's session.
- **A session that moves between Claude and ChatGPT** keeps a feed on each quota, so neither history restarts.
- **Hermes's credential pool:** each reading names the credential it was for (`codex:<account>:<user>`). When Codex is
  signed in here on that account, the account is Codex's own, the hash of its email, so the two harnesses meet.
  Otherwise the identity is hashed as it is. A call is taken to spend the account last read: Hermes's usage events
  do not say which credential they used.
- On Hermes's Codex app-server runtime, `post_api_request` is not called, so that runtime meters nothing yet.
