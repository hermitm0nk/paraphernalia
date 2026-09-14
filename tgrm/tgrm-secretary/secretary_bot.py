#!/usr/bin/env python3
"""Secretary bot backend: autoreplies in your Telegram chats via a pi.dev agent.

Flow: long-poll getUpdates -> business_message from your attached
Secretary-Mode bot -> `pi -p --no-tools --session <chat>` -> reply text ->
sendMessage with business_connection_id (lands as your account's reply).

Stdlib only. No third-party packages.
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = "https://api.telegram.org/bot%s/%s"


def load_dotenv(path):
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("\"'"))


load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))


class Config:
    token = os.environ.get("BOT_TOKEN", "")
    pi_bin = os.environ.get("PI_BIN", "pi")
    pi_provider = os.environ.get("PI_PROVIDER", "")
    pi_model = os.environ.get("PI_MODEL", "")
    pi_thinking = os.environ.get("PI_THINKING", "low")
    pi_timeout = int(os.environ.get("PI_TIMEOUT", "120"))
    poll_timeout = int(os.environ.get("POLL_TIMEOUT", "50"))
    owner_active_minutes = int(os.environ.get("OWNER_ACTIVE_MINUTES", "0"))
    reply_delay_seconds = int(os.environ.get("REPLY_DELAY_SECONDS", "120"))
    data_dir = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
    owner_name = os.environ.get("OWNER_NAME", "Alex")
    system_prompt_file = os.environ.get(
        "SYSTEM_PROMPT_FILE",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "SYSTEM.md"),
    )


def log(data_dir, event):
    os.makedirs(data_dir, exist_ok=True)
    event = dict(event)
    event["ts"] = datetime.now(timezone.utc).isoformat()
    with open(os.path.join(data_dir, "events.jsonl"), "a") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")
    print(json.dumps(event, ensure_ascii=False), flush=True)


def load_state(data_dir):
    path = os.path.join(data_dir, "state.json")
    if os.path.exists(path):
        try:
            with open(path) as f:
                state = json.load(f)
                state.setdefault("chats", {})
                state.setdefault("pending", {})
                return state
        except (json.JSONDecodeError, OSError):
            pass
    return {"owner_id": 0, "chats": {}, "pending": {}}


def save_state(data_dir, state):
    os.makedirs(data_dir, exist_ok=True)
    tmp = os.path.join(data_dir, "state.json.tmp")
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, os.path.join(data_dir, "state.json"))


def note_owner_activity(cfg, state, chat_id, ts):
    chat = state["chats"].setdefault(chat_id, {})
    if ts > chat.get("last_owner_ts", 0):
        chat["last_owner_ts"] = ts
    save_state(cfg.data_dir, state)


def api_call(cfg, method, params=None, timeout=70):
    data = urllib.parse.urlencode(params or {}).encode()
    req = urllib.request.Request(API % (cfg.token, method), data=data)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def build_system_prompt(cfg):
    base = ""
    if os.path.exists(cfg.system_prompt_file):
        with open(cfg.system_prompt_file) as f:
            base = f.read().strip()
    return base.replace("{OWNER}", cfg.owner_name)


def history_path(data_dir, slug):
    return os.path.join(data_dir, "chats", slug, "history.jsonl")


def append_history(data_dir, slug, role, text, ts):
    """Persist every turn from every actor: OWNER, VISITOR, or SECRETARY."""
    path = history_path(data_dir, slug)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps({"ts": ts, "role": role, "text": text[:2000]},
                           ensure_ascii=False) + "\n")


def load_tail(data_dir, slug, max_chars=6000, max_msgs=40):
    """Recent transcript, oldest-first, bounded for the prompt."""
    path = history_path(data_dir, slug)
    if not os.path.exists(path):
        return []
    with open(path) as f:
        lines = f.readlines()
    msgs = []
    for line in lines[-max_msgs:]:
        try:
            m = json.loads(line)
        except (json.JSONDecodeError, OSError):
            continue
        msgs.append(m)
    total, out = 0, []
    for m in reversed(msgs):
        total += len(m.get("text", ""))
        if total > max_chars and out:
            break
        out.append(m)
    return list(reversed(out))


def format_transcript(tail):
    lines = []
    for m in tail:
        lines.append("%s: %s" % (m.get("role", "?"), m.get("text", "")))
    return "\n".join(lines)


def ask_pi(cfg, session_slug, tail, system_prompt):
    """One ephemeral pi turn over our transcript.

    History lives in data/chats/<slug>/history.jsonl (all three actors),
    passed in the prompt each turn. pi itself keeps no session, so there
    is exactly one source of truth. Tools, extensions, skills, and
    context files are off: the model can only talk.
    """
    chat_dir = os.path.join(cfg.data_dir, "chats", session_slug)
    os.makedirs(chat_dir, exist_ok=True)
    prompt = ("Full conversation so far (OWNER=%s holds this account; "
              "VISITOR is the external user; SECRETARY is you):\n%s\n\n"
              "Reply to the last VISITOR message as SECRETARY: one short "
              "chat message."
              % (cfg.owner_name, format_transcript(tail) or "(empty)"))
    cmd = [cfg.pi_bin, "--no-session", "-p",
           "--no-tools", "--no-extensions", "--no-skills", "-nc",
           "--thinking", cfg.pi_thinking]
    if cfg.pi_provider:
        cmd += ["--provider", cfg.pi_provider]
    if cfg.pi_model:
        cmd += ["--model", cfg.pi_model]
    if system_prompt:
        cmd += ["--append-system-prompt", system_prompt]
    cmd += ["--", prompt]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=cfg.pi_timeout,
                           cwd=os.path.join(cfg.data_dir, "chats", session_slug))
    except subprocess.TimeoutExpired:
        return "(sorry, I needed too long to think — could you repeat that?)"
    if p.returncode != 0:
        raise RuntimeError("pi exited %d: %s" % (p.returncode, (p.stderr or "")[-500:]))
    reply = (p.stdout or "").strip()
    return reply or "(I have nothing to add to that.)"


def owner_active(cfg, state, chat_id, now):
    """True when OWNER_ACTIVE_MINUTES suppresses replies in this chat."""
    window = getattr(cfg, "owner_active_minutes", 0) or 0
    if not window:
        return False
    last_owner = state.get("chats", {}).get(chat_id, {}).get("last_owner_ts", 0)
    return bool(last_owner and (now - last_owner) < window * 60)


def cancel_pending(cfg, state, chat_id, reason):
    pending = state.setdefault("pending", {})
    if chat_id in pending:
        del pending[chat_id]
        save_state(cfg.data_dir, state)
        log(cfg.data_dir, {"type": "cancelled", "chat_id": chat_id,
                           "reason": reason})


def send_reply(cfg, state, chat_id, conn_id, system_prompt, now):
    """Send-time gate + reply. History's last entry must be VISITOR.

    All history is recorded regardless; this only decides whether a
    SECRETARY reply goes out.
    """
    slug = "tg-" + chat_id
    tail = load_tail(cfg.data_dir, slug)
    if not tail or tail[-1].get("role") != "VISITOR":
        log(cfg.data_dir, {"type": "incoming", "chat_id": chat_id,
                           "skipped": "owner replied already"})
        return None
    if owner_active(cfg, state, chat_id, now):
        log(cfg.data_dir, {"type": "incoming", "chat_id": chat_id,
                           "skipped": "owner active"})
        return None
    reply = ask_pi(cfg, slug, tail, system_prompt)
    append_history(cfg.data_dir, slug, "SECRETARY", reply, int(now))
    log(cfg.data_dir, {"type": "incoming", "chat_id": chat_id,
                       "reply": reply[:2000]})
    if not conn_id:
        log(cfg.data_dir, {"type": "error",
                           "detail": "no business_connection_id, not sending"})
        return None
    res = api_call(cfg, "sendMessage", {
        "chat_id": chat_id, "text": reply,
        "business_connection_id": conn_id,
    })
    log(cfg.data_dir, {"type": "sent", "chat_id": chat_id,
                       "ok": res.get("ok")})
    return reply


def process_due_replies(cfg, state, system_prompt, now=None):
    """Send every pending reply whose wait has elapsed. Returns sent count."""
    now = time.time() if now is None else now
    pending = state.setdefault("pending", {})
    due = sorted(cid for cid, p in pending.items()
                 if now >= p.get("due", 0))
    sent = 0
    for chat_id in due:
        item = pending.pop(chat_id, None)
        if item is None:
            continue
        save_state(cfg.data_dir, state)
        try:
            if send_reply(cfg, state, chat_id, item.get("conn_id", ""),
                          system_prompt, now):
                sent += 1
        except Exception as e:
            log(cfg.data_dir, {"type": "handler_error",
                               "detail": str(e)[:300]})
    return sent


def handle_business_message(cfg, state, msg, system_prompt, now=None):
    now = time.time() if now is None else now
    delay = getattr(cfg, "reply_delay_seconds", 0) or 0
    chat_id = str(msg["chat"]["id"])
    conn_id = msg.get("business_connection_id", "")
    text = msg.get("text", "")
    sender = msg.get("from", {})
    sender_id = sender.get("id", 0)
    sender_name = (sender.get("first_name", "") + " " + sender.get("last_name", "")).strip()
    msg_ts = msg.get("date", 0)

    entry = {"type": "incoming", "chat_id": chat_id, "connection_id": conn_id,
             "from": sender_name, "sender_id": sender_id, "text": text[:2000]}
    is_owner = False
    if state.get("owner_id") and sender_id == state["owner_id"]:
        is_owner = True
    elif (msg.get("chat", {}).get("type") == "private" and sender_id
          and str(sender_id) != chat_id):
        # In a private chat the chat id IS the other person's user id,
        # so anyone else sending here is the account owner. No
        # business_connection update needed to know this.
        is_owner = True
        state["owner_id"] = sender_id
        save_state(cfg.data_dir, state)
    slug = "tg-" + chat_id
    if is_owner:
        # Your own message: always into history, activity noted, any
        # pending reply for this chat cancelled. Never answered.
        append_history(cfg.data_dir, slug, "OWNER",
                       "%s: %s" % (sender_name or cfg.owner_name, text or "[non-text message]"),
                       msg_ts or int(now))
        note_owner_activity(cfg, state, chat_id, msg_ts or int(now))
        cancel_pending(cfg, state, chat_id, "owner replied")
        entry["skipped"] = "own message"
        log(cfg.data_dir, entry)
        return None
    if not text:
        append_history(cfg.data_dir, slug, "VISITOR",
                       "%s: [non-text message]" % (sender_name or "visitor"),
                       msg_ts or int(now))
        entry["skipped"] = "non-text message"
        log(cfg.data_dir, entry)
        return None
    # Visitor text: always recorded first — history is never dropped,
    # even when no reply goes out.
    append_history(cfg.data_dir, slug, "VISITOR",
                     "%s: %s" % (sender_name or "visitor", text),
                     msg_ts or int(now))
    last_owner = state.get("chats", {}).get(chat_id, {}).get("last_owner_ts", 0)
    if last_owner and msg_ts and last_owner >= msg_ts:
        # You wrote in this chat after they sent this: you already handled it.
        entry["skipped"] = "owner replied already"
        log(cfg.data_dir, entry)
        return None
    if owner_active(cfg, state, chat_id, now):
        # You're actively messaging right now: stay out of the way.
        # Disabled when OWNER_ACTIVE_MINUTES=0.
        entry["skipped"] = "owner active"
        log(cfg.data_dir, entry)
        return None
    if delay <= 0:
        return send_reply(cfg, state, chat_id, conn_id, system_prompt, now)
    # Grace window: (re)schedule one reply per chat — each new visitor
    # message pushes the due time out, so a burst gets a single answer
    # over the full transcript.
    pending = state.setdefault("pending", {})
    pending[chat_id] = {"due": now + delay, "conn_id": conn_id,
                        "visitor_ts": msg_ts or int(now)}
    save_state(cfg.data_dir, state)
    entry["scheduled"] = "reply in %ds" % delay
    log(cfg.data_dir, entry)
    return None


def run(cfg):
    if not cfg.token:
        sys.exit("BOT_TOKEN missing. Copy .env.example to .env and add your token.")
    system_prompt = build_system_prompt(cfg)
    state = load_state(cfg.data_dir)
    log(cfg.data_dir, {"type": "start"})
    offset = 0
    backoff = 1
    while True:
        try:
            res = api_call(cfg, "getUpdates", {
                "offset": offset, "timeout": cfg.poll_timeout,
                "allowed_updates": json.dumps(["business_message", "edited_business_message",
                                               "business_connection", "deleted_business_messages"]),
            }, timeout=cfg.poll_timeout + 20)
            backoff = 1
        except KeyboardInterrupt:
            log(cfg.data_dir, {"type": "stop"})
            return
        except Exception as e:
            log(cfg.data_dir, {"type": "poll_error", "detail": str(e)[:300]})
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
            continue
        for upd in res.get("result", []):
            offset = max(offset, upd.get("update_id", 0) + 1)
            if "business_connection" in upd:
                c = upd["business_connection"]
                if c.get("user_id"):
                    state["owner_id"] = c["user_id"]
                    save_state(cfg.data_dir, state)
                log(cfg.data_dir, {"type": "connection", "id": c.get("id"),
                                   "user_id": c.get("user_id"), "disabled": c.get("disabled")})
            elif "business_message" in upd:
                try:
                    handle_business_message(cfg, state, upd["business_message"], system_prompt)
                except Exception as e:
                    log(cfg.data_dir, {"type": "handler_error", "detail": str(e)[:300]})
            elif "edited_business_message" in upd:
                try:
                    handle_business_message(cfg, state, upd["edited_business_message"], system_prompt)
                except Exception as e:
                    log(cfg.data_dir, {"type": "handler_error", "detail": str(e)[:300]})
            elif "deleted_business_messages" in upd:
                log(cfg.data_dir, {"type": "deleted", "chat_id": str(upd["deleted_business_messages"]["chat"]["id"])})
        try:
            process_due_replies(cfg, state, system_prompt)
        except KeyboardInterrupt:
            log(cfg.data_dir, {"type": "stop"})
            return
        except Exception as e:
            log(cfg.data_dir, {"type": "handler_error", "detail": str(e)[:300]})


if __name__ == "__main__":
    run(Config())
