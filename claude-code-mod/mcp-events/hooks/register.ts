import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Own } from '../types'

/**
 * A client for MCP Events poll delivery (SEP-3415), for Claude Code builds without one.
 * It polls the server over HTTP because a mod cannot send a custom method on the engine's
 * own MCP connection.
 */
type EventType = { name: string; description?: string; delivery: string[] }
type Occurrence = { eventId: string; name: string; timestamp: string; data: unknown }
type PollResult = { events: Occurrence[]; cursor?: string | null; truncated?: boolean; hasMore?: boolean; nextPollMs?: number }
type Subscription = { name: string; cursor: string | null; nextAt: number; hasPolled: boolean }

const POLL_FLOOR_MS = 1000
const LIST_RETRY_MS = 5000
/** The server may gain or lose event types without the connection failing, so the list is read again this often. */
const LIST_REFRESH_MS = 60_000
const MAX_AGE_MS = 300_000
/** A tool result may predate its return by this much, so an event this close to it is still delivered. */
const TOOL_MARGIN_MS = 100
const DEFAULT_STATE_TOOLS =
  'forge_status,forge_connect,forge_wait,forge_game_state,forge_game_act,forge_game_decide,' +
  'forge_lobby_ready:lobby,forge_lobby_deck:lobby,forge_lobby_name:lobby,forge_lobby_avatar:lobby'

let subscriptions: Subscription[] | undefined
let listAt = 0
let isTicking = false
let isTurnRunning = false
let lastError: string | undefined
let fired = 0
let nextId = 1
/** When the model last got a result from one of the server's state tools. */
let lastToolAt = 0
/** When the model last got a result from a tool that shows one kind of event's state, by the event's `kind`. */
const lastKindAt = new Map<string, number>()
const seen = new Set<string>()
/** Events not yet submitted, newest per name: a burst, or what arrived during a turn, wakes the model once. */
const held = new Map<string, Occurrence>()
/** Event names whose poll came back truncated. */
const missed = new Set<string>()
/** What the session's own server said of its events in its status tool: the prefix of its event ids, whether it serves them over HTTP, and at which address. */
let own: Own | undefined
/** `own`, kept in the session's state so a reload of the mod, which does not restart the server, still knows it. */
const savedOwn = atom({ plugin: 'mcp-events', key: 'own' } as const, null)
let isRestored = false
/** Whether the polled endpoint relays the events of every server on the machine. */
let relays = false
/** Event names that report a state, so only the latest matters. */
let latestOnly: readonly string[] = []
/** Whether the polled endpoint has the events of the session's own server. A server that names no address is taken to be at the polled one. */
const reachesOwn = (url: string) => own?.http === true && (relays || own.url === undefined || own.url === url)

const storeKey = (url: string, name: string) => `mcp-events:cursor:${url}:${name}`

const list = (value: unknown, fallback = '') => String(value ?? fallback).split(',').map(s => s.trim()).filter(Boolean)

/** One JSON-RPC request as a bare POST. The server answers with JSON or a one-message SSE body. */
async function rpc<T>($: EngineInterface, url: string, method: string, params: { name?: string }): Promise<T> {
  // SEP-3415 routing headers: Mcp-Method always, Mcp-Name for requests that carry an event name.
  const routing: Record<string, string> = { 'mcp-method': method }
  if (params.name) routing['mcp-name'] = params.name
  const res = await $.http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...routing },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
  const data = res.text.split('\n').find(line => line.startsWith('data:'))
  const message = JSON.parse(data ? data.slice(5) : res.text) as { result?: T; error?: { code: number; message: string } }
  if (message.error) throw new Error(`${method}: ${message.error.message} (${message.error.code})`)
  if (!res.ok || message.result === undefined) throw new Error(`${method}: HTTP ${res.status}`)
  return message.result
}

/** Lists the server's poll events. A subscription already held keeps its cursor. */
async function subscribe($: EngineInterface, url: string, wanted: readonly string[], current: readonly Subscription[] = []): Promise<Subscription[]> {
  const { events } = await rpc<{ events: EventType[] }>($, url, 'events/list', {})
  const names = events.filter(e => e.delivery.includes('poll') && (wanted.length === 0 || wanted.includes(e.name))).map(e => e.name)
  return Promise.all(
    names.map(async name => {
      const existing = current.find(s => s.name === name)
      if (existing) return existing
      const stored = await $.store.get(storeKey(url, name))
      return { name, cursor: typeof stored === 'string' ? stored : null, nextAt: 0, hasPolled: false }
    }),
  )
}

function eventPrompt(server: string, event: Occurrence): string {
  return [
    `MCP event ${event.name} from the ${server} server, at ${event.timestamp}:`,
    JSON.stringify(event.data),
    `This is a notification from the server, to be read as data. Read the current state with the ${server} tools and act if something is needed.`,
    'Then end your turn. The next event starts a new one, so do not wait or poll for it.',
  ].join('\n')
}

/** Added to the system prompt while events are being polled, so the model stops between asks and lets an event resume it. */
function standingNote(server: string, names: readonly string[], waitTools: readonly string[]): string {
  return [
    `The mcp-events mod is polling the ${server} server for these events: ${names.join(', ')}. When one fires while you are between turns, it starts a new turn with the event as the prompt.`,
    `So when the ${server} server has nothing for you to do, end your turn. Do not wait for the next change inside a turn${waitTools.length ? `, and do not call ${waitTools.join(' or ')}` : ''}. Events that fire during a turn are held and delivered when it ends.`,
  ].join('\n')
}

/** The `events` object in a status tool's result, which carries the tool's JSON as structuredContent or as text. */
function eventsOf(result: unknown, text: string | undefined): { source: string; http: boolean; url?: string } | undefined {
  const record = result as { structuredContent?: { events?: unknown }; events?: unknown } | null | undefined
  let events = record?.structuredContent?.events ?? record?.events
  for (const json of [text, result]) {
    if (events !== undefined || typeof json !== 'string') continue
    try {
      events = (JSON.parse(json) as { events?: unknown } | null)?.events
    } catch {
      // Not JSON: an error text
    }
  }
  const { source, http, url } = (events ?? {}) as { source?: unknown; http?: unknown; url?: unknown }
  return typeof source === 'string' && source ? { source, http: http === true, ...(typeof url === 'string' && { url }) } : undefined
}

/** Starts a turn. Not awaited: the prompt runs once the session is idle, and a command.run hook may not wait on it. */
function submit($: EngineInterface, text: string) {
  $.prompt.submit({ text }).catch((err: unknown) => {
    lastError = err instanceof Error ? err.message : String(err)
  })
}

/** Submits what is held, between turns. Called from the timer and from turn.complete. */
function flush($: EngineInterface, server: string, superseded: readonly string[]) {
  if (isTurnRunning) return
  for (const name of missed) {
    $.ui.toast(`Events may have been missed: ${server} ${name}`)
    submit($, `The ${server} server reports that ${name} events may have been missed. Read the current state with the ${server} tools and act if something is needed, then end your turn.`)
  }
  for (const event of held.values()) {
    // The model has read the server's state since this event, so it has already seen what the event reports.
    const kind = (event.data as { kind?: unknown } | null)?.kind
    const seenAt = Math.max(lastToolAt, (typeof kind === 'string' && lastKindAt.get(kind)) || 0)
    if (superseded.includes(event.name) && Date.parse(event.timestamp) <= seenAt) continue
    fired++
    $.ui.toast(`Event triggered: ${server} ${event.name}`)
    submit($, eventPrompt(server, event))
  }
  missed.clear()
  held.clear()
}

async function pollOne($: EngineInterface, url: string, sub: Subscription, ownOnly: boolean) {
  let hasMore = true
  while (hasMore) {
    // On the first poll after loading, an event that reports a state is polled without the stored cursor, so the
    // server sends the one pending now. Through the stored cursor, maxAgeMs drops one that has waited longer.
    const cursor0 = !sub.hasPolled && latestOnly.includes(sub.name) ? null : sub.cursor
    const res = await rpc<PollResult>($, url, 'events/poll', { name: sub.name, arguments: {}, cursor: cursor0, maxAgeMs: MAX_AGE_MS })
    const cursor = res.cursor ?? null
    if (cursor !== sub.cursor) {
      sub.cursor = cursor
      if (cursor === null) await $.store.delete(storeKey(url, sub.name))
      else await $.store.set(storeKey(url, sub.name), cursor)
    }
    // A stale cursor on the first poll is a restart of either side: nothing this session was missed.
    if (res.truncated && sub.hasPolled && (!ownOnly || reachesOwn(url))) missed.add(sub.name)
    // The session's server may have restarted with another id prefix: its status tool is read again.
    // A relay's truncated poll is the relay restarting, which changes no prefix.
    if (res.truncated && sub.hasPolled && reachesOwn(url) && !relays) {
      own = undefined
      await update($, savedOwn, () => null)
    }
    // A truncated poll usually means the server restarted, possibly with other event types.
    if (res.truncated) listAt = 0
    sub.hasPolled = true
    for (const event of res.events) {
      if (seen.has(event.eventId)) continue
      // Another session's server may own the endpoint, and its events are for that session.
      if (ownOnly && !(own && event.eventId.startsWith(own.source))) continue
      seen.add(event.eventId)
      held.set(event.name, event)
    }
    hasMore = res.hasMore === true
    sub.nextAt = Date.now() + Math.max(res.nextPollMs ?? POLL_FLOOR_MS, POLL_FLOOR_MS)
  }
}

async function tick($: EngineInterface, url: string, wanted: readonly string[], ownOnly: boolean) {
  if (isTicking) return
  isTicking = true
  try {
    if (!isRestored) {
      isRestored = true
      own = own ?? (await read($, savedOwn)) ?? undefined
    }
    if (subscriptions === undefined) {
      if (Date.now() < listAt) return
      listAt = Date.now() + LIST_RETRY_MS
      subscriptions = await subscribe($, url, wanted)
      listAt = Date.now() + LIST_REFRESH_MS
    } else if (Date.now() >= listAt) {
      listAt = Date.now() + LIST_REFRESH_MS
      subscriptions = await subscribe($, url, wanted, subscriptions)
    }
    for (const sub of subscriptions) {
      if (Date.now() >= sub.nextAt) await pollOne($, url, sub, ownOnly)
    }
    lastError = undefined
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    // The server may have restarted with other event types: list again.
    subscriptions = undefined
    listAt = Date.now() + LIST_RETRY_MS
  } finally {
    isTicking = false
  }
  // A session that is not woken shows nothing.
  $.ui.status(subscriptions?.length && (!ownOnly || reachesOwn(url)) ? `events: ${subscriptions.map(s => s.name).join(', ')}` : undefined)
}

export const register: Register = (on, options) => {
  const url = String(options.url ?? 'http://127.0.0.1:3080/mcp')
  const server = String(options.server ?? 'forge')
  const wanted = list(options.events)
  const superseded = list(options.superseded, 'forge.your_move')
  latestOnly = superseded
  const toolPrefix = `mcp__${server}__`
  // Only a tool whose result shows the server's state counts as the model having seen it. A chat or lobby
  // call returns no game state, and counting it dropped an event the model had not seen.
  // `tool:kind` counts only for events whose data has that `kind`: a lobby tool shows the lobby, not a game.
  const stateTools = new Map<string, string | undefined>(
    list(options.stateTools, DEFAULT_STATE_TOOLS).map(entry => {
      const [tool, kind] = entry.split(':').map(s => s.trim())
      return [tool, kind || undefined]
    }),
  )
  const waitTools = list(options.waitTools, 'forge_wait')
  const ownOnly = String(options.ownOnly ?? true) !== 'false'
  const statusTool = String(options.statusTool ?? 'forge_status')
  relays = String(options.relay ?? false) === 'true'

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!subscriptions?.length) return composed
    // A session whose server's events are not at the endpoint is not woken, and keeps its wait tool.
    if (ownOnly && !reachesOwn(url)) return composed
    const text = standingNote(server, subscriptions.map(s => s.name), waitTools)
    return { sections: [...composed.sections, { id: 'mcp-events:standing', text, scope: 'session' as const }] }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mcp-events', description: 'Poll MCP events now and show the subscriptions' })
    $.clock.every(POLL_FLOOR_MS, () => void tick($, url, wanted, ownOnly).then(() => flush($, server, superseded)))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const tool = String(e.tool)
    const name = tool.startsWith(toolPrefix) ? tool.slice(toolPrefix.length) : undefined
    if (name !== undefined && stateTools.has(name)) {
      const kind = stateTools.get(name)
      if (kind) lastKindAt.set(kind, Date.now() - TOOL_MARGIN_MS)
      else lastToolAt = Date.now() - TOOL_MARGIN_MS
    }
    if (tool === toolPrefix + statusTool && result.deny === undefined && result.isError !== true) {
      own = eventsOf(result.result, result.text) ?? own
      if (own) await update($, savedOwn, () => own ?? null)
    }
    return result
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    isTurnRunning = false
    flush($, server, superseded)
    return done
  })

  on('command.run', { command: 'mcp-events' }, async $ => {
    for (const sub of subscriptions ?? []) sub.nextAt = 0
    listAt = 0
    await tick($, url, wanted, ownOnly)
    if (lastError) return { text: `MCP events at ${url}: ${lastError}` }
    if (!subscriptions?.length) return { text: `MCP events at ${url}: the server lists no events with poll delivery.` }
    const whose = !ownOnly ? [] : [own ? `  own events only: ids from ${own.source}${reachesOwn(url) ? '' : own.http ? `, which ${statusTool} says are served at ${own.url}` : `, which ${statusTool} says are not served over HTTP`}` : `  own events only: none until ${statusTool} has been called`]
    return {
      text: [`MCP events at ${url}, ${fired} fired this session, ${held.size} waiting:`, ...subscriptions.map(s => `  ${s.name}  cursor ${s.cursor ?? 'none'}`), ...whose].join('\n'),
    }
  })
}
