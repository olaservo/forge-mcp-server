#!/usr/bin/env node

const transportName = process.argv[2] ?? "stdio";

switch (transportName) {
  case "stdio":
    await import("./transports/stdio.js");
    break;
  case "streamableHttp":
  case "http":
    await import("./transports/streamableHttp.js");
    break;
  default:
    console.error(`Unknown transport: ${transportName}. Use stdio or streamableHttp.`);
    process.exit(1);
}
