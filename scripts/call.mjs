// Calls one tool, or polls one event, on a running server over Streamable HTTP, and prints the result.
//   node scripts/call.mjs forge_status
//   node scripts/call.mjs forge_draft_pick '{"card":"Doom Blade"}'
//   node scripts/call.mjs --poll forge.your_move [cursor]
// FORGE_MCP_URL names the endpoint (default http://127.0.0.1:3080/mcp). FORGE_MCP_TOKEN is sent when set.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

const url = new URL(process.env.FORGE_MCP_URL ?? "http://127.0.0.1:3080/mcp");
const token = process.env.FORGE_MCP_TOKEN;
const [what, ...rest] = process.argv.slice(2);
const client = new Client({ name: "call", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
// A request that names an event carries the name in Mcp-Name. The SDK sets that header only for its own methods.
const withHeaders = (target, init) => {
  const headers = new globalThis.Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (what === "--poll" && String(init?.body ?? "").includes('"events/poll"')) headers.set("Mcp-Name", rest[0] ?? "forge.your_move");
  return fetch(target, { ...init, headers });
};
await client.connect(new StreamableHTTPClientTransport(url, { fetch: withHeaders }));

if (what === "--poll") {
  const params = { name: rest[0] ?? "forge.your_move", arguments: {}, cursor: rest[1] ?? null };
  console.log(JSON.stringify(await client.request({ method: "events/poll", params }, z.looseObject({})), null, 2));
} else {
  const result = await client.callTool({ name: what, arguments: rest[0] ? JSON.parse(rest[0]) : {} }, { timeout: 120_000 });
  if (result.isError) process.exitCode = 1;
  console.log(JSON.stringify(result.structuredContent ?? result.content, null, 2));
}
await client.close();
