import { NextResponse } from "next/server";

// Free, unauthenticated discovery surface — what this service is. No payment
// block: this is a FREE Yeetful MCP (the public Hyperliquid API needs no key).
export async function GET() {
  return NextResponse.json({
    name: "hyperliquid-mcp-free",
    upstream: "Hyperliquid public API (api.hyperliquid.xyz — HTTP info + WebSocket)",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    tools: [
      { name: "markets", description: "Perp markets: price, 24h change/volume, open interest, funding, leverage." },
      { name: "spot_markets", description: "Spot pairs with '@N' names resolved to tokens." },
      { name: "price", description: "Live mids for any coins (perp + spot aliases)." },
      { name: "orderbook", description: "L2 book with best bid/ask, spread, depth." },
      { name: "candles", description: "OHLCV history for any coin + interval." },
      { name: "funding", description: "Funding history + predicted next rate vs Binance/Bybit." },
      { name: "portfolio", description: "Account view for an address: positions, margin, collateral available to trade, spot balances, PnL." },
      { name: "open_orders", description: "An address's resting orders (incl. trigger/TP-SL detail)." },
      { name: "fills", description: "Executed trades with PnL + fees, time-boundable." },
      { name: "order_status", description: "One order's status by oid/cloid." },
      { name: "ledger", description: "USDC ledger: funding payments or deposits/withdrawals/transfers." },
      { name: "await_settlement", description: "Live WebSocket watch — returns the moment an order fills/cancels (or times out)." },
      { name: "info_query", description: "Read-only escape hatch to the full /info surface (vaults, staking, fees…)." },
    ],
    safety:
      "Read-only by construction — only the public /info endpoint and WS subscriptions are ever touched, never /exchange. No keys held, nothing signable, no orders placed. Account data is public-by-address; the connected user's address arrives via Yeetful's $USER_ADDRESS context.",
  });
}
