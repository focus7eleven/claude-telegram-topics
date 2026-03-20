---
name: configure
description: Set up the Telegram channel — save the bot token, configure multi-topic routing, and review status. Use when the user pastes a Telegram bot token, asks to configure Telegram, asks "how do I set this up", wants to enable group topics, or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(curl *)
---

# /telegram:configure — Telegram Channel Setup

Writes config to `~/.claude/channels/telegram/.env` and orients the
user on access policy. The server reads this file at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Token** — check `~/.claude/channels/telegram/.env` for
   `TELEGRAM_BOT_TOKEN`. Show set/not-set; if set, show first 10 chars masked
   (`123456789:...`).

2. **Mode** — check for `TELEGRAM_CHAT_ID` in `.env`:
   - Not set → *standalone mode* (all messages go to one session)
   - Set → *multi-topic mode* (each topic can have its own session)
   Show the chat_id and configured topic if any.

3. **Access** — read `~/.claude/channels/telegram/access.json` (missing file
   = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count, and list display names or IDs
   - Groups: list configured groups
   - Pending pairings: count, with codes if any

4. **Router** — if in multi-topic mode, check if router is running:
   `curl -s --unix-socket ~/.claude/channels/telegram/router.sock http://localhost/health`
   Show router status, connected sessions, and discovered topics.

5. **What next** — end with a concrete next step based on state:
   - No token → *"Run `/telegram:configure <token>` with the token from
     BotFather."*
   - Token set, nobody allowed → *"DM your bot on Telegram. It replies with
     a code; approve with `/telegram:access pair <code>`."*
   - Token set, someone allowed → *"Ready. Start with
     `claude --channels plugin:telegram@<marketplace>`."*

**Push toward lockdown.** Once IDs are captured via pairing, prompt the user
to switch to `allowlist`.

### `<token>` — save it

1. Treat `$ARGUMENTS` as the token (trim whitespace). BotFather tokens look
   like `123456789:AAH...` — numeric prefix, colon, long string.
2. `mkdir -p ~/.claude/channels/telegram`
3. Read existing `.env` if present; update/add the `TELEGRAM_BOT_TOKEN=` line,
   preserve other keys. Write back, no quotes around the value.
4. Confirm, then show the no-args status so the user sees where they stand.

### `group <chat_id>` — enable multi-topic mode

1. Save `TELEGRAM_CHAT_ID=<chat_id>` to `.env` (update if exists, preserve
   other keys).
2. Also add the group to `access.json` if not already there (same as
   `/telegram:access group add <chat_id>`).
3. Explain:
   - *"Multi-topic mode enabled. Each forum topic can now have its own Claude
     Code session."*
   - *"Start sessions with:
     `TELEGRAM_TOPIC_ID=<id-or-name> claude --channels plugin:telegram@<marketplace>`"*
   - *"The router starts automatically — no manual setup needed."*
   - *"To discover topic IDs, send a message in each topic, then run
     `/telegram:configure` to see them."*

### `topics` — show discovered topics

If the router is running, query it:
`curl -s --unix-socket ~/.claude/channels/telegram/router.sock http://localhost/topics`

Display results as a table:

```
Thread ID  │ Name         │ Last seen
───────────┼──────────────┼──────────────
9          │ cc-plugin    │ 2 min ago
42         │ project-b    │ 15 min ago
```

If the router isn't running, say: *"No router running. Start a session first —
the router starts automatically."*

### `clear` — remove the token

Delete the `TELEGRAM_BOT_TOKEN=` line (or the file if that's the only line).

### `reset` — remove multi-topic config

Remove `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_ID`, and `TELEGRAM_SESSION_LABEL`
from `.env`. This reverts to standalone mode.

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. Token/config changes need a session
  restart or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes take
  effect immediately.
- When showing router info, `curl` to the Unix socket may fail if the router
  isn't running — handle gracefully.
