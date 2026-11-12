/**
 * Cloudflare Worker entry. The OAuth provider owns /authorize, /token, /register and the
 * discovery documents; /mcp is forwarded to forge-mcp-server once the bearer token checks out.
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { parseAllowedEmails, type Env, type Props } from "./env.js";
import { forward } from "./forward.js";
import { googleHandler } from "./google-handler.js";

const SCOPES = ["mcp"];

/** Runs only after the provider validated the bearer token; ctx carries what completeAuthorization stored. */
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext<Props>): Promise<Response> {
    // A grant outlives the sign-in, so an account taken off the allow-list is turned away here too.
    if (!parseAllowedEmails(env.ALLOWED_EMAILS).has(ctx.props.email)) return new Response("Not authorized", { status: 403 });
    return forward(request, {
      url: env.ORIGIN_URL,
      token: env.ORIGIN_TOKEN,
      principal: `google:${ctx.props.id}`,
      fetch: env.ORIGIN ? (input, init) => env.ORIGIN!.fetch(input, init) : fetch,
    });
  },
};

let provider: { instance: OAuthProvider<Env>; resource: string } | undefined;

/** The canonical resource URL comes from an env var, so the provider is built on first request. */
function providerFor(env: Env): OAuthProvider<Env> {
  if (provider?.resource === env.MCP_RESOURCE_URL) return provider.instance;
  const resource = new URL(env.MCP_RESOURCE_URL);
  const instance = new OAuthProvider<Env>({
    apiRoute: resource.pathname,
    apiHandler: mcpApiHandler as never,
    defaultHandler: googleHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: SCOPES,
    resourceMetadata: {
      resource: resource.href,
      authorization_servers: [resource.origin],
      scopes_supported: SCOPES,
      resource_name: "forge-seat",
    },
  });
  provider = { instance, resource: env.MCP_RESOURCE_URL };
  return instance;
}

function allowedHostnames(env: Env): string[] {
  const { hostname } = new URL(env.MCP_RESOURCE_URL);
  return hostname === "localhost" || hostname === "127.0.0.1" ? ["localhost", "127.0.0.1"] : [hostname];
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!allowedHostnames(env).includes(new URL(request.url).hostname)) return new Response("Unknown host", { status: 403 });
    return providerFor(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
