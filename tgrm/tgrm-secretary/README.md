# telegram-secretary

A Telegram Secretary Bot backend: auto-replies in your private chats on your
account's behalf, powered by the [pi.dev](https://pi.dev/) agent. Stdlib-only
Python — no third-party packages.

## How it works

1. You attach a bot with **Secretary Mode** enabled to your Telegram account
   (profile → Edit → Chat Automation).
2. `secretary_bot.py` long-polls `getUpdates` for `business_message` updates.
3. Each message goes to `pi -p --no-tools` with the full 3-actor transcript
   (OWNER / VISITOR / SECRETARY, kept in `data/chats/<id>/history.jsonl`).
4. The reply is sent with `business_connection_id`, so it lands as your
   account's reply.

Quiet rules: your own messages are never answered; anything you wrote after
their message counts as handled
(`OWNER_ACTIVE_MINUTES` optionally extends the silence window).
Every visitor message waits `REPLY_DELAY_SECONDS` (default 120); the reply
goes out only if the last message in history is still the visitor's —
if you answered in the meantime, the pending reply is cancelled.
A burst of visitor messages gets one debounced reply over the full transcript.
Which chats reach the bot is controlled in Telegram itself
(profile → Edit → Chat Automation → Only selected chats).

Every turn from every actor (OWNER / VISITOR / SECRETARY) is appended to
`data/chats/<id>/history.jsonl` on arrival, even when no reply goes out.

## Setup

Requires the [pi CLI](https://pi.dev/) with an OpenRouter key (or any pi
provider).

1. Create a bot via [@BotFather](https://t.me/BotFather) (`/newbot`), open the
   BotFather web app → your bot → Settings → Bot Settings → Mode Settings and
   enable **Secretary Mode**.
2. Attach it: your profile → Edit → Chat Automation → select the bot, allow
   only selected chats, grant Manage Messages.
3. Configure and run:

```bash
cp .env.example .env   # then add your BOT_TOKEN (never commit .env)
python3 secretary_bot.py
```

## Tests

```bash
python3 -m unittest discover -s tests
```

See [about.html](about.html) for the research background (Secretary Mode,
connection flow, implementation plan).
