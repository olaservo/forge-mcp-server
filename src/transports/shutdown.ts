/**
 * Runs `stop` and exits on SIGINT or SIGTERM, and with `stdin` also when the client closes the pipe.
 * `stop` ends the bridge this process spawned, which would otherwise outlive it.
 */
export function exitOn(stop: () => void, { stdin = false } = {}): void {
  let stopped = false;
  const exit = () => {
    if (stopped) return;
    stopped = true;
    stop();
    process.exit(0);
  };
  process.on("SIGINT", exit);
  process.on("SIGTERM", exit);
  if (stdin) process.stdin.on("end", exit).on("close", exit);
}
