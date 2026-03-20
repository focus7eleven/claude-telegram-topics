# Telegram Channel for Claude Code

Connect a Telegram bot to Claude Code. Messages to the bot are forwarded to your Claude Code session; Claude replies through the bot.

Two modes:

- **Standalone** — one bot, one Claude Code session. Install and go.
- **Routed** — one bot, multiple Claude Code sessions. Each session handles a specific forum topic. Requires a router daemon.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`

## Quick Start (Standalone)

> Default setup for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user configuration.

### 1. Create a bot

Open [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`. You'll get a token like `123456789:AAHfiqksKZ8...` — copy it.

### 2. Install the plugin

```
/plugin install telegram@claude-plugins-official
```

### 3. Configure the token

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Saves the token to `~/.claude/channels/telegram/.env`.

### 4. Start Claude Code with the channel

```sh
claude --channels plugin:telegram@claude-plugins-official
```

### 5. Pair

DM your bot on Telegram — it replies with a 6-character code. In Claude Code:

```
/telegram:access pair <code>
```

Done. Your messages now reach the assistant.

### 6. Lock down

Once paired, switch to `allowlist` mode so strangers don't get pairing prompts:

```
/telegram:access policy allowlist
```

## Multi-Topic Mode (Routed)

For forum-enabled Telegram groups where each topic maps to a separate Claude Code session:

```
Telegram Group
├── Topic: project-a/main  → Claude Code session A
├── Topic: project-a/dev   → Claude Code session B
└── Topic: project-b/main  → Claude Code session C
```

### Setup

**1. Prepare the group.**

Your Telegram group needs a few settings:

- **Topics enabled** — Group Settings → Topics → turn on.
- **Bot added as admin** — add your bot to the group, then promote to admin (at minimum `can_manage_topics`).
- **Privacy Mode disabled** _(optional)_ — BotFather → `/setprivacy` → Disable. Without this, the bot only sees `@mentions` and direct replies, which is fine for most use cases.

**2. Find your group's chat ID.**

Three ways, pick whichever is easiest:

| Method | How |
| --- | --- |
| **Telegram Web** | Open the group in [web.telegram.org](https://web.telegram.org). The URL looks like `https://web.telegram.org/a/#-100XXXXXXXXXX`. The number after `#` (including the `-`) is your chat ID. |
| **@RawDataBot** | Add [@RawDataBot](https://t.me/RawDataBot) to the group, send any message, it replies with the chat ID. Remove the bot afterwards. |
| **Router log** | If you already have a session running, `@mention` your bot in the group. The router logs `inbound supergroup -100XXXXXXXXXX ...` — that's the chat ID. |

**3. Configure the group in Claude Code.**

```
/telegram:configure group -100XXXXXXXXXX
```

This saves the chat ID and adds the group to the access list in one step.

**4. Find topic IDs.**

Each forum topic has a numeric thread ID. Three ways to find them:

| Method | How |
| --- | --- |
| **Topic link** | Right-click a topic → Copy Link. The URL looks like `https://t.me/c/XXXXXXXXXX/42`. The last number (`42`) is the thread ID. |
| **Topic name** | You can use the topic name instead of the numeric ID. The router resolves names automatically after seeing at least one message in that topic. |
| **`/telegram:configure topics`** | After sending a message in each topic, run this skill. It queries the router and shows a table of all discovered topics with their IDs and names. |

> **Note:** The "General" topic may not carry a thread ID in Bot API. Always use named topics.

**5. Start Claude Code sessions** (one per topic):

```sh
# By topic ID
TELEGRAM_TOPIC_ID=42 claude --channels plugin:telegram@<marketplace>

# By topic name (easier to remember)
TELEGRAM_TOPIC_ID=my-topic claude --channels plugin:telegram@<marketplace>

# Catch-all (receive messages from ALL topics)
TELEGRAM_TOPIC_ID='*' claude --channels plugin:telegram@<marketplace>
```

The **first session auto-starts a router daemon** in the background. Subsequent sessions connect to it automatically. No manual daemon management.

**6. Verify.**

```
/telegram:configure topics
```

Shows discovered topics, connected sessions, and router status.

### Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | Routed mode | Group chat ID (triggers routed mode) |
| `TELEGRAM_TOPIC_ID` | Routed mode | Topic thread ID, name, or `*` for catch-all |
| `TELEGRAM_SESSION_LABEL` | No | Human-readable label for this session |
| `TELEGRAM_STATE_DIR` | No | Override state directory (default: `~/.claude/channels/telegram`) |
| `TELEGRAM_ACCESS_MODE` | No | Set to `static` to snapshot access at boot |

Variables can be set in the shell, in `~/.claude/channels/telegram/.env`, or both. Shell takes precedence.

## Tools

| Tool | Description |
| --- | --- |
| `reply` | Send text/files to a chat. Supports `reply_to` for threading, `message_thread_id` for forum topics, `files` for attachments (images inline, others as documents, max 50 MB). Auto-chunks text at 4096 chars. |
| `react` | Add emoji reaction. Only Telegram's fixed whitelist. |
| `edit_message` | Edit a previously sent message. |
| `create_forum_topic` | Create a topic in a forum-enabled chat. Requires `can_manage_topics` admin right. |

## Access Control

See **[ACCESS.md](./ACCESS.md)** for full documentation on DM policies, group management, mention detection, and delivery configuration.

Quick reference:
- IDs are **numeric Telegram user IDs** (get yours from [@userinfobot](https://t.me/userinfobot))
- Default DM policy: `pairing` (issues 6-char codes, 1h expiry)
- Ack reactions only accept Telegram's fixed emoji whitelist
- Access is managed via `/telegram:access` — never from channel messages (prompt injection protection)

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/`. The path is included in the notification so the assistant can `Read` it. Telegram compresses photos — send as a document (long-press → Send as File) for originals.

## Limitations

- **No history or search** — Telegram's Bot API has no message history endpoint. The bot only sees messages as they arrive.
- **General topic** — The default "General" topic in forum groups may not include `message_thread_id` in Bot API responses. Use named topics.
- **Single bot token** — Only one process can long-poll a bot token. In routed mode, the router holds the token; in standalone mode, the MCP server holds it. Don't run both simultaneously with the same token.
