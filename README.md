# Telegram Channel for Claude Code

Connect a Telegram bot to Claude Code. Messages to the bot are forwarded to your Claude Code session; Claude replies through the bot.

Supports DMs, group chats, and **forum topics** — each topic can route to a separate Claude Code session working in a different project.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- Claude Code v1.0.33+

## Installation

Claude Code's channel allowlist currently only permits plugins from the official marketplace (`claude-plugins-official`). Since this plugin is distributed through a self-hosted marketplace, you need to install **both** the official telegram plugin (for allowlist access) and this plugin (for the actual code).

### Step 1: Install both plugins

```
/plugin install telegram@claude-plugins-official
/plugin marketplace add focus7eleven/claude-telegram-topics
/plugin install telegram@claude-telegram-topics
```

The official plugin provides the channel permission. Our plugin provides the actual code and automatically patches the official plugin's cache on every session start — no manual steps needed.

> **Why two plugins?** Claude Code's channel allowlist only permits plugins from the official marketplace. Until this plugin is accepted there, we need the official plugin as a shim. Once accepted, you'll only need one install.

### Step 2: Create a bot and configure the token

Open [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, copy the token.

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

### Step 3: Start Claude Code with the channel

```sh
claude --channels plugin:telegram@claude-plugins-official
```

### Step 4: Pair

DM your bot on Telegram — it replies with a 6-character code. In Claude Code:

```
/telegram:access pair <code>
```

Done. Your messages now reach the assistant.

### Step 5: Lock down

Switch to `allowlist` so strangers don't get pairing prompts:

```
/telegram:access policy allowlist
```

## Forum Topics (Multi-Session)

Each forum topic can route to a separate Claude Code session:

```
Telegram Group
├── Topic: project-a  → Claude Code session A
├── Topic: project-b  → Claude Code session B
└── DMs               → Claude Code session C (catch-all)
```

A **router daemon** auto-starts in the background when the first session launches. Subsequent sessions connect to it automatically. No manual daemon management.

### Setup

**1. Prepare the group.**

- **Topics enabled** — Group Settings → Topics → turn on.
- **Bot added as admin** — add your bot to the group, promote to admin.
- **Privacy Mode disabled** _(optional)_ — BotFather → `/setprivacy` → Disable. Without this, the bot only sees @mentions and direct replies.

**2. Find your group's chat ID.**

| Method | How |
| --- | --- |
| **Telegram Web** | Open the group in [web.telegram.org](https://web.telegram.org). The URL looks like `https://web.telegram.org/a/#-100XXXXXXXXXX`. The number after `#` (including the `-`) is your chat ID. |
| **@RawDataBot** | Add [@RawDataBot](https://t.me/RawDataBot) to the group, send any message, it replies with the chat ID. Remove the bot afterwards. |

**3. Configure the group.**

```
/telegram:configure group -100XXXXXXXXXX
```

This saves the chat ID to `.env` and adds the group to the access list.

**4. Find topic IDs.**

| Method | How |
| --- | --- |
| **Topic link** | Right-click a topic → Copy Link. URL: `https://t.me/c/XXXXXXXXXX/42` — the last number (`42`) is the thread ID. |
| **Topic name** | Use the topic name instead of numeric ID. The router resolves names after seeing at least one message in that topic. |
| **`/telegram:configure topics`** | Lists all discovered topics with IDs and names. |

> **Note:** The "General" topic may not carry a thread ID in Bot API. Use named topics.

**5. Start sessions.**

```sh
# Specific topic (by ID or name)
TELEGRAM_TOPIC_ID=42 claude --channels plugin:telegram@claude-plugins-official
TELEGRAM_TOPIC_ID=my-topic claude --channels plugin:telegram@claude-plugins-official

# Catch-all (DMs + all unmatched topics)
claude --channels plugin:telegram@claude-plugins-official
```

### Auto-allow tool permissions

To avoid being prompted for permission on every reply, add this to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_telegram_telegram__reply",
      "mcp__plugin_telegram_telegram__react",
      "mcp__plugin_telegram_telegram__edit_message",
      "mcp__plugin_telegram_telegram__create_forum_topic"
    ]
  }
}
```

### Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | No | `*` (all) | Restrict to a specific group chat |
| `TELEGRAM_TOPIC_ID` | No | `*` (all) | Restrict to a specific topic |
| `TELEGRAM_SESSION_LABEL` | No | auto | Human-readable session label |
| `TELEGRAM_STATE_DIR` | No | `~/.claude/channels/telegram` | State directory |

Variables can be set in shell or in `~/.claude/channels/telegram/.env`. Shell takes precedence.

## Tools

| Tool | Description |
| --- | --- |
| `reply` | Send text/files to a chat. Supports `reply_to`, `message_thread_id`, `files`. Auto-chunks at 4096 chars. |
| `react` | Add emoji reaction. Telegram's fixed whitelist only. |
| `edit_message` | Edit a previously sent message. |
| `create_forum_topic` | Create a topic in a forum-enabled chat. |

## Access Control

See **[ACCESS.md](./ACCESS.md)** for full documentation.

Quick reference:
- IDs are **numeric Telegram user IDs** ([@userinfobot](https://t.me/userinfobot))
- Default DM policy: `pairing` → switch to `allowlist` after setup
- Access managed via `/telegram:access` — never from channel messages

## Limitations

- **No history or search** — Bot API has no message history endpoint.
- **General topic** — may not include `message_thread_id`. Use named topics.
- **Single bot token** — only one long-polling connection per token. The router handles this automatically.
