/**
 * The OAuth provider's default handler: the landing page, the consent page, and the
 * Google sign-in round trip. Everything else (token, registration, discovery) is the
 * library's. Follows workers-oauth-provider's docs/upstream-sign-in.md.
 */
import { AuthorizationError, CimdFetchError, type AuthRequest, type ClientInfo } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { parseAllowedEmails, type AuthEnv, type Props } from "./env.js";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:38rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a}
code{background:#f3f4f6;padding:.1em .35em;border-radius:3px}button{font:inherit;padding:.4em 1em}</style>
</head><body>${body}</body></html>`;

function consentPage(client: ClientInfo, request: AuthRequest, handle: string): string {
  const name = escape(client.clientName ?? client.clientId);
  const redirectHost = new URL(request.redirectUri).hostname;
  const local = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(redirectHost);
  const origin = client.clientId.startsWith("https://")
    ? `Published by <strong>${escape(new URL(client.clientId).hostname)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return page(
    `Authorize ${client.clientName ?? client.clientId}`,
    `<h1>Allow ${name} to take the Forge seat as you?</h1>
<p>${origin} Access will be sent to <strong>${escape(redirectHost)}</strong>.</p>
${local ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p>You will sign in with Google next. Only allow-listed accounts are accepted.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`,
  );
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function rememberOptions(env: AuthEnv): { secret: string } | undefined {
  return env.CONSENT_SECRET && env.CONSENT_SECRET.length >= 32 ? { secret: env.CONSENT_SECRET } : undefined;
}

/** Consent is done; save the request and send the browser to Google. */
async function startGoogleSignIn(
  c: { req: { raw: Request }; env: AuthEnv },
  request: AuthRequest,
  headers?: Headers,
): Promise<Response> {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers: out } = await c.env.OAUTH_PROVIDER.beginUpstream(request, {
    data: { verifier },
    headers,
  });
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", new URL("/callback", c.req.raw.url).href);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  out.set("Location", url.href);
  return new Response(null, { status: 302, headers: out });
}

function renderAuthError(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectUri) {
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return Response.redirect(redirect.href, 302);
  }
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
    return new Response(page("Sign-in problem", `<h1>Sign-in problem</h1><p>${escape(message)}</p><p>Start again from your MCP client.</p>`), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  throw error;
}

const app = new Hono<{ Bindings: AuthEnv }>();

app.get("/", (c) =>
  c.html(
    page(
      "forge-seat",
      `<h1>forge-seat</h1>
<p>Sign-in for a personal <a href="https://github.com/olaservo/forge-mcp-server">forge-mcp-server</a>. Not a public service: sign-in is limited to an allow-list of Google accounts.</p>
<p>The MCP endpoint is <code>${escape(new URL(c.env.MCP_RESOURCE_URL).pathname)}</code>.</p>`,
    ),
  ),
);

app.get("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    const client = await oauth.lookupClient(request.clientId);
    if (!client) return c.text("Unknown OAuth client", 400);

    const remember = rememberOptions(c.env);
    if (remember && (await oauth.isConsentRemembered(c.req.raw, request, remember))) {
      return startGoogleSignIn(c, request);
    }

    const consent = await oauth.beginConsent(request);
    consent.headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(consentPage(client, request, consent.handle), { headers: consent.headers });
  } catch (error) {
    return renderAuthError(error);
  }
});

app.post("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  try {
    const form = await c.req.raw.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const remember = rememberOptions(c.env);
    const approved = await oauth.approveConsent(c.req.raw, handle, remember ? { remember } : undefined);
    return startGoogleSignIn(c, approved.request, approved.headers);
  } catch (error) {
    return renderAuthError(error);
  }
});

app.get("/callback", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  try {
    const { request, data, headers } = await oauth.finishUpstream<{ verifier: string }>(c.req.raw);
    const params = new URL(c.req.raw.url).searchParams;

    if (params.get("error") || !params.get("code")) {
      const redirect = new URL(request.redirectUri);
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("state", request.state);
      if (request.issuer) redirect.searchParams.set("iss", request.issuer);
      headers.set("Location", redirect.href);
      return new Response(null, { status: 302, headers });
    }

    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: c.env.GOOGLE_CLIENT_ID,
        client_secret: c.env.GOOGLE_CLIENT_SECRET,
        code: params.get("code")!,
        code_verifier: data.verifier,
        grant_type: "authorization_code",
        redirect_uri: new URL("/callback", c.req.raw.url).href,
      }),
    });
    if (!tokenResponse.ok) {
      console.error("Google token exchange failed", tokenResponse.status, await tokenResponse.text());
      return c.text("Google sign-in failed", 502);
    }
    const { access_token } = (await tokenResponse.json()) as { access_token?: string };
    if (!access_token) return c.text("Google sign-in failed", 502);

    const userResponse = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!userResponse.ok) return c.text("Google sign-in failed", 502);
    const user = (await userResponse.json()) as {
      sub: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    };

    // Fail closed: no list, or an unverified or unlisted email, means no token.
    const allowed = parseAllowedEmails(c.env.ALLOWED_EMAILS);
    const email = user.email?.toLowerCase();
    if (!email || user.email_verified !== true || !allowed.has(email)) {
      console.log(`Rejected sign-in for ${email ?? "(no email)"}: not on the allow-list`);
      return c.text("Not authorized", 403);
    }

    const props: Props = { id: user.sub, email, name: user.name };
    const { redirectTo } = await oauth.completeAuthorization({
      request,
      userId: user.sub,
      metadata: { label: user.name ?? email },
      scope: request.scope,
      props,
    });
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return renderAuthError(error);
  }
});

export const googleHandler = {
  fetch: (request: Request, env: AuthEnv, ctx: ExecutionContext) => app.fetch(request, env, ctx),
};
