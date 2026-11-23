import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { hmacSha256 } from '../hooks/mailbox'

const MAILBOX = 'https://mailbox.test'
const SERVER = 'http://127.0.0.1:4000/mcp'
const REGISTRY = '/home/.forge-seat/servers/1.json'
const options = { mailboxUrl: MAILBOX, mailboxKey: 'k'.repeat(43) }
const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
const utf8 = (text: string) => new TextEncoder().encode(text)
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

type Delivery = { seq: number; hook: string; receivedAt: number; headers: Record<string, string>; body: string }
type Subscribe = { name: string; delivery: { url: string; secret: string }; cursor: string | null }

/**
 * Stands in for the engine, for a mailbox and for the session's own server, which is at SERVER with its token
 * in REGISTRY. `pending` is what the server answers to a poll with no cursor.
 */
function session(on: On, pending: unknown[] = []) {
  const prompts: string[] = []
  const requests: { method: string; url: string; authorization?: string; body?: string }[] = []
  const subscribes: Subscribe[] = []
  const hooks: string[] = []
  const deliveries: Delivery[] = []
  let seq = 0
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({ result: { structuredContent: { events: { source: 'c', http: true, url: SERVER, registry: REGISTRY } } } }))
  on('fs.read', (_, e) => {
    // The engine hands on an absolute path in the platform's spelling.
    if (!e.path.replace(/\\/g, '/').endsWith(REGISTRY)) throw new Error(`no file ${e.path}`)
    return { value: JSON.stringify({ url: SERVER, source: 'c', pid: 1, token: 'registry-token' }) }
  })
  on('http.fetch', (_, e) => {
    const method = e.init?.method ?? 'GET'
    const body = typeof e.init?.body === 'string' ? e.init.body : undefined
    requests.push({ method, url: e.url, authorization: e.init?.headers?.authorization, body })
    const answer = (value: unknown, status = 200) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(value) } })
    if (e.url === SERVER) {
      const request = JSON.parse(body ?? '{}') as { id: number; method: string; params: Subscribe }
      if (e.init?.headers?.authorization !== 'Bearer registry-token') return { value: { status: 401, ok: false, headers: {}, text: 'missing or wrong bearer token' } }
      let result: unknown = {}
      if (request.method === 'events/subscribe') {
        subscribes.push(request.params)
        result = { id: `sub_${request.params.name}`, cursor: `c:${subscribes.length}`, truncated: false, refreshBefore: null }
      } else if (request.method === 'events/poll') {
        result = { events: pending, cursor: 'c:0', truncated: false }
      } else if (request.method === 'events/list') {
        result = { events: [{ name: 'forge.your_move', delivery: ['poll', 'push', 'webhook'] }, { name: 'poll.only', delivery: ['poll'] }] }
      }
      return answer({ jsonrpc: '2.0', id: request.id, result })
    }
    const url = new URL(e.url)
    if (e.init?.headers?.authorization !== `Bearer ${options.mailboxKey}`) return answer({ error: 'unauthorized' }, 401)
    if (method === 'POST' && url.pathname === '/hooks') {
      hooks.push(`hook${hooks.length + 1}`)
      return answer({ token: hooks.at(-1), url: `${MAILBOX}/hooks/${hooks.at(-1)}` }, 201)
    }
    if (method === 'GET' && url.pathname === '/hooks') return answer({ hooks: hooks.map(token => ({ token })) })
    if (method === 'GET' && url.pathname === '/deliveries') {
      const after = Number(url.searchParams.get('after'))
      return answer({ deliveries: deliveries.filter(d => d.seq > after && d.hook === url.searchParams.get('hook')) })
    }
    if (method === 'DELETE') {
      hooks.splice(hooks.indexOf(url.pathname.split('/')[2] ?? ''), 1)
      return answer({})
    }
    return answer({ deleted: 0 })
  })

  /** Puts a delivery in the mailbox as the server would send it, signed with the secret the mod subscribed with. */
  async function deliver(eventId: string, change: { secret?: string; name?: string; subscription?: string; body?: Record<string, unknown>; agoMs?: number } = {}) {
    const secret = change.secret ?? subscribes.at(-1)!.delivery.secret
    const at = Date.now() - (change.agoMs ?? 0)
    const body = JSON.stringify(change.body ?? { eventId, name: change.name ?? 'forge.your_move', timestamp: new Date(Date.now() + 60_000).toISOString(), data: { kind: 'priority', id: eventId }, cursor: 'c:1' })
    const stamp = String(Math.floor(at / 1000))
    const key = Uint8Array.from(atob(secret.slice(6)), c => c.charCodeAt(0))
    const signature = `v1,${base64(await hmacSha256(key, utf8(`${eventId}.${stamp}.${body}`)))}`
    deliveries.push({
      seq: ++seq,
      hook: hooks.at(-1) ?? 'none',
      receivedAt: at,
      headers: { 'webhook-id': eventId, 'webhook-timestamp': stamp, 'webhook-signature': signature, 'x-mcp-subscription-id': change.subscription ?? 'sub_forge.your_move' },
      body: base64(utf8(body)),
    })
  }
  return { prompts, requests, subscribes, hooks, deliveries, deliver }
}

const callStatus = { tool: 'mcp__forge__forge_status' } as never
const run = { command: 'mcp-events' } as never
const endTurn = { turnId: 't1', reason: 'answer', answer: 'ok' } as never

test('HMAC-SHA256 from digest alone gives the RFC 4231 answers', async () => {
  expect(hex(await hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?')))).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
  // Test case 6: a key longer than the block
  expect(hex(await hmacSha256(new Uint8Array(131).fill(0xaa), utf8('Test Using Larger Than Block-Size Key - Hash Key First')))).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54')
})

test('nothing is asked of the mailbox or the server until the status tool has named the server', { options }, async ($, on) => {
  const { requests } = session(on)
  expect((await $.command.run(run)).text).toContain('nothing until forge_status')
  expect(requests).toEqual([])
})

test('the session subscribes its own server with a mailbox hook and the registry token, and a delivery starts a turn once', { options }, async ($, on) => {
  const { prompts, requests, subscribes, deliver } = session(on)
  await $.tool.call(callStatus)
  const first = await $.command.run(run)
  expect(first.text).toContain(`through the mailbox at ${MAILBOX} for ${SERVER}`)
  expect(first.text).toContain('forge.your_move  subscription sub_forge.your_move')
  expect(first.text).not.toContain('poll.only')
  expect(subscribes).toHaveLength(1)
  expect(subscribes[0]!.delivery.url).toBe(`${MAILBOX}/hooks/hook1`)
  expect(subscribes[0]!.delivery.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
  expect(requests.filter(r => r.url === SERVER).every(r => r.authorization === 'Bearer registry-token')).toBe(true)

  await deliver('c-1')
  expect((await $.command.run(run)).text).toContain('1 waiting')
  await $.turn.complete(endTurn)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('MCP event forge.your_move from the forge server')

  // Every fetch and acknowledgement names the session's hook.
  const fetches = requests.filter(r => r.url.includes('/deliveries'))
  expect(fetches.length).toBeGreaterThan(0)
  expect(fetches.every(r => r.url.includes('hook=hook1'))).toBe(true)
  const acks = requests.filter(r => r.url.endsWith('/ack'))
  expect(acks.map(r => JSON.parse(r.body!))).toEqual([{ upTo: 1, hook: 'hook1' }])

  // The mailbox hands the same delivery out again.
  await deliver('c-1')
  await $.command.run(run)
  await $.turn.complete(endTurn)
  expect(prompts).toHaveLength(1)
})

test('a delivery that does not verify starts no turn', { options }, async ($, on) => {
  const { prompts, deliveries, deliver } = session(on)
  await $.tool.call(callStatus)
  await $.command.run(run)
  await deliver('c-1', { secret: `whsec_${base64(new Uint8Array(32).fill(7))}` })
  await deliver('c-2')
  deliveries.at(-1)!.body = base64(utf8(atob(deliveries.at(-1)!.body).replace('priority', 'altered!')))
  await deliver('c-3', { agoMs: 9 * 24 * 60 * 60 * 1000 })
  await deliver('c-4', { subscription: 'sub_other' })
  await deliver('c-5', { name: 'forge.chat' })
  await deliver('c-6', { body: { type: 'gap', cursor: 'c:9' } })
  const shown = await $.command.run(run)
  expect(shown.text).toContain('0 waiting')
  expect(shown.text).toContain('mailbox position 6, 6 deliveries skipped')
  await $.turn.complete(endTurn)
  expect(prompts).toEqual([])
})

test('deliveries that arrive out of order wake the session for the newest event', { options }, async ($, on) => {
  const { prompts, deliver } = session(on)
  await $.tool.call(callStatus)
  await $.command.run(run)
  await deliver('c-12')
  await deliver('c-9')
  await $.command.run(run)
  await $.turn.complete(endTurn)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('"id":"c-12"')
})

test('an ask pending when the module loads starts one turn, whichever way it arrives', { options }, async ($, on) => {
  const ask = { eventId: 'c-3', name: 'forge.your_move', timestamp: new Date(Date.now() + 60_000).toISOString(), data: { kind: 'priority', id: 'c-3' } }
  const { prompts, requests, deliver } = session(on, [ask])
  await $.tool.call(callStatus)
  expect((await $.command.run(run)).text).toContain('1 waiting')
  expect(requests.filter(r => r.body?.includes('"events/poll"')).map(r => (JSON.parse(r.body!) as { params: { cursor: unknown } }).params.cursor)).toEqual([null])
  await deliver('c-3')
  await $.command.run(run)
  await $.turn.complete(endTurn)
  expect(prompts).toHaveLength(1)
  // Asked for once per load, not on every refresh.
  await $.command.run(run)
  expect(requests.filter(r => r.body?.includes('"events/poll"'))).toHaveLength(1)
})

test('the system prompt says to end the turn once the server is subscribed', { options }, async ($, on) => {
  session(on)
  const composing = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never
  expect((await $.prompt.compose(composing)).sections).toHaveLength(1)
  await $.tool.call(callStatus)
  await $.command.run(run)
  const { sections } = await $.prompt.compose(composing)
  expect(sections.at(-1)!.text).toContain('do not call forge_wait')
})

test('the end of the session unsubscribes and removes the hook with its deliveries', { options }, async ($, on) => {
  on('session.end', () => ({ sessionId: 's' }) as never)
  const { requests, hooks } = session(on)
  await $.tool.call(callStatus)
  await $.command.run(run)
  expect(hooks).toEqual(['hook1'])
  await $.session.end({ reason: 'exit' } as never)
  expect(hooks).toEqual([])
  expect(requests.some(r => r.body?.includes('"events/unsubscribe"'))).toBe(true)
  expect(JSON.parse(requests.filter(r => r.url.endsWith('/ack')).at(-1)!.body!)).toEqual({ upTo: Number.MAX_SAFE_INTEGER, hook: 'hook1' })
  expect(requests.at(-1)).toMatchObject({ method: 'DELETE', url: `${MAILBOX}/hooks/hook1` })
})
