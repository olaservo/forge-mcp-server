import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { MailboxState, Own } from '../types'
import { concat, hmacSha256, open as openSealed, publicKey } from './crypto'
import { rpc, type Occurrence } from './rpc'

/**
 * Webhook delivery through a mailbox (github.com/olaservo/mcp-mailbox): the session's own server is subscribed
 * with a mailbox hook as the callback, and the deliveries are fetched from the mailbox, verified and ordered here.
 * The mailbox never has the signing secret. With `encrypt` the server seals each event's data to the session's key,
 * so the mailbox holds ciphertext.
 */

/** A delivery as the mailbox's `GET /deliveries` returns it. `body` is base64. */
export type Fetched = { seq: number; hook: string; receivedAt: number; headers: Record<string, string>; body: string }

export type MailboxOptions = {
  url: string
  key: string
  /** The server's bearer token, for a server whose registry file the session cannot read. */
  serverToken?: string
  /** Event names to subscribe to. Empty: every event the server lists with webhook delivery. */
  wanted: readonly string[]
  /** Ask the server to seal event data to the session's key. The server has to list the scheme in `events/list`. */
  encrypt: boolean
  /** Event names that report a state, whose pending one is asked for when the module loads. */
  latestOnly: readonly string[]
  own: () => Own | undefined
  accept: (event: Occurrence) => void
  missed: (name: string) => void
}

/** Standard Webhooks allows a timestamp this far from the time of receipt. */
const TOLERANCE_MS = 5 * 60 * 1000
/** The mailbox drops a delivery after 7 days. One older than this by the session's clock is refused. */
const MAX_HELD_MS = 8 * 24 * 60 * 60 * 1000
const TTL_MS = 60 * 60 * 1000
/** A refresh also restores a subscription the server lost. */
const REFRESH_MS = 60 * 1000
const RETRY_MS = 15 * 1000
/** The server POSTs concurrently, so events sent together are fetched together and then ordered. */
const SETTLE_MS = 500
const WAIT_SECONDS = 25
/** A mailbox with hook limits removes a hook that is not fetched for this long, for a session that ended without removing its own. */
const HOOK_IDLE_SECONDS = 24 * 60 * 60
/** The one scheme the server's `delivery.encryption` takes. SEP-3415 does not define it: forge-mcp-server issue 9. */
const SCHEME = 'hpke-x25519-sha256-aes128gcm'

const saved = atom({ plugin: 'mcp-events', key: 'mailbox' } as const, null)
const encoder = new TextEncoder()

const fromBase64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0))

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const toBase64Url = (bytes: Uint8Array) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64Url = (text: string) => fromBase64(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))

/** Standard Webhooks `v1`: HMAC-SHA256 over `<id>.<timestamp>.<body>`, with the body as received. */
export async function signatureOk(secret: string, delivery: Fetched): Promise<boolean> {
  let expected: Uint8Array
  try {
    const signed = concat(encoder.encode(`${delivery.headers['webhook-id']}.${delivery.headers['webhook-timestamp']}.`), fromBase64(delivery.body))
    expected = await hmacSha256(fromBase64(secret.slice(6)), signed)
  } catch {
    return false
  }
  let ok = false
  for (const part of (delivery.headers['webhook-signature'] ?? '').split(' ')) {
    if (!part.startsWith('v1,')) continue
    let given: Uint8Array
    try {
      given = fromBase64(part.slice(3))
    } catch {
      continue
    }
    if (given.length !== expected.length) continue
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= (given[i] ?? 0) ^ (expected[i] ?? 0)
    ok = ok || diff === 0
  }
  return ok
}

/**
 * Why a delivery is refused, or undefined when it verifies. The signed timestamp is compared with the mailbox's
 * `receivedAt`, since a held delivery is old by the session's clock, and `receivedAt` is held to the mailbox's retention.
 */
export async function refusal(secret: string, delivery: Fetched, now: number): Promise<string | undefined> {
  const { headers, receivedAt } = delivery
  if (!headers['webhook-id'] || !headers['x-mcp-subscription-id']) return 'missing headers'
  const timestamp = Number(headers['webhook-timestamp'])
  if (!Number.isFinite(timestamp)) return 'missing timestamp'
  if (!(await signatureOk(secret, delivery))) return 'bad signature'
  if (Math.abs(receivedAt - timestamp * 1000) > TOLERANCE_MS) return 'timestamp is not close to the time of receipt'
  if (receivedAt > now + TOLERANCE_MS || receivedAt < now - MAX_HELD_MS) return "time of receipt is outside the mailbox's retention"
  return undefined
}

/** Event ids that end in a number after the same prefix are ordered by it. Others by timestamp, then by arrival. */
function inOrder(a: { event: Occurrence; seq: number }, b: { event: Occurrence; seq: number }): number {
  const x = /^(.*\D)(\d+)$/.exec(a.event.eventId)
  const y = /^(.*\D)(\d+)$/.exec(b.event.eventId)
  if (x && y && x[1] === y[1]) return Number(x[2]) - Number(y[2]) || a.seq - b.seq
  return Date.parse(a.event.timestamp) - Date.parse(b.event.timestamp) || a.seq - b.seq
}

type SubscribeResult = { id: string; cursor?: string | null; truncated?: boolean; delivery?: { encryption?: { scheme?: string } } }
type Listed = { name: string; delivery: string[]; encryption?: string[] }

let opts: MailboxOptions
let base = ''
let state: MailboxState | undefined
/** This load of the module. A fetch still waiting from before a reload sees another and leaves its deliveries. */
let generation = 0
let names: string[] = []
let token: string | undefined
let dueAt = 0
let isSubscribed = false
let hasAsked = false
let isFetching = false
let fetchAt = 0
let failures = 0
let skipped = 0
/** Why the last skipped delivery was skipped. */
let lastSkip: string | undefined
/** `<subscription id> <webhook-id>` of deliveries handed on. */
const handled = new Set<string>()

async function save($: EngineInterface): Promise<void> {
  await update($, saved, () => (state ? { ...state } : null))
}

async function mailbox($: EngineInterface, method: string, path: string, what: string, body?: unknown): Promise<string> {
  const res = await $.http.fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${opts.key}` }, ...(body !== undefined && { body: JSON.stringify(body) }) })
  if (!res.ok) throw new Error(`mailbox ${what}: HTTP ${res.status}`)
  return res.text
}

/** The token in the server's registry file. */
async function registryToken($: EngineInterface, own: Own): Promise<string | undefined> {
  if (!own.registry) return undefined
  try {
    const entry = JSON.parse(await $.fs.read(own.registry)) as { source?: unknown; token?: unknown }
    return entry.source === own.source && typeof entry.token === 'string' ? entry.token : undefined
  } catch {
    return undefined
  }
}

async function ensureHook($: EngineInterface, current: MailboxState, label: string): Promise<{ token: string; url: string }> {
  if (current.hook) {
    const held = current.hook
    const { hooks } = JSON.parse(await mailbox($, 'GET', '/hooks', 'hooks')) as { hooks: { token: string }[] }
    if (hooks.some(h => h.token === held.token)) return held
  }
  const made = JSON.parse(await mailbox($, 'POST', '/hooks', 'new hook', { label, idleSeconds: HOOK_IDLE_SECONDS })) as { token: string; url: string }
  current.hook = { token: made.token, url: made.url }
  current.after = 0
  current.subscriptions = {}
  return current.hook
}

/** Unsubscribes what the session holds on the server. Stops at the first that fails, and the rest stay held. */
async function drop($: EngineInterface, url: string, hookUrl: string, current: MailboxState): Promise<void> {
  for (const name of Object.keys(current.subscriptions)) {
    await rpc($, url, 'events/unsubscribe', { name, arguments: {}, delivery: { mode: 'webhook', url: hookUrl } }, token)
    delete current.subscriptions[name]
  }
}

/** Subscribes or refreshes when due. Does nothing until the session's server has said where it serves events. */
export async function step($: EngineInterface): Promise<void> {
  const own = opts.own()
  if (!own?.http || !own.url) return
  if (!state) {
    const stored = await read($, saved)
    state = stored ? { ...stored } : { generation: 0, secret: `whsec_${toBase64(crypto.getRandomValues(new Uint8Array(32)))}`, source: own.source, hook: null, after: 0, subscriptions: {}, cursors: {} }
    generation = state.generation = state.generation + 1
    await save($)
  }
  if (state.source !== own.source) {
    // The server restarted: its subscriptions and cursors went with the old process.
    state = { ...state, source: own.source, subscriptions: {}, cursors: {}, encrypted: false }
    isSubscribed = false
    hasAsked = false
    dueAt = 0
  }
  if (Date.now() < dueAt) return
  dueAt = Date.now() + RETRY_MS
  const current = state
  try {
    token = opts.serverToken || (await registryToken($, own))
    if (!token) throw new Error(`no token for ${own.url}: its registry file has none and serverToken is not set`)
    const listed = opts.wanted.length && !opts.encrypt ? [] : (await rpc<{ events: Listed[] }>($, own.url, 'events/list', {}, token)).events
    names = opts.wanted.length ? [...opts.wanted] : listed.filter(e => e.delivery.includes('webhook')).map(e => e.name)
    const hook = await ensureHook($, current, `mcp-events ${own.source}`)
    if (opts.encrypt) {
      const without = names.filter(name => !listed.find(e => e.name === name)?.encryption?.includes(SCHEME))
      if (without.length) {
        // A server without the field would take the subscription and deliver in the clear.
        await drop($, own.url, hook.url, current).catch(() => undefined)
        throw new Error(`events/list does not list ${SCHEME} for ${without.join(', ')}`)
      }
      current.key ??= toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    } else if (current.encrypted) {
      // The server refuses a refresh that would turn encryption off.
      await drop($, own.url, hook.url, current)
    }
    current.encrypted = opts.encrypt
    const encryption = opts.encrypt && current.key !== undefined ? { scheme: SCHEME, publicKey: toBase64Url(publicKey(fromBase64Url(current.key))) } : undefined
    for (const name of names) {
      const delivery = { mode: 'webhook', url: hook.url, secret: current.secret, ...(encryption && { encryption }) }
      const result = await rpc<SubscribeResult>($, own.url, 'events/subscribe', { name, arguments: {}, delivery, ttlMs: TTL_MS, cursor: current.cursors[name] ?? null }, token)
      if (encryption && result.delivery?.encryption?.scheme !== SCHEME) {
        // The server took the subscription as one in the clear.
        await rpc($, own.url, 'events/unsubscribe', { name, arguments: {}, delivery: { mode: 'webhook', url: hook.url } }, token).catch(() => undefined)
        delete current.subscriptions[name]
        throw new Error(`events/subscribe for ${name} did not answer with ${SCHEME}`)
      }
      current.subscriptions[name] = result.id
      if (typeof result.cursor === 'string') current.cursors[name] = result.cursor
      if (result.truncated) opts.missed(name)
    }
    isSubscribed = true
  } catch (err) {
    isSubscribed = false
    throw err
  } finally {
    await save($)
  }
  dueAt = Date.now() + REFRESH_MS
  if (hasAsked) return
  hasAsked = true
  // A subscription that exists already is not sent the pending ask again, so after a reload it is asked for.
  for (const name of names.filter(n => opts.latestOnly.includes(n))) {
    const { events } = await rpc<{ events: Occurrence[] }>($, own.url, 'events/poll', { name, arguments: {}, cursor: null }, token)
    for (const event of events) if (event.name === name) opts.accept(event)
  }
}

/** The event in a delivery, or the reason it is not handed on. */
async function open(current: MailboxState, delivery: Fetched, now: number): Promise<Occurrence | string> {
  const why = await refusal(current.secret, delivery, now)
  if (why) return why
  const name = Object.entries(current.subscriptions).find(([, id]) => id === delivery.headers['x-mcp-subscription-id'])?.[0]
  if (name === undefined) return 'unknown subscription'
  let body: (Partial<Occurrence> & { type?: unknown; encrypted?: { enc?: unknown; ct?: unknown } }) | null
  try {
    body = JSON.parse(new TextDecoder().decode(fromBase64(delivery.body))) as typeof body
  } catch {
    body = null
  }
  if (body === null || typeof body !== 'object') return 'body is not a JSON object'
  if (typeof body.type === 'string') return `control envelope ${body.type}`
  // The subscription id header is not signed and the event name is.
  if (body.name !== name) return `event ${String(body.name)} on a subscription for ${name}`
  if (typeof body.eventId !== 'string' || typeof body.timestamp !== 'string') return 'not an event'
  const sealed = body.encrypted
  if (!opts.encrypt) return sealed === undefined ? { eventId: body.eventId, name, timestamp: body.timestamp, data: body.data } : 'encrypted, and encryption is off'
  if (typeof sealed?.enc !== 'string' || typeof sealed.ct !== 'string') return 'not encrypted'
  try {
    // The server binds the seal to the subscription and to the fields that stay in the clear.
    const info = encoder.encode(`mcp-events v1 ${delivery.headers['x-mcp-subscription-id']}`)
    const aad = encoder.encode(`${body.eventId}\n${name}\n${body.timestamp}`)
    const plain = await openSealed(fromBase64Url(current.key ?? ''), fromBase64Url(sealed.enc), info, aad, fromBase64Url(sealed.ct))
    return { eventId: body.eventId, name, timestamp: body.timestamp, data: JSON.parse(new TextDecoder().decode(plain)) as unknown }
  } catch {
    return 'does not decrypt'
  }
}

/** One fetch from the mailbox, always for this session's hook. Hands on what verifies, in order, then acknowledges. */
export async function fetchOnce($: EngineInterface, waitSeconds: number, settleMs: number): Promise<void> {
  const current = state
  const hook = current?.hook
  if (!current || !hook) return
  const mine = generation
  const get = async (after: number, wait: number) =>
    (JSON.parse(await mailbox($, 'GET', `/deliveries?after=${after}&limit=500&wait=${wait}&hook=${hook.token}`, 'fetch')) as { deliveries: Fetched[] }).deliveries
  const batch = await get(current.after, waitSeconds)
  let last = batch.at(-1)
  if (!last) return
  for (;;) {
    if (settleMs > 0) await $.clock.sleep(settleMs)
    const more = await get(last.seq, 0)
    if (more.length === 0) break
    batch.push(...more)
    last = more.at(-1) ?? last
  }
  // The module was reloaded while this fetch waited. The new one fetches these again.
  if ((await read($, saved))?.generation !== mine || state?.hook?.token !== hook.token) return

  const now = Date.now()
  const accepted: { event: Occurrence; seq: number }[] = []
  for (const delivery of batch) {
    const key = `${delivery.headers['x-mcp-subscription-id']} ${delivery.headers['webhook-id']}`
    const opened = await open(current, delivery, now)
    if (typeof opened === 'string' || handled.has(key)) {
      skipped++
      lastSkip = typeof opened === 'string' ? opened : 'repeat'
      continue
    }
    handled.add(key)
    accepted.push({ event: opened, seq: delivery.seq })
  }
  for (const { event } of accepted.sort(inOrder)) opts.accept(event)
  current.after = last.seq
  // Saved before the acknowledgement, so a stop between the two repeats nothing.
  await save($)
  await mailbox($, 'POST', '/ack', 'ack', { upTo: last.seq, hook: hook.token })
}


/** Sets the mailbox to use. Called once per load of the module. */
export function configure(options: MailboxOptions): void {
  opts = options
  base = options.url.replace(/\/$/, '')
}

/** Keeps one waiting fetch open. Not awaited by the caller. */
export function pump($: EngineInterface, onError: (message: string) => void): void {
  if (isFetching || !state?.hook || Date.now() < fetchAt) return
  isFetching = true
  void fetchOnce($, WAIT_SECONDS, SETTLE_MS)
    .then(
      () => void (failures = 0),
      (err: unknown) => {
        onError(err instanceof Error ? err.message : String(err))
        fetchAt = Date.now() + Math.min(30_000, 1000 * 2 ** failures++)
      },
    )
    .finally(() => void (isFetching = false))
}

/** The events the session is subscribed to now. Empty while the last subscribe failed. */
export const following = (): readonly string[] => (isSubscribed ? names : [])

export const describe = (): string[] => [
  ...names.map(name => `  ${name}  subscription ${state?.subscriptions[name] ?? 'none'}`),
  `  mailbox position ${state?.after ?? 0}, ${skipped} deliveries skipped${lastSkip ? ` (the last: ${lastSkip})` : ''}`,
  ...(opts.encrypt ? [`  event data encrypted to this session's key (${SCHEME})`] : []),
]

/** How the status line names the delivery. */
export const mode = (): string => (opts.encrypt ? 'mailbox, encrypted' : 'mailbox')

/** Unsubscribes and removes the hook with what it still holds. Each step is tried once. */
export async function end($: EngineInterface): Promise<void> {
  const current = state
  const hook = current?.hook
  const own = opts.own()
  if (!current || !hook) return
  current.hook = null
  current.subscriptions = {}
  isSubscribed = false
  await save($).catch(() => undefined)
  if (own?.url && token) {
    for (const name of names) await rpc($, own.url, 'events/unsubscribe', { name, arguments: {}, delivery: { mode: 'webhook', url: hook.url } }, token).catch(() => undefined)
  }
  // A mailbox from before hooks had limits keeps a removed hook's deliveries until they are acknowledged.
  await mailbox($, 'POST', '/ack', 'ack', { upTo: Number.MAX_SAFE_INTEGER, hook: hook.token }).catch(() => undefined)
  await mailbox($, 'DELETE', `/hooks/${hook.token}`, 'remove hook').catch(() => undefined)
}
