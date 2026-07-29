// FREE service — no payment gate. In Next 16 this `proxy.ts` IS the
// middleware. The only front door on a free MCP is the rate limit (a paid
// x402 sibling throttles naturally at $/call; this one doesn't).
import { createRateLimitProxy } from "@yeetful/mcp-kit";

export const proxy = createRateLimitProxy();

export const config = { matcher: ["/mcp", "/sse"] };
