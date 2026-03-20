#!/usr/bin/env bun
/**
 * Telegram channel for Claude Code — entry point.
 *
 * Loads .env, then starts a routed session that connects to the router daemon.
 * The router auto-starts in the background if not already running.
 *
 * Env (all optional except token):
 *   TELEGRAM_BOT_TOKEN     — bot token (required)
 *   TELEGRAM_CHAT_ID       — restrict to this chat (optional, default: all chats)
 *   TELEGRAM_TOPIC_ID      — restrict to this topic (optional, default: all topics)
 *   TELEGRAM_STATE_DIR     — state directory (default: ~/.claude/channels/telegram)
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Load .env before session starts.
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ENV_FILE = join(STATE_DIR, '.env')
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

await import('./session.ts')
