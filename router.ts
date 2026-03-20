#!/usr/bin/env bun
/**
 * Telegram Router — central daemon that manages the Telegram bot and routes
 * messages to registered Claude Code sessions by chat_id + topic_id.
 *
 * Start once:  bun router.ts
 *
 * Sessions (session.ts) register via HTTP on the Unix socket at STATE_DIR/router.sock.
 *
 * Env:
 *   TELEGRAM_STATE_DIR   — state directory (default: ~/.claude/channels/telegram)
 *   TELEGRAM_BOT_TOKEN   — bot token (or set in STATE_DIR/.env)
 */

import { Bot, InputFile } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import type { Context } from 'grammy'
import { randomBytes } from 'crypto'
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync,
  renameSync, realpathSync, statSync, unlinkSync, existsSync,
} from 'fs'
import { homedir } from 'os'
import { join, extname, sep } from 'path'

// ── Config ──────────────────────────────────────────────────────────────

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const ROUTER_SOCK = join(STATE_DIR, 'router.sock')
const ROUTER_PID = join(STATE_DIR, 'router.pid')
const INBOX_DIR = join(STATE_DIR, 'inbox')

// Load .env
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(
    `telegram router: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

const bot = new Bot(TOKEN)
let botUsername = ''

// ── Types ───────────────────────────────────────────────────────────────

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

// ── Session Registry ────────────────────────────────────────────────────

type Session = {
  id: string
  chatId: string
  topicId: string       // specific ID, "0" for non-topic messages, "*" for catch-all
  label: string
  registeredAt: number
  controller: ReadableStreamDefaultController<Uint8Array> | null
}

const sessions = new Map<string, Session>()
const encoder = new TextEncoder()

// ── Topic Registry (auto-discovered from messages) ──────────────────────

type TopicInfo = {
  threadId: number
  name?: string
  chatId: string
  firstSeen: number
  lastSeen: number
}

const knownTopics = new Map<string, TopicInfo>() // key: "chatId:threadId"

function trackTopic(chatId: string, threadId: number, name?: string): void {
  const key = `${chatId}:${threadId}`
  const existing = knownTopics.get(key)
  if (existing) {
    existing.lastSeen = Date.now()
    if (name) existing.name = name
  } else {
    knownTopics.set(key, {
      threadId,
      name,
      chatId,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    })
  }
}

/** Resolve a topic identifier (numeric ID or name) to a thread ID. */
export function resolveTopicId(chatId: string, topicIdOrName: string): string {
  // Already numeric
  if (/^\d+$/.test(topicIdOrName) || topicIdOrName === '*' || topicIdOrName === '0') {
    return topicIdOrName
  }
  // Search by name (case-insensitive)
  const needle = topicIdOrName.toLowerCase()
  for (const t of knownTopics.values()) {
    if (t.chatId === chatId && t.name?.toLowerCase() === needle) {
      return String(t.threadId)
    }
  }
  // Not found — return as-is, will fail to match but won't crash
  process.stderr.write(
    `telegram router: topic "${topicIdOrName}" not found in chat ${chatId} — send a message in that topic first\n`,
  )
  return topicIdOrName
}

/** Find the session that should handle a message for the given chat + topic. */
export function findSession(chatId: string, topicId?: number): Session | undefined {
  const tid = String(topicId ?? 0)
  // Only match sessions that have an active SSE connection
  const connected = (s: Session) => s.controller !== null
  // 1. Exact match: chatId + topicId
  for (const s of sessions.values()) {
    if (connected(s) && s.chatId === chatId && s.topicId === tid) return s
  }
  // 2. Chat catch-all: chatId + *
  for (const s of sessions.values()) {
    if (connected(s) && s.chatId === chatId && s.topicId === '*') return s
  }
  // 3. Global catch-all: * + *
  for (const s of sessions.values()) {
    if (connected(s) && s.chatId === '*' && s.topicId === '*') return s
  }
  return undefined
}

/** Push an SSE event to a session's stream. */
function pushEvent(session: Session, event: string, data: unknown): boolean {
  if (!session.controller) return false
  try {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    session.controller.enqueue(encoder.encode(msg))
    return true
  } catch {
    return false
  }
}

// ── Access Control ──────────────────────────────────────────────────────

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`telegram router: access.json corrupt, moved aside.\n`)
    return defaultAccess()
  }
}

function loadAccess(): Access {
  return readAccessFile()
}

function saveAccess(a: Access): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function assertAllowedChat(chat_id: string): void {
  const access = loadAccess()
  if (access.allowFrom.includes(chat_id)) return
  if (chat_id in access.groups) return
  throw new Error(`chat ${chat_id} is not allowlisted`)
}

function gate(ctx: Context): GateResult {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    if (requireMention && !isMentioned(ctx, access.mentionPatterns)) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) {
      return true
    }
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ── Approval Polling ────────────────────────────────────────────────────

function checkApprovals(): void {
  let files: string[]
  try { files = readdirSync(APPROVED_DIR) } catch { return }
  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void bot.api.sendMessage(senderId, "Paired! Say hi to Claude.").then(
      () => rmSync(file, { force: true }),
      () => rmSync(file, { force: true }),
    )
  }
}

setInterval(checkApprovals, 5000)

// ── Tool Execution ──────────────────────────────────────────────────────

async function executeTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  switch (tool) {
    case 'reply': {
      const chat_id = args.chat_id as string
      const text = args.text as string
      const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
      const message_thread_id = args.message_thread_id != null ? Number(args.message_thread_id) : undefined
      const files = (args.files as string[] | undefined) ?? []

      assertAllowedChat(chat_id)

      for (const f of files) {
        assertSendable(f)
        const st = statSync(f)
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
        }
      }

      const access = loadAccess()
      const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
      const mode = access.chunkMode ?? 'length'
      const replyMode = access.replyToMode ?? 'first'
      const chunks = chunk(text, limit, mode)
      const sentIds: number[] = []

      try {
        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo =
            reply_to != null &&
            replyMode !== 'off' &&
            (replyMode === 'all' || i === 0)
          const sent = await bot.api.sendMessage(chat_id, chunks[i], {
            ...(message_thread_id != null ? { message_thread_id } : {}),
            ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
          })
          sentIds.push(sent.message_id)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(
          `reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`,
        )
      }

      for (const f of files) {
        const ext = extname(f).toLowerCase()
        const input = new InputFile(f)
        const opts = {
          ...(message_thread_id != null ? { message_thread_id } : {}),
          ...(reply_to != null && replyMode !== 'off'
            ? { reply_parameters: { message_id: reply_to } }
            : {}),
        }
        if (PHOTO_EXTS.has(ext)) {
          const sent = await bot.api.sendPhoto(chat_id, input, opts)
          sentIds.push(sent.message_id)
        } else {
          const sent = await bot.api.sendDocument(chat_id, input, opts)
          sentIds.push(sent.message_id)
        }
      }

      const result =
        sentIds.length === 1
          ? `sent (id: ${sentIds[0]})`
          : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
      return { content: [{ type: 'text', text: result }] }
    }

    case 'react': {
      assertAllowedChat(args.chat_id as string)
      await bot.api.setMessageReaction(args.chat_id as string, Number(args.message_id), [
        { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
      ])
      return { content: [{ type: 'text', text: 'reacted' }] }
    }

    case 'edit_message': {
      assertAllowedChat(args.chat_id as string)
      const edited = await bot.api.editMessageText(
        args.chat_id as string,
        Number(args.message_id),
        args.text as string,
      )
      const id = typeof edited === 'object' ? edited.message_id : args.message_id
      return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
    }

    case 'create_forum_topic': {
      const chat_id = args.chat_id as string
      const name = args.name as string
      assertAllowedChat(chat_id)
      const opts: Record<string, unknown> = {}
      if (args.icon_color != null) opts.icon_color = Number(args.icon_color)
      if (args.icon_custom_emoji_id != null) opts.icon_custom_emoji_id = args.icon_custom_emoji_id as string
      const topic = await bot.api.createForumTopic(chat_id, name, opts)
      return {
        content: [{ type: 'text', text: `created topic "${name}" (message_thread_id: ${topic.message_thread_id})` }],
      }
    }

    default:
      return {
        content: [{ type: 'text', text: `unknown tool: ${tool}` }],
        isError: true,
      }
  }
}

// ── Tool Schemas (served to sessions) ───────────────────────────────────

const toolSchemas = [
  {
    name: 'reply',
    description:
      'Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, message_thread_id for forum topics, and files (absolute paths) to attach images or documents.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' },
        reply_to: {
          type: 'string',
          description: 'Message ID to thread under. Use message_id from the inbound <channel> block.',
        },
        message_thread_id: {
          type: 'string',
          description: 'Forum topic thread ID. Pass this from the inbound <channel> block to reply in the same topic. Required for forum-enabled chats.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths to attach. Images send as photos (inline preview); other types as documents. Max 50MB each.',
        },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'react',
    description: 'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist — non-whitelisted emoji will be rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        emoji: { type: 'string' },
      },
      required: ['chat_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit a message the bot previously sent.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['chat_id', 'message_id', 'text'],
    },
  },
  {
    name: 'create_forum_topic',
    description: 'Create a new forum topic in a supergroup or private chat with topics enabled. The bot must be an administrator with can_manage_topics rights.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        name: { type: 'string', description: 'Topic name, 1-128 characters.' },
        icon_color: {
          type: 'number',
          description: 'Color of the topic icon in RGB format.',
        },
        icon_custom_emoji_id: { type: 'string' },
      },
      required: ['chat_id', 'name'],
    },
  },
]

// ── Inbound Message Handling ────────────────────────────────────────────

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
): Promise<void> {
  const chatId = String(ctx.chat?.id ?? '')
  const threadId = ctx.message?.message_thread_id
  const chatType = ctx.chat?.type
  const isTopic = ctx.message?.is_topic_message
  const forumTopic = (ctx.chat as any)?.is_forum

  // Track topic discovery
  if (threadId != null) {
    trackTopic(chatId, threadId)
  }
  process.stderr.write(
    `telegram router: inbound ${chatType} ${chatId} thread:${threadId ?? 'none'} is_topic:${isTopic} is_forum:${forumTopic} from:${ctx.from?.id} "${text.slice(0, 40)}"\n`,
  )

  const result = gate(ctx)

  if (result.action === 'drop') {
    process.stderr.write(`telegram router: dropped (gate: ${chatType} not in access.json groups)\n`)
    return
  }

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(
      `${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`,
    )
    return
  }

  const access = result.access
  const from = ctx.from!
  const msgId = ctx.message?.message_id
  const isTopicMessage = ctx.message?.is_topic_message

  // Find session for this chat + topic
  const session = findSession(chatId, threadId)
  if (!session) {
    process.stderr.write(
      `telegram router: no session for ${chatId}:${threadId ?? 'none'}, dropping\n`,
    )
    return
  }

  // Typing indicator
  void bot.api.sendChatAction(chatId, 'typing', {
    ...(threadId != null ? { message_thread_id: threadId } : {}),
  }).catch(() => {})

  // Ack reaction
  if (access.ackReaction && msgId != null) {
    void bot.api
      .setMessageReaction(chatId, msgId, [
        { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
      ])
      .catch(() => {})
  }

  const imagePath = downloadImage ? await downloadImage() : undefined

  // Push to session via SSE
  const pushed = pushEvent(session, 'message', {
    content: text,
    meta: {
      chat_id: chatId,
      ...(msgId != null ? { message_id: String(msgId) } : {}),
      ...(threadId != null ? { message_thread_id: String(threadId) } : {}),
      ...(isTopicMessage ? { is_topic_message: 'true' } : {}),
      user: from.username ?? String(from.id),
      user_id: String(from.id),
      ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
      ...(imagePath ? { image_path: imagePath } : {}),
    },
  })

  if (pushed) {
    process.stderr.write(
      `telegram router: → pushed to ${session.id} (${session.label})\n`,
    )
  } else {
    process.stderr.write(
      `telegram router: session ${session.id} not connected, message dropped\n`,
    )
  }
}

// ── HTTP Server ─────────────────────────────────────────────────────────

// Clean up stale socket
if (existsSync(ROUTER_SOCK)) {
  try { unlinkSync(ROUTER_SOCK) } catch {}
}

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

Bun.serve({
  unix: ROUTER_SOCK,
  idleTimeout: 255, // max value — SSE connections are long-lived
  async fetch(req) {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname

    // POST /sessions — register a session
    if (req.method === 'POST' && path === '/sessions') {
      const body = (await req.json()) as Record<string, unknown>
      const sessionId = body.sessionId as string | undefined
      const chatId = body.chatId as string | undefined
      const topicId = body.topicId as string | undefined
      const label = body.label as string | undefined
      if (!sessionId || !chatId) {
        return Response.json({ error: 'sessionId and chatId required' }, { status: 400 })
      }
      // Resolve topic name → ID if needed
      const resolvedTopicId = topicId ? resolveTopicId(chatId, topicId) : '*'
      // Clean up ALL old sessions with the same route (connected or not).
      // On resume, Claude Code spawns a new MCP process with a new session ID
      // while the old process may still be alive with an active SSE connection.
      for (const [id, s] of sessions) {
        if (id !== sessionId && s.chatId === chatId && s.topicId === resolvedTopicId) {
          try { s.controller?.close() } catch {}
          sessions.delete(id)
          process.stderr.write(`telegram router: replaced ${id}\n`)
        }
      }
      sessions.set(sessionId, {
        id: sessionId,
        chatId,
        topicId: resolvedTopicId,
        label: label ?? sessionId,
        registeredAt: Date.now(),
        controller: null,
      })
      process.stderr.write(
        `telegram router: + ${sessionId} → ${chatId}:${resolvedTopicId} (${label ?? sessionId})\n`,
      )
      return Response.json({ ok: true })
    }

    // DELETE /sessions/:id — deregister
    if (req.method === 'DELETE' && path.startsWith('/sessions/')) {
      const id = decodeURIComponent(path.slice('/sessions/'.length))
      const session = sessions.get(id)
      if (session) {
        try { session.controller?.close() } catch {}
        sessions.delete(id)
        process.stderr.write(`telegram router: - ${id}\n`)
      }
      return Response.json({ ok: true })
    }

    // GET /events/:sessionId — SSE stream
    if (req.method === 'GET' && path.startsWith('/events/')) {
      const id = decodeURIComponent(path.slice('/events/'.length))
      const session = sessions.get(id)
      if (!session) {
        return Response.json({ error: 'session not found — register first' }, { status: 404 })
      }

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Close previous SSE connection if any (reconnect case)
          if (session.controller) {
            try { session.controller.close() } catch {}
          }
          session.controller = controller
          controller.enqueue(encoder.encode('event: connected\ndata: {}\n\n'))
          process.stderr.write(`telegram router: SSE connected for ${id}\n`)
        },
        cancel() {
          session.controller = null
          process.stderr.write(`telegram router: SSE disconnected for ${id}\n`)
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      })
    }

    // POST /tool — execute a tool call on behalf of a session
    if (req.method === 'POST' && path === '/tool') {
      const body = (await req.json()) as Record<string, unknown>
      const sessionId = body.sessionId as string
      const tool = body.tool as string
      const args = body.args as Record<string, unknown>
      if (!sessions.has(sessionId)) {
        return Response.json({ error: 'session not registered' }, { status: 404 })
      }
      try {
        const result = await executeTool(tool, args)
        return Response.json(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return Response.json(
          { content: [{ type: 'text', text: `${tool} failed: ${msg}` }], isError: true },
        )
      }
    }

    // GET /tools — tool schemas for sessions
    if (req.method === 'GET' && path === '/tools') {
      return Response.json({ tools: toolSchemas })
    }

    // GET /topics — list discovered topics
    if (req.method === 'GET' && path === '/topics') {
      const chatFilter = url.searchParams.get('chat')
      const topics = Array.from(knownTopics.values())
        .filter(t => !chatFilter || t.chatId === chatFilter)
        .sort((a, b) => a.threadId - b.threadId)
        .map(t => ({
          threadId: t.threadId,
          name: t.name ?? null,
          chatId: t.chatId,
          firstSeen: new Date(t.firstSeen).toISOString(),
          lastSeen: new Date(t.lastSeen).toISOString(),
        }))
      return Response.json({ topics })
    }

    // GET /health — status overview
    if (req.method === 'GET' && path === '/health') {
      return Response.json({
        ok: true,
        botUsername,
        uptime: process.uptime(),
        topics: Array.from(knownTopics.values()).map(t => ({
          threadId: t.threadId,
          name: t.name ?? null,
          chatId: t.chatId,
        })),
        sessions: Array.from(sessions.values()).map(s => ({
          id: s.id,
          chatId: s.chatId,
          topicId: s.topicId,
          label: s.label,
          connected: s.controller !== null,
          registeredAt: s.registeredAt,
        })),
      })
    }

    return Response.json({ error: 'not found' }, { status: 404 })
  },
})

// ── Bot Handlers ────────────────────────────────────────────────────────

// Track topic creation/edits to learn topic names
bot.on('message:forum_topic_created', ctx => {
  const chatId = String(ctx.chat.id)
  const threadId = ctx.message.message_thread_id
  const name = ctx.message.forum_topic_created.name
  if (threadId != null) {
    trackTopic(chatId, threadId, name)
    process.stderr.write(`telegram router: topic discovered: ${chatId}:${threadId} "${name}"\n`)
  }
})

bot.on('message:forum_topic_edited', ctx => {
  const chatId = String(ctx.chat.id)
  const threadId = ctx.message.message_thread_id
  const name = ctx.message.forum_topic_edited.name
  if (threadId != null && name) {
    trackTopic(chatId, threadId, name)
    process.stderr.write(`telegram router: topic renamed: ${chatId}:${threadId} → "${name}"\n`)
  }
})

bot.on('message:text', async ctx => {
  await handleInbound(ctx, ctx.message.text, undefined)
})

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) {
      process.stderr.write(`telegram router: photo download failed: ${err}\n`)
      return undefined
    }
  })
})

// ── Cleanup ─────────────────────────────────────────────────────────────

function cleanup() {
  // Close all SSE connections
  for (const session of sessions.values()) {
    try { session.controller?.close() } catch {}
  }
  try { unlinkSync(ROUTER_SOCK) } catch {}
  try { unlinkSync(ROUTER_PID) } catch {}
  process.exit(0)
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)

// Write PID
writeFileSync(ROUTER_PID, String(process.pid), { mode: 0o600 })

// ── Start ───────────────────────────────────────────────────────────────

void bot.start({
  onStart: info => {
    botUsername = info.username
    process.stderr.write(`telegram router: polling as @${info.username}\n`)
    process.stderr.write(`telegram router: socket ${ROUTER_SOCK}\n`)
  },
})
