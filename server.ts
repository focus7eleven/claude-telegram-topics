#!/usr/bin/env bun
/**
 * Telegram channel for Claude Code — entry point.
 *
 * Mode detection:
 *   - TELEGRAM_CHAT_ID set → routed mode (session.ts, requires router.ts daemon)
 *   - Otherwise            → standalone mode (standalone.ts, runs bot directly)
 *
 * STATE_DIR is configurable via TELEGRAM_STATE_DIR env var
 * (default: ~/.claude/channels/telegram).
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Load .env BEFORE mode detection so TELEGRAM_CHAT_ID can be set there.
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ENV_FILE = join(STATE_DIR, '.env')
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

if (process.env.TELEGRAM_CHAT_ID) {
  await import('./session.ts')
} else {
  await import('./standalone.ts')
}
