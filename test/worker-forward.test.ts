import { describe, expect, it } from "vitest";
import { EventLog } from "../src/events.js";
import { skillCatalog } from "../src/server.js";
import { listenHttp } from "../src/transports/http.js";
import { WebhookHub } from "../src/webhooks.js";
import { PRINCIPAL_HEADER, forward } from "../worker/src/forward.js";
import { fakeBridge } from "./helpers.js";

describe("the Worker's forward", () => {
  it("replaces the caller's credentials with the proxy token and the principal", async () => {
    let seen: Request | undefined;
    const request = new Request("https://seat.example.com/mcp?x=1", {
      method: "POST",
      headers: { authorization: "Bearer client-token", cookie: "a=b", [PRINCIPAL_HEADER]: "google:spoofed", "mcp-method": "tools/list" },
      body: "{}",
    });
    const response = await forward(request, {
      url: "http://127.0.0.1:3080",
      token: "pr0xy",
      principal: "google:1",
      fetch: async (input) => {
        seen = input as Request;
        return new Response("ok");
      },
    });
    expect(await response.text()).toBe("ok");
    expect(seen!.url).toBe("http://127.0.0.1:3080/mcp?x=1");
    expect(seen!.headers.get("authorization")).toBe("Bearer pr0xy");
    expect(seen!.headers.get(PRINCIPAL_HEADER)).toBe("google:1");
    expect(seen!.headers.get("cookie")).toBeNull();
    expect(seen!.headers.get("mcp-method")).toBe("tools/list");
    expect(await seen!.text()).toBe("{}");
  });

  it("answers 502 when the server is unreachable", async () => {
    const response = await forward(new Request("https://seat.example.com/mcp"), {
      url: "http://127.0.0.1:3080",
      token: "pr0xy",
      principal: "google:1",
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    expect(response.status).toBe(502);
  });

  it("reaches a server that takes the proxy token", async () => {
    const server = listenHttp({ bridge: fakeBridge({}).bridge, skills: await skillCatalog(), events: new EventLog(), port: 0, proxyToken: "pr0xy", webhooks: new WebhookHub(new EventLog(), { insecure: true }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const call = (token: string) =>
      forward(
        new Request("https://seat.example.com/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer client-token" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
        }),
        { url: `http://127.0.0.1:${server.port()}`, token, principal: "google:1", fetch },
      );
    expect((await call("wrong")).status).toBe(401);
    const ok = await call("pr0xy");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("forge");
    server.close();
  });
});
