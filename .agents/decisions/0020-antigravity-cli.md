# 20. Antigravity, in its CLI

Status: accepted, 2026-11-05. Being built. Built and tested offline: `adapters/antigravity/`, `.agents/antigravity.md`.

## Context

- The user runs Antigravity as its CLI, `agy`, in a terminal (in Herdr when it runs there). The CLI runs the same
  `language_server` as the app. That server calls the hooks in `~/.gemini/config/plugins/`, and it answers
  `GetUserStatus` on 127.0.0.1 with each model's remaining quota and reset.
- Verified on `agy` 1.5.1: the server runs inside `agy` itself (no `language_server` process), on two loopback ports,
  HTTP and HTTPS; its CSRF token is in no argument, but `agy` takes one from `ANTIGRAVITY_CSRF_TOKEN`, and its hooks
  inherit it. `GetUserStatus` takes `{}` and names the account's email. `agy acp` speaks ACP v1, with `model` and
  `thought_level` config options. A `PreInvocation` hook's terminate stops the turn before the model (seen in ACP).

## Decision

- **Hooks.** A plugin runs `adapters/antigravity/hook.ts` on `PreInvocation` and `Stop`. It records prompts, answers
  `/pace` by terminating the invocation ([0005](0005-answers-off-the-transcript.md)), and writes the feed.
- **Readings.** The hook asks its own language server for `GetUserStatus`, on loopback, with the CSRF token from the
  server's arguments. **This amends [0004](0004-local-only.md)**: a call to a harness's own server on 127.0.0.1 is
  allowed, because nothing leaves the machine.
- **The provider is `antigravity`.** One Google sign-in's quotas cover Gemini, Claude and GPT-OSS models alike.
  Gemini CLI's quota is a separate pool, and would be `gemini`.
- **Quota keys:** each 5-hour quota per model is keyed `five_hour_<model>`, an addition to `core/quota.ts`.
- **Commands:** views go Herdr first. `on`, `off` and `warm` say Antigravity can't do them. Auto mode can come later
  through the `Stop` hook. Through ACP it would come for free, if `agy` speaks it.

## Consequences

- The core gains the `antigravity` host and provider, and per-model 5-hour keys. These are additive, with a CHANGELOG
  entry.
- **For the TUI's readings,** `agy` has to be started with `ANTIGRAVITY_CSRF_TOKEN` set; under `pace-acp` pace sets it.
- **Still to verify in the TUI:** whether it passes `/pace` to the hook at all (it may reject an unknown command first).
