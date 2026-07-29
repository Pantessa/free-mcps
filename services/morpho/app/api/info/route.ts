import { NextResponse } from "next/server";

// Free, unauthenticated discovery surface — what this service is. No payment
// block: this is a FREE Yeetful MCP (public RPC reads + Morpho's public API
// need no key).
export async function GET() {
  return NextResponse.json({
    name: "morpho-mcp-free",
    upstream:
      "Morpho (Blue) on Ethereum + Base — the canonical bytecode-verified singleton (0xBBBB…FFCb) read via public RPC for every position/market number, blue-api.morpho.org for market discovery only",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    tools: [
      { name: "markets", description: "Morpho markets on Base or Ethereum: loan/collateral pair, supply & borrow APY, utilization, LLTV, size." },
      { name: "market_info", description: "One market in depth from on-chain state: assets + decimals, APYs, liquidity, fee, oracle price." },
      { name: "position", description: "A wallet's Morpho position from on-chain state: supplied, collateral, debt with accrued interest, health factor." },
      { name: "preview", description: "Simulate an action first: health factor now vs after, borrowing power — nothing built or signed." },
      { name: "build_lend", description: "Prepare unsigned supply transactions — lend an asset into a Morpho market (exact-amount approve step when needed)." },
      { name: "build_supply_collateral", description: "Prepare unsigned collateral-posting transactions for a Morpho market." },
      { name: "build_borrow", description: "Prepare an unsigned borrow — fails closed on borrowing power, liquidity, and thin health factors." },
      { name: "build_repay", description: "Prepare unsigned repay transactions — 'max' clears the debt exactly by shares." },
      { name: "build_withdraw", description: "Prepare an unsigned withdrawal of supplied assets ('max' empties the position)." },
      { name: "build_withdraw_collateral", description: "Prepare an unsigned collateral withdrawal — refuses anything that would endanger outstanding debt." },
    ],
    safety:
      "Signature-free by construction — this service only reads public state and PREPARES calldata; build_* tools return unsigned {to,data,value,chainId} transactions for the USER's wallet to sign (chainId 8453 = Base default, 1 = Ethereum). Calldata is encoded locally from the pinned, bytecode-verified singleton ABI; lending builds fail closed on balances, borrowing power, liquidity, oracle silence, and health factor. Token decimals are always read per asset, never assumed. No keys held, nothing submitted. The connected user's address arrives via Yeetful's $USER_ADDRESS context.",
  });
}
