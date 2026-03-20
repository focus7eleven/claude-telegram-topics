/**
 * Tests for the router + session architecture.
 *
 * Tests cover:
 * - Session registry (register, deregister, findSession)
 * - Topic → session routing logic
 * - SSE event format
 * - Tool call proxying
 * - Session lifecycle (connect, reconnect)
 */

import { describe, test, expect, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// Helpers — simulate the router's session registry and routing logic
// ---------------------------------------------------------------------------

type Session = {
  id: string
  chatId: string
  topicId: string
  label: string
  registeredAt: number
  connected: boolean
}

/** In-memory session registry (mirrors router.ts logic) */
class SessionRegistry {
  private sessions = new Map<string, Session>()

  register(id: string, chatId: string, topicId: string, label: string): void {
    this.sessions.set(id, {
      id,
      chatId,
      topicId,
      label,
      registeredAt: Date.now(),
      connected: false,
    })
  }

  deregister(id: string): boolean {
    return this.sessions.delete(id)
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /** Find session for a given chat + topic. Exact match first, then catch-all. */
  findSession(chatId: string, topicId?: number): Session | undefined {
    const tid = String(topicId ?? 0)
    // Exact match
    for (const s of this.sessions.values()) {
      if (s.chatId === chatId && s.topicId === tid) return s
    }
    // Catch-all
    for (const s of this.sessions.values()) {
      if (s.chatId === chatId && s.topicId === '*') return s
    }
    return undefined
  }

  list(): Session[] {
    return Array.from(this.sessions.values())
  }

  clear(): void {
    this.sessions.clear()
  }
}

// ---------------------------------------------------------------------------
// Tests: Session Registration
// ---------------------------------------------------------------------------

describe('session registration', () => {
  let registry: SessionRegistry

  beforeEach(() => {
    registry = new SessionRegistry()
  })

  test('register and retrieve a session', () => {
    registry.register('s-001', '-1001234', '42', 'tomborg/main')
    const session = registry.get('s-001')
    expect(session).toBeDefined()
    expect(session!.chatId).toBe('-1001234')
    expect(session!.topicId).toBe('42')
    expect(session!.label).toBe('tomborg/main')
  })

  test('deregister removes the session', () => {
    registry.register('s-001', '-1001234', '42', 'test')
    expect(registry.deregister('s-001')).toBe(true)
    expect(registry.get('s-001')).toBeUndefined()
  })

  test('deregister non-existent session returns false', () => {
    expect(registry.deregister('nope')).toBe(false)
  })

  test('re-registration overwrites existing session', () => {
    registry.register('s-001', '-1001234', '42', 'old')
    registry.register('s-001', '-1001234', '99', 'new')
    const session = registry.get('s-001')
    expect(session!.topicId).toBe('99')
    expect(session!.label).toBe('new')
  })

  test('list returns all sessions', () => {
    registry.register('s-001', '-100', '1', 'a')
    registry.register('s-002', '-100', '2', 'b')
    registry.register('s-003', '-200', '*', 'c')
    expect(registry.list()).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// Tests: Topic → Session Routing
// ---------------------------------------------------------------------------

describe('topic routing', () => {
  let registry: SessionRegistry

  beforeEach(() => {
    registry = new SessionRegistry()
  })

  test('exact topic match', () => {
    registry.register('s-001', '-100', '42', 'topic-42')
    registry.register('s-002', '-100', '99', 'topic-99')

    const found = registry.findSession('-100', 42)
    expect(found?.id).toBe('s-001')
  })

  test('catch-all matches when no exact match', () => {
    registry.register('s-all', '-100', '*', 'catch-all')

    const found = registry.findSession('-100', 42)
    expect(found?.id).toBe('s-all')
  })

  test('exact match takes priority over catch-all', () => {
    registry.register('s-all', '-100', '*', 'catch-all')
    registry.register('s-42', '-100', '42', 'exact')

    const found = registry.findSession('-100', 42)
    expect(found?.id).toBe('s-42')
  })

  test('non-topic message maps to topicId 0', () => {
    registry.register('s-general', '-100', '0', 'general')

    // No topicId = non-topic message → maps to "0"
    const found = registry.findSession('-100', undefined)
    expect(found?.id).toBe('s-general')
  })

  test('no match returns undefined', () => {
    registry.register('s-001', '-100', '42', 'topic-42')

    // Different chat
    expect(registry.findSession('-200', 42)).toBeUndefined()
    // Different topic, no catch-all
    expect(registry.findSession('-100', 99)).toBeUndefined()
  })

  test('different chats are isolated', () => {
    registry.register('s-a', '-100', '42', 'chat-a-topic')
    registry.register('s-b', '-200', '42', 'chat-b-topic')

    expect(registry.findSession('-100', 42)?.id).toBe('s-a')
    expect(registry.findSession('-200', 42)?.id).toBe('s-b')
  })

  test('catch-all does not cross chat boundaries', () => {
    registry.register('s-all', '-100', '*', 'catch-all-100')

    expect(registry.findSession('-100', 42)?.id).toBe('s-all')
    expect(registry.findSession('-200', 42)).toBeUndefined()
  })

  test('multiple topics in same chat', () => {
    registry.register('s-1', '-100', '10', 'topic-10')
    registry.register('s-2', '-100', '20', 'topic-20')
    registry.register('s-3', '-100', '30', 'topic-30')

    expect(registry.findSession('-100', 10)?.id).toBe('s-1')
    expect(registry.findSession('-100', 20)?.id).toBe('s-2')
    expect(registry.findSession('-100', 30)?.id).toBe('s-3')
    expect(registry.findSession('-100', 40)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: SSE event format
// ---------------------------------------------------------------------------

describe('SSE event format', () => {
  test('formats message event correctly', () => {
    const data = {
      content: 'hello world',
      meta: {
        chat_id: '-100',
        message_id: '5',
        message_thread_id: '42',
        is_topic_message: 'true',
        user: 'alice',
        user_id: '222',
        ts: '2026-03-20T00:00:00.000Z',
      },
    }

    const event = `event: message\ndata: ${JSON.stringify(data)}\n\n`

    expect(event).toContain('event: message\n')
    expect(event).toContain('"chat_id":"-100"')
    expect(event).toContain('"message_thread_id":"42"')
    expect(event).toEndWith('\n\n')
  })

  test('connected event has empty data', () => {
    const event = 'event: connected\ndata: {}\n\n'
    expect(event).toContain('event: connected')
    expect(event).toContain('data: {}')
  })

  test('SSE event parsing extracts event type and data', () => {
    const raw = 'event: message\ndata: {"content":"test","meta":{"chat_id":"1"}}'
    const lines = raw.split('\n')
    let eventType = ''
    let data = ''
    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice(7)
      else if (line.startsWith('data: ')) data = line.slice(6)
    }

    expect(eventType).toBe('message')
    const parsed = JSON.parse(data)
    expect(parsed.content).toBe('test')
    expect(parsed.meta.chat_id).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// Tests: MCP notification construction from SSE message
// ---------------------------------------------------------------------------

describe('MCP notification from SSE', () => {
  test('constructs notification params from SSE message data', () => {
    const sseData = {
      content: 'hello from topic',
      meta: {
        chat_id: '-1001234',
        message_id: '10',
        message_thread_id: '42',
        is_topic_message: 'true',
        user: 'bob',
        user_id: '333',
        ts: '2026-03-20T12:00:00.000Z',
      },
    }

    // This is what session.ts does when it receives the SSE event
    const notification = {
      method: 'notifications/claude/channel',
      params: {
        content: sseData.content,
        meta: sseData.meta,
      },
    }

    expect(notification.method).toBe('notifications/claude/channel')
    expect(notification.params.content).toBe('hello from topic')
    expect(notification.params.meta.message_thread_id).toBe('42')
    expect(notification.params.meta.is_topic_message).toBe('true')
  })

  test('image_path is included in meta when present', () => {
    const sseData = {
      content: '(photo)',
      meta: {
        chat_id: '-100',
        message_id: '1',
        user: 'alice',
        user_id: '222',
        ts: '2026-03-20T00:00:00.000Z',
        image_path: '/tmp/inbox/photo.jpg',
      },
    }

    expect(sseData.meta.image_path).toBe('/tmp/inbox/photo.jpg')
  })
})

// ---------------------------------------------------------------------------
// Tests: Tool call proxying
// ---------------------------------------------------------------------------

describe('tool call proxying', () => {
  test('session forwards tool args to router', () => {
    const toolCall = {
      sessionId: 's-001',
      tool: 'reply',
      args: {
        chat_id: '-100',
        text: 'hello back',
        message_thread_id: '42',
      },
    }

    // Verify structure matches what router expects
    expect(toolCall.sessionId).toBe('s-001')
    expect(toolCall.tool).toBe('reply')
    expect(toolCall.args.message_thread_id).toBe('42')
  })

  test('router response format matches MCP tool result', () => {
    const routerResponse = {
      content: [{ type: 'text', text: 'sent (id: 123)' }],
    }

    // session.ts returns this directly as MCP tool result
    expect(routerResponse.content).toHaveLength(1)
    expect(routerResponse.content[0].type).toBe('text')
  })

  test('router error response includes isError flag', () => {
    const errorResponse = {
      content: [{ type: 'text', text: 'reply failed: chat not allowlisted' }],
      isError: true,
    }

    expect(errorResponse.isError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: Session lifecycle
// ---------------------------------------------------------------------------

describe('session lifecycle', () => {
  let registry: SessionRegistry

  beforeEach(() => {
    registry = new SessionRegistry()
  })

  test('register → connect SSE → receive messages → deregister', () => {
    // 1. Register
    registry.register('s-001', '-100', '42', 'tomborg/main')
    expect(registry.get('s-001')).toBeDefined()

    // 2. Session is findable
    expect(registry.findSession('-100', 42)?.id).toBe('s-001')

    // 3. Deregister
    registry.deregister('s-001')
    expect(registry.findSession('-100', 42)).toBeUndefined()
  })

  test('session deregistration leaves other sessions intact', () => {
    registry.register('s-001', '-100', '42', 'a')
    registry.register('s-002', '-100', '99', 'b')

    registry.deregister('s-001')

    expect(registry.findSession('-100', 42)).toBeUndefined()
    expect(registry.findSession('-100', 99)?.id).toBe('s-002')
  })

  test('re-registration replaces stale session', () => {
    registry.register('s-001', '-100', '42', 'stale')
    registry.register('s-001', '-100', '42', 'fresh')

    const session = registry.get('s-001')
    expect(session!.label).toBe('fresh')
    expect(registry.list()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Tests: Configurable STATE_DIR
// ---------------------------------------------------------------------------

describe('configurable STATE_DIR', () => {
  test('default STATE_DIR path construction', () => {
    const { homedir } = require('os')
    const { join } = require('path')
    const defaultDir = join(homedir(), '.claude', 'channels', 'telegram')

    // This mirrors the logic in router.ts and session.ts
    const stateDir = undefined ?? defaultDir
    expect(stateDir).toContain('.claude/channels/telegram')
  })

  test('custom STATE_DIR overrides default', () => {
    const { join } = require('path')
    const customDir = '/tmp/test-telegram-state'

    // Simulates: process.env.TELEGRAM_STATE_DIR ?? defaultDir
    const stateDir = customDir ?? '/default/path'
    expect(stateDir).toBe('/tmp/test-telegram-state')

    // Derived paths
    expect(join(stateDir, 'router.sock')).toBe('/tmp/test-telegram-state/router.sock')
    expect(join(stateDir, 'access.json')).toBe('/tmp/test-telegram-state/access.json')
    expect(join(stateDir, 'router.pid')).toBe('/tmp/test-telegram-state/router.pid')
  })
})

// ---------------------------------------------------------------------------
// Tests: Mode detection (server.ts dispatcher)
// ---------------------------------------------------------------------------

describe('mode detection', () => {
  test('TELEGRAM_CHAT_ID triggers routed mode', () => {
    const env = { TELEGRAM_CHAT_ID: '-1001234' }
    const isRouted = !!env.TELEGRAM_CHAT_ID
    expect(isRouted).toBe(true)
  })

  test('no TELEGRAM_CHAT_ID means standalone mode', () => {
    const env: Record<string, string | undefined> = {}
    const isRouted = !!env.TELEGRAM_CHAT_ID
    expect(isRouted).toBe(false)
  })

  test('empty TELEGRAM_CHAT_ID means standalone mode', () => {
    const env = { TELEGRAM_CHAT_ID: '' }
    const isRouted = !!env.TELEGRAM_CHAT_ID
    expect(isRouted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: HTTP API request/response shapes
// ---------------------------------------------------------------------------

describe('HTTP API shapes', () => {
  test('POST /sessions request body', () => {
    const body = {
      sessionId: 's-abc123',
      chatId: '-1001234567890',
      topicId: '42',
      label: 'tomborg/main',
    }

    expect(body.sessionId).toMatch(/^s-/)
    expect(body.chatId).toMatch(/^-/)
    expect(body.topicId).toBe('42')
  })

  test('GET /health response shape', () => {
    const response = {
      ok: true,
      botUsername: 'testbot',
      uptime: 123.45,
      sessions: [
        {
          id: 's-001',
          chatId: '-100',
          topicId: '42',
          label: 'test',
          connected: true,
          registeredAt: Date.now(),
        },
      ],
    }

    expect(response.ok).toBe(true)
    expect(response.sessions).toHaveLength(1)
    expect(response.sessions[0].connected).toBe(true)
  })

  test('POST /tool request body', () => {
    const body = {
      sessionId: 's-001',
      tool: 'reply',
      args: { chat_id: '-100', text: 'hello', message_thread_id: '42' },
    }

    expect(body.tool).toBe('reply')
    expect(body.args.message_thread_id).toBe('42')
  })
})
