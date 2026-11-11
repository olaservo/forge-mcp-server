import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Poll = { events: unknown[]; cursor: string; truncated?: boolean }

/** Stands in for the engine and for a server that lists one event and answers polls from `polls`. */
function session(on: On, polls: Poll[]) {
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
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
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

const move = (eventId: string) => ({ eventId, name: 'forge.your_move', timestamp: '2026-11-11T16:00:00Z', data: { kind: 'priority', prompt: 'Priority: Agent' } })

test('an event starts a turn once, and the cursor is passed back and stored', async ($, on) => {
  const { sent, prompts, stored } = session(on, [
    { events: [], cursor: 'c:0' },
    { events: [move('c-1')], cursor: 'c:1' },
    { events: [move('c-1')], cursor: 'c:1' },
  ])
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
