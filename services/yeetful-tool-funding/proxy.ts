// Two front doors, one service. In Next 16 this `proxy.ts` IS the middleware.
//   /mcp       — FREE: per-IP rate limit, no payment gate (the fleet default).
//   /paid/mcp  — x402 v2 pay-per-call, no throttle: the same tools packaged
//                for agents that would rather pay a cent than manage a key or
//                a rate limit. Fails CLOSED (503 → pointer to /mcp) when the
//                deployment has no PAYMENT_ADDRESS.
import type { NextRequest } from "next/server";
import { createRateLimitProxy } from "@yeetful/mcp-kit";
import { createPaidDoorProxy, mcpDiscovery } from "@yeetful/mcp-kit/x402";
import { PRIMARY_TOOL } from "@/lib/runbook";

const description =
  "Yeetful Finance — the universal cross-chain funding planner over MCP Streamable HTTP, hosted at funding-mcp.yeetful.com/paid/mcp. Turn any agent's 'insufficient funds' into an executable program: scan movable ETH + USDC across Base/Arbitrum/Ethereum, plan the cheapest cross-chain move for a shortfall (destination gas leg included), and get a numbered runbook of exact NEAR Intents tool calls the agent signs with its OWN key. Construction-only — never holds keys, never signs, never submits. Tools: fund_and_build, plan_funding, scan_funding_sources, eth_price, chains. A free rate-limited door serves the same tools at /mcp. Pay-per-call in USDC on Base, no API key. Operated by yeetful.com. Keywords: yeetful, funding, cross-chain, bridge, shortfall, insufficient funds, near intents, agent, wallet, usdc, mcp, x402.";

const paid = createPaidDoorProxy({
  routeKey: "/paid/:transport",
  description,
  discovery: mcpDiscovery({
    toolName: PRIMARY_TOOL.name,
    inputSchema: PRIMARY_TOOL.inputSchema,
  }),
});

const free = createRateLimitProxy();

export function proxy(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/paid/")) return paid(req);
  return free(req);
}

export const config = { matcher: ["/mcp", "/sse", "/paid/mcp", "/paid/sse"] };
