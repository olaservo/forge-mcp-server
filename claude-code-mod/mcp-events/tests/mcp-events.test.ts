import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Poll = { events: unknown[]; cursor: string; truncated?: boolean }

/**
 * Stands in for the engine and for a server that lists one event and answers polls from `polls`.
 * `status` is what the session's own server answers to forge_status.
 */
function session(on: On, polls: Poll[], status: unknown = { structuredContent: { revision: 3, events: { source: 'c', http: true } } }) {
  const sent: { method: string; params: { cursor?: string | null } }[] = []
  const prompts: string[] = []
  const stored = new Map<string, unknown>()
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: 'ok' }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({ result: status }))
  on('http.fetch', (_, e) => {
    const request = JSON.parse(String(e.init?.body)) as { id: number; method: string; params: { cursor?: string | null } }
    sent.push(request)
    const result =
      request.method === 'events/list'
        ? { events: [{ name: 'forge.your_move', delivery: ['poll'] }, { name: 'push.only', delivery: ['push'] }] }
        : { nextPollMs: 1000, hasMore: false, truncated: false, ...(polls.shift() ?? { events: [], cursor: 'c:9' }) }
    const text = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  return { sent, prompts, stored }
}

const callStatus = { tool: 'mcp__forge__forge_status' } as never
const composing = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }

// Dated after the test's forge_status call, which would otherwise supersede it.
const move = (eventId: string) => ({ eventId, name: 'forge.your_move', timestamp: new Date(Date.now() + 60_000).toISOString(), data: { kind: 'priority', prompt: 'Priority: Agent' } })

test('an event starts a turn once, and the cursor is passed back and stored', async ($, on) => {
  const { sent, prompts, stored } = session(on, [
    { events: [], cursor: 'c:0' },
    { events: [move('c-1')], cursor: 'c:1' },
    { events: [move('c-1')], cursor: 'c:1' },
  ])
  await $.tool.call(callStatus)
  const first = await $.command.run({ command: 'mcp-events' })
  expect(first.text).toContain('forge.your_move  cursor c:0')
  expect(first.text).not.toContain('push.only')
  expect(prompts).toEqual([])

  // A command.run hook may not submit: the event is held until the timer or the end of a turn.
  const second = await $.command.run({ command: 'mcp-events' })
  expect(second.text).toContain('1 waiting')
  await $.command.run({ command: 'mcp-events' })
  expect(prompts).toEqual([])
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok' } as never)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('MCP event forge.your_move from the forge server')
  expect(prompts[0]).toContain('"prompt":"Priority: Agent"')

  const polls = sent.filter(r => r.method === 'events/poll')
  expect(polls.map(r => r.params.cursor)).toEqual([null, 'c:0', 'c:1'])
  expect([...stored.values()]).toEqual(['c:1'])
})

test('the system prompt says to end the turn once events are being polled', async ($, on) => {
  session(on, [{ events: [], cursor: 'c:0' }])
  expect((await $.prompt.compose(composing)).sections.map(s => s.id)).toEqual(['intro'])
  await $.command.run({ command: 'mcp-events' })
  // Not before the session's own server has said that the polled endpoint can be its own.
  expect((await $.prompt.compose(composing)).sections.map(s => s.id)).toEqual(['intro'])
  await $.tool.call(callStatus)
  const sections = (await $.prompt.compose(composing)).sections
  expect(sections.map(s => s.id)).toEqual(['intro', 'mcp-events:standing'])
  expect(sections[1]!.text).toContain('forge.your_move')
  expect(sections[1]!.text).toContain('do not call forge_wait')
  expect(sections[1]!.scope).toBe('session')
})

test('an event from another session\'s server starts no turn', async ($, on) => {
  const { sent, prompts, stored } = session(on, [
    { events: [], cursor: 'x:0' },
    { events: [move('x-1')], cursor: 'x:1' },
    { events: [move('x-2')], cursor: 'x:2' },
  ])
  await $.tool.call(callStatus)
  await $.command.run({ command: 'mcp-events' })
  expect((await $.command.run({ command: 'mcp-events' })).text).toContain('0 waiting')
  const third = await $.command.run({ command: 'mcp-events' })
  expect(third.text).toContain('0 waiting')
  expect(third.text).toContain('own events only: ids from c')
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok' } as never)
  expect(prompts).toEqual([])
  expect(sent.filter(r => r.method === 'events/poll').map(r => r.params.cursor)).toEqual([null, 'x:0', 'x:1'])
  expect([...stored.values()]).toEqual(['x:2'])
})

test('events are dropped until the status tool has named the server\'s own', async ($, on) => {
  const { prompts, stored } = session(on, [
    { events: [], cursor: 'c:0' },
    { events: [move('c-1')], cursor: 'c:1' },
    { events: [move('c-2')], cursor: 'c:2' },
  ])
  await $.command.run({ command: 'mcp-events' })
  const second = await $.command.run({ command: 'mcp-events' })
  expect(second.text).toContain('0 waiting')
  expect(second.text).toContain('none until forge_status has been called')
  expect([...stored.values()]).toEqual(['c:1'])
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok' } as never)
  expect(prompts).toEqual([])

  await $.tool.call(callStatus)
  expect((await $.command.run({ command: 'mcp-events' })).text).toContain('1 waiting')
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok' } as never)
  expect(prompts).toHaveLength(1)
})

test('a server that does not serve events over HTTP leaves the model its wait tool', async ($, on) => {
  // The result as text, which is how it comes when the engine keeps no structured content.
  const { prompts } = session(on, [{ events: [], cursor: 'x:0' }, { events: [move('x-1')], cursor: 'x:1' }], JSON.stringify({ revision: 3, events: { source: 'c', http: false } }))
  await $.tool.call(callStatus)
  await $.command.run({ command: 'mcp-events' })
  const second = await $.command.run({ command: 'mcp-events' })
  expect(second.text).toContain('ids from c, which forge_status says are not served over HTTP')
  expect((await $.prompt.compose(composing)).sections.map(s => s.id)).toEqual(['intro'])
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok' } as never)
  expect(prompts).toEqual([])
})

test('a truncated poll forgets the server\'s id prefix until the status tool is called again', async ($, on) => {
  const { prompts } = session(on, [
    { events: [], cursor: 'c:0' },
    { events: [], cursor: 'd:0', truncated: true },
    { events: [move('d-1')], cursor: 'd:1' },
  ])
  await $.tool.call(callStatus)
  await $.command.run({ command: 'mcp-events' })
  await $.command.run({ command: 'mcp-events' })
  expect((await $.prompt.compose(composing)).sections.map(s => s.id)).toEqual(['intro'])
  expect((await $.command.run({ command: 'mcp-events' })).text).toContain('0 waiting')
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok' } as never)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('forge.your_move events may have been missed')
})

test('with ownOnly off, every event starts a turn and the note needs no status call', { options: { ownOnly: false } }, async ($, on) => {
  const { prompts } = session(on, [{ events: [], cursor: 'x:0' }, { events: [move('x-1')], cursor: 'x:1' }])
  await $.command.run({ command: 'mcp-events' })
  expect((await $.command.run({ command: 'mcp-events' })).text).not.toContain('own events only')
  expect((await $.prompt.compose(composing)).sections.map(s => s.id)).toEqual(['intro', 'mcp-events:standing'])
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok' } as never)
  expect(prompts).toHaveLength(1)
})

test('the status tool is named by an option', { options: { statusTool: 'seat_status' } }, async ($, on) => {
  session(on, [{ events: [], cursor: 'c:0' }])
  await $.command.run({ command: 'mcp-events' })
  await $.tool.call(callStatus)
  expect((await $.prompt.compose(composing)).sections.map(s => s.id)).toEqual(['intro'])
  await $.tool.call({ tool: 'mcp__forge__seat_status' } as never)
  expect((await $.prompt.compose(composing)).sections.map(s => s.id)).toEqual(['intro', 'mcp-events:standing'])
})
