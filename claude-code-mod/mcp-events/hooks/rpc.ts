import type { EngineInterface } from 'claude-code'

export type Occurrence = { eventId: string; name: string; timestamp: string; data: unknown }

let nextId = 1

/** One JSON-RPC request as a bare POST. The server answers with JSON or a one-message SSE body. */
export async function rpc<T>($: EngineInterface, url: string, method: string, params: Record<string, unknown>, token?: string): Promise<T> {
  // SEP-3415 routing headers: Mcp-Method always, Mcp-Name for requests that carry an event name.
  const routing: Record<string, string> = { 'mcp-method': method }
  if (typeof params.name === 'string') routing['mcp-name'] = params.name
  if (token) routing.authorization = `Bearer ${token}`
  const res = await $.http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...routing },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
  const data = res.text.split('\n').find(line => line.startsWith('data:'))
  let message: { result?: T; error?: { code: number; message: string } }
  try {
    message = JSON.parse(data ? data.slice(5) : res.text) as typeof message
  } catch {
    throw new Error(`${method}: HTTP ${res.status}`)
  }
  if (message.error) throw new Error(`${method}: ${message.error.message} (${message.error.code})`)
  if (!res.ok || message.result === undefined) throw new Error(`${method}: HTTP ${res.status}`)
  return message.result
}
