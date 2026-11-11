import { Bridge } from "./bridge.js";

/**
 * Long-polls the bridge's `/wait` and reports every revision change, so a transport can push
 * `notifications/resources/updated` for `forge://status` to `subscriptions/listen` subscribers
 * instead of the agent polling forge_wait. One watcher per process; it idles with one open
 * request to the bridge and backs off while the bridge is down.
 */
export class StatusWatcher {
  private running = false;
  private since = -1;

  constructor(
    private readonly bridge: Bridge,
    private readonly onChange: (revision: number, status: Record<string, unknown>) => void | Promise<void>,
    private readonly opts: { timeoutSeconds?: number; retryMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    while (this.running) {
      try {
        const status = await this.bridge.get<{ revision: number } & Record<string, unknown>>("/wait", {
          since: this.since,
          timeout: this.opts.timeoutSeconds ?? 30,
        });
        if (!this.running) return;
        const seeded = this.since >= 0;
        if (status.revision !== this.since) {
          this.since = status.revision;
          if (seeded) await this.onChange(status.revision, status);
        }
      } catch {
        if (!this.running) return;
        await sleep(this.opts.retryMs ?? 5000);
      }
    }
  }
}
