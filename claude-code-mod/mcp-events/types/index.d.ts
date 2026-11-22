/** What the session's own server said of its events in its status tool. */
export type Own = { source: string; http: boolean; url?: string }

declare module 'claude-code' {
  interface PluginState {
    'mcp-events': { own: Own | null }
  }
}
