import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";

describe("morpho free front door (rate limit, NO payment gate)", () => {
  it("lets a normal request fall through to the MCP handler (no 402)", async () => {
    const { proxy } = await import("@/proxy");

    const req = new NextRequest("https://morpho-free.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.9.0.1" },
    });

    const res = proxy(req);
    expect(res).toBeUndefined(); // undefined = fall through, no challenge
  });

  it("returns 429 with Retry-After once the per-IP limit is exceeded", async () => {
    const { createRateLimitProxy } = await import("@yeetful/mcp-kit");
    const limited = createRateLimitProxy({ limitPerMinute: 2 });

    const mk = () =>
      new NextRequest("https://morpho-free.test/mcp", {
        method: "POST",
        headers: { "x-forwarded-for": "10.9.0.2" },
      });

    expect(limited(mk())).toBeUndefined();
    expect(limited(mk())).toBeUndefined();

    const blocked = limited(mk());
    expect(blocked).toBeDefined();
    expect(blocked!.status).toBe(429);
    expect(blocked!.headers.get("Retry-After")).toBeTruthy();
  });
});
