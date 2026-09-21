export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Hyperliquid MCP</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        Hyperliquid over MCP, straight from the public API — live perp + spot
        markets, orderbooks, candles, funding, and per-address portfolio views
        (positions, balances, open orders, fills, PnL). Plus real-time
        settlement watching over WebSocket: ask, and get answered the moment an
        order fills. Free, no API key.
      </p>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>Endpoint</h2>
      <pre style={pre}>POST https://hyperliquid-mcp.yeetful.com/mcp</pre>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Tools</h2>
      <ul style={{ color: "#cdd3df" }}>
        <li>markets / spot_markets / price — live prices, 24h stats, OI, funding, leverage</li>
        <li>orderbook / candles / funding — L2 depth, OHLCV, funding vs Binance &amp; Bybit</li>
        <li>portfolio — positions, margin, collateral available to trade, spot balances, PnL for any address</li>
        <li>open_orders / fills / order_status / ledger — the account&apos;s full activity</li>
        <li>await_settlement — WebSocket watch that returns the moment an order settles</li>
        <li>info_query — read-only escape hatch to the full /info surface</li>
      </ul>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Safety</h2>
      <p style={{ color: "#8b93a7" }}>
        Read-only by construction — this service only ever touches the public
        /info endpoint and WebSocket subscriptions, never /exchange. No keys
        held, nothing signable, no orders placed. Designed to flow into
        Yeetful&apos;s guardrail + sign pipeline.
      </p>

      <p style={{ color: "#8b93a7", marginTop: 24 }}>
        Service metadata: <a style={{ color: "#34e0a1" }} href="/api/info">/api/info</a>
      </p>
    </main>
  );
}

const pre: React.CSSProperties = {
  background: "#11141b",
  border: "1px solid #222836",
  borderRadius: 8,
  padding: "10px 14px",
  overflowX: "auto",
};
