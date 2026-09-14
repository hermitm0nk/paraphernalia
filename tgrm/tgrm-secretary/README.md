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
their message counts as handled; only allowlisted chats get replies
(`OWNER_ACTIVE_MINUTES` optionally extends the silence window).

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

4. With `ALLOWED_CHATS` empty the bot runs in learning mode: everything is
   logged to `data/events.jsonl`, nothing is answered. Send a message in the
   target chat, read its id from the log, set `ALLOWED_CHATS=<id>`, restart.

## Tests

```bash
python3 -m unittest discover -s tests
```

See [about.html](about.html) for the research background (Secretary Mode,
connection flow, implementation plan).
