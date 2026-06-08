# telegram setup

The monitor posts to two separate Telegram destinations:

- **public channel** — community-facing posts (trending, volume, price, milestones, daily updates)
- **ops group** — private alerts for health warnings and critical issues

Both are optional. Set neither and Telegram posting is simply skipped.
Set only one and the other falls back gracefully.

---

## 1. create a bot

1. open Telegram and search for `@BotFather`
2. send `/newbot`
3. pick a name and username
4. copy the token it gives you — that's your `TELEGRAM_BOT_TOKEN`

---

## 2. get your channel/group ID

For a **public channel**: the ID is `@your_channel_username`.
For a **private channel or group**: forward any message from it to `@userinfobot` and it'll show the numeric ID (starts with `-100`).

Set `TELEGRAM_CHAT_ID` to your public channel ID.
Set `TELEGRAM_OPS_CHAT_ID` to your private ops group ID.
If you leave `TELEGRAM_OPS_CHAT_ID` unset, ops alerts go to the same channel as public posts.

---

## 3. add the bot to your channels

For each channel/group:
1. open the channel settings → Administrators
2. add your bot as admin
3. give it permission to post messages

---

## 4. add secrets to Supabase

Dashboard → Project Settings → Edge Functions → secrets:

```
TELEGRAM_BOT_TOKEN      your bot token from BotFather
TELEGRAM_CHAT_ID        public channel id
TELEGRAM_OPS_CHAT_ID    private ops group id (optional)
```
