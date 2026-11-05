"""pace for Hermes Agent: the quotas of a Claude or ChatGPT sign-in paced in `hermes chat` (session mode) and in the
messaging gateway (bot mode).

The plugin is thin: it hands what Hermes does to pace's bridge (bin/pace-hermes.ts, one Node process per Hermes
process) a JSON line each, and carries out what the bridge answers. `/pace` is answered in place, in the session or
in the bot's chat, and never reaches the model; auto mode's next prompt is injected into the same session or chat.
Each provider call's usage comes from `post_api_request`; the account's real 5-hour and weekly windows from Hermes's
own `fetch_account_usage`, at most once a minute. pace never fails a turn: every error here is swallowed.
"""

from __future__ import annotations

import itertools
import json
import os
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

READ_EVERY_S = 60
ANSWER_WAIT_S = 8

_state = {"proc": None, "ctx": None, "last": "", "read_at": {}}
# Subagents' sessions, by id: their parent's, whose turn they work for
_children: dict[str, str] = {}
_lock = threading.Lock()
_ids = itertools.count(1)
_answers: dict[int, dict] = {}
_answered = threading.Condition()


def _config() -> dict:
    """Where the bridge is: written by `node scripts/hermes.ts install` beside this file"""
    try:
        return json.loads((Path(__file__).parent / "pace.json").read_text())
    except Exception:
        return {}


def _session_env(name: str) -> str:
    try:
        from gateway.session_context import get_session_env

        return get_session_env(name, "") or ""
    except Exception:
        return os.environ.get(name, "")


def _bot() -> bool:
    try:
        from gateway.session_context import session_is_messaging_surface

        return bool(session_is_messaging_surface())
    except Exception:
        return bool(os.environ.get("HERMES_SESSION_PLATFORM"))


def _carry(message: dict) -> None:
    """What the bridge asks of Hermes: a prompt into the session or the bot's chat"""
    if message.get("method") != "_pace/inject":
        return
    params = message.get("params") or {}
    ctx = _state["ctx"]
    if ctx is None:
        return
    key = params.get("key")
    try:
        if key:
            ctx.inject_message(params.get("text", ""), session_key=key)
        else:
            ctx.inject_message(params.get("text", ""))
    except Exception:
        pass


def _read(proc: subprocess.Popen) -> None:
    for line in proc.stdout:
        try:
            message = json.loads(line)
        except Exception:
            continue
        if "id" in message and "result" in message:
            with _answered:
                _answers[message["id"]] = message["result"]
                _answered.notify_all()
        else:
            _carry(message)


def _bridge() -> subprocess.Popen | None:
    with _lock:
        proc = _state["proc"]
        if proc is not None and proc.poll() is None:
            return proc
        cfg = _config()
        node, script = cfg.get("node") or "node", cfg.get("bridge")
        if not script:
            return None
        try:
            proc = subprocess.Popen([node, script], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        except Exception:
            return None
        threading.Thread(target=_read, args=(proc,), daemon=True).start()
        _state["proc"] = proc
        return proc


def _send(message: dict) -> None:
    proc = _bridge()
    if proc is None:
        return
    try:
        with _lock:
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()
    except Exception:
        pass


def _is_child(session_id: str, platform: str = "", parent: str = "") -> bool:
    """Whether a session is a subagent's (delegate_task): its calls are its parent's, its turns not the user's"""
    if session_id and (parent or platform == "subagent"):
        _children.setdefault(session_id, parent or _state["last"])
    return session_id in _children


def _session(session_id: str = "") -> str:
    """The session an event is for, and the one `/pace` answers for: the last seen at the terminal; a subagent's is its parent's"""
    if session_id in _children:
        return _children[session_id]
    sid = session_id or _session_env("HERMES_SESSION_ID") or _state["last"]
    if sid and sid != _state["last"]:
        _state["last"] = sid
        bot = _bot()
        _send({"method": "session/new", "params": {"session": sid, "cwd": os.getcwd(), "mode": "bot" if bot else "session", "key": _session_env("HERMES_SESSION_KEY") if bot else None}})
    return sid


def _iso(value) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _read_windows(provider: str) -> None:
    """The account's windows, as Hermes reads them for its own /usage: at most once a minute per provider"""
    now = time.time()
    if now - _state["read_at"].get(provider, 0) < READ_EVERY_S:
        return
    _state["read_at"][provider] = now
    try:
        from agent.account_usage import fetch_account_usage

        snap = fetch_account_usage(provider, read_only=True)
    except Exception:
        return
    if not snap or not getattr(snap, "windows", None):
        return
    windows = [{"label": w.label, "used_percent": w.used_percent, "reset_at": _iso(w.reset_at), "scope": w.scope} for w in snap.windows]
    # The pooled credential the reading was for, never a secret (``codex:<account>:<user>``)
    _send({"method": "_pace/reading", "params": {"provider": provider, "identity": getattr(snap, "identity", None), "windows": windows}})


def _pre_llm_call(session_id: str = "", user_message="", parent_session_id: str = "", platform: str = "", **_):
    try:
        if _is_child(session_id, platform, parent_session_id):
            return None
        sid = _session(session_id)
        if isinstance(user_message, str) and user_message.strip().startswith("/pace"):
            return None
        _send({"method": "session/prompt", "params": {"session": sid}})
    except Exception:
        pass
    return None


def _usage(session_id: str, provider: str, model: str, usage, context_length, platform: str = "", aux: bool = False) -> None:
    sub = _is_child(session_id, platform)
    sid = _session(session_id)
    if not sid:
        return
    flags = {"aux": True} if aux else {"sub": True} if sub else {}
    _send({"method": "_pace/usage", "params": {"session": sid, "provider": provider or "", "model": model or "", "usage": usage if isinstance(usage, dict) else {}, "context_length": context_length or 0, **flags}})
    threading.Thread(target=_read_windows, args=(provider or "",), daemon=True).start()


def _post_api_request(session_id: str = "", provider: str = "", model: str = "", usage=None, context_length=None, platform: str = "", **_):
    try:
        _usage(session_id, provider, model, usage, context_length, platform)
    except Exception:
        pass


def _post_auxiliary_call(session_id: str = "", provider: str = "", model: str = "", usage=None, context_length=None, platform: str = "", **_):
    """A background call (compression, titling, vision, Mixture of Agents): the quota's figures refreshed"""
    try:
        _usage(session_id, provider, model, usage, context_length, platform, aux=True)
    except Exception:
        pass


def _post_llm_call(session_id: str = "", assistant_response="", platform: str = "", **_):
    try:
        if _is_child(session_id, platform):
            return
        _send({"method": "turn_end", "params": {"session": _session(session_id), "answer": assistant_response if isinstance(assistant_response, str) else ""}})
    except Exception:
        pass


def _pace(raw_args: str = "") -> str:
    """`/pace`, answered in place by the bridge; the model never sees it"""
    sid = _session()
    if not sid:
        return "pace has not seen this session yet: send a prompt first"
    rid = next(_ids)
    _send({"id": rid, "method": "_pace/command", "params": {"session": sid, "args": raw_args or ""}})
    deadline = time.time() + ANSWER_WAIT_S
    with _answered:
        while rid not in _answers and time.time() < deadline:
            _answered.wait(timeout=max(0.0, deadline - time.time()))
        result = _answers.pop(rid, None)
    return (result or {}).get("text") or "pace did not answer in time"


def register(ctx) -> None:
    _state["ctx"] = ctx
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("post_api_request", _post_api_request)
    ctx.register_hook("post_llm_call", _post_llm_call)
    ctx.register_hook("post_auxiliary_call", _post_auxiliary_call)
    ctx.register_command("pace", _pace, description="pace: quotas, the fleet, auto mode", args_hint="[pane|band|fleet|auto …]")
