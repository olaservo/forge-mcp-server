/** Must match `PRINCIPAL_HEADER` in the server's `src/transports/http.ts`. */
export const PRINCIPAL_HEADER = "x-forge-principal";

export interface Origin {
  /** Base URL of forge-mcp-server. The request's path and query are appended. */
  url: string;
  /** The server's `FORGE_MCP_PROXY_TOKEN`. */
  token: string;
  /** Who the Worker authenticated. Becomes the caller's principal on the server. */
  principal: string;
  fetch: typeof fetch;
}

/**
 * Sends an authenticated request on to forge-mcp-server. The caller's own credentials stay here:
 * the server sees the proxy token and the principal, and any principal header the client sent is dropped.
 */
export async function forward(request: Request, origin: Origin): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, origin.url);
  const headers = new Headers(request.headers);
  for (const name of ["authorization", "cookie", "host", PRINCIPAL_HEADER]) headers.delete(name);
  headers.set("authorization", `Bearer ${origin.token}`);
  headers.set(PRINCIPAL_HEADER, origin.principal);
  try {
    return await origin.fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: "manual", duplex: "half" } as RequestInit));
  } catch (error) {
    console.error("forge-mcp-server is unreachable", error);
    return new Response("forge-mcp-server is unreachable", { status: 502 });
  }
}
