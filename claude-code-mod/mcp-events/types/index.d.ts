/** What the session's own server said of its events in its status tool. */
export type Own = { source: string; http: boolean; url?: string; registry?: string }

/** What mailbox delivery keeps across a reload of the mod. */
export type MailboxState = {
  /** Counts loads of the module. */
  generation: number
  /** The Standard Webhooks signing secret. The mailbox never has it. */
  secret: string
  /** The id prefix of the server the subscriptions are on. */
  source: string
  hook: { token: string; url: string } | null
  /** The highest mailbox sequence number handled. */
  after: number
  /** Event name to subscription id. */
  subscriptions: Record<string, string>
  /** Event name to the cursor the server last returned from `events/subscribe`. */
  cursors: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    'mcp-events': { own: Own | null; mailbox: MailboxState | null }
  }
}
