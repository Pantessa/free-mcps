import { NextResponse } from "next/server";

// Free, unauthenticated discovery surface — what this service is.
export async function GET() {
  return NextResponse.json({
    name: "hands",
    upstream: "publicnode RPCs (Base/Arbitrum/Ethereum) + Uniswap v3 QuoterV2 on Base for ETH/USD; sign links land on pantessa.com/sign",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    tools: ["what_pantessa_can_do", "what_yeetful_can_do", "scan_wallet", "prepare_handoff", "plan_stock_buy"],
    safety:
      "The agent-handoff front door: reads balances and mints pantessa.com/sign links that carry the ask AS A SENTENCE. Never returns calldata, typed data, artifacts, or addresses; Pantessa's deterministic guarded builders rebuild every action on the other side of the link, and the human's own wallet is the only signer.",
  });
}
