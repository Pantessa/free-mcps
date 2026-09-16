const tools: Array<[string, string]> = [
  ["chain_info", "Chain facts + where trading, lending, and the bridge live"],
  ["stock_tokens", "Tokenized stock/ETF directory (AAPL, TSLA, SPY, …)"],
  ["token_info", "Live price + corporate-action multiplier for one token"],
  ["prices", "Batch Chainlink USD prices, staleness-checked"],
  ["portfolio", "Whole-wallet balances with USD values"],
  ["lending_markets", "Morpho markets: APYs, utilization, LLTV"],
  ["lending_position", "Supplied / collateral / debt / health factor"],
  ["build_lend", "Unsigned: supply an asset to a Morpho market"],
  ["build_supply_collateral", "Unsigned: post collateral"],
  ["build_borrow", "Unsigned: borrow against collateral (fails closed)"],
  ["build_repay", "Unsigned: repay debt ('max' clears exactly)"],
  ["build_withdraw", "Unsigned: withdraw supplied assets"],
  ["build_withdraw_collateral", "Unsigned: withdraw collateral (health-checked)"],
  ["quote", "Uniswap v4 quote, checked against the stock's tape"],
  ["build_swap", "Unsigned: guard-verified swap (stocks ↔ USDG), tape-checked"],
  ["bridge_info", "Canonical bridge routes + timing"],
  ["build_bridge_deposit", "Unsigned: bridge ETH in from Ethereum"],
  ["build_bridge_withdraw", "Unsigned: start an ETH exit to Ethereum"],
];

export default function Home() {
  return (
    <main style={{ maxWidth: 780, margin: "0 auto", padding: "56px 24px" }}>
      <p style={{ color: "#8b93a7", letterSpacing: 2, fontSize: 12 }}>YEETFUL · FREE MCP</p>
      <h1 style={{ fontSize: 34, margin: "8px 0 4px" }}>Robinhood Chain MCP</h1>
      <p style={{ color: "#aab2c5", lineHeight: 1.6 }}>
        Tokenized stocks &amp; ETFs on Robinhood Chain (chain id 4663) over MCP — live Chainlink prices with
        corporate-action multipliers, whole-wallet portfolios, Morpho lending &amp; borrowing, Uniswap v4 swap
        quotes, and the canonical Ethereum bridge. Free, no API key, no signup.
      </p>

      <div style={{ background: "#11151d", border: "1px solid #232a38", borderRadius: 10, padding: "14px 18px", margin: "22px 0" }}>
        <code style={{ color: "#7ee787" }}>POST https://robinhood-mcp.yeetful.com/mcp</code>
        <p style={{ color: "#8b93a7", margin: "8px 0 0", fontSize: 13 }}>
          Streamable HTTP MCP endpoint (also /sse). Discovery: <a href="/api/info" style={{ color: "#79b8ff" }}>/api/info</a>
        </p>
      </div>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Tools</h2>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }}>
        <tbody>
          {tools.map(([name, desc]) => (
            <tr key={name} style={{ borderBottom: "1px solid #1a2030" }}>
              <td style={{ padding: "7px 14px 7px 0", color: "#7ee787", whiteSpace: "nowrap", verticalAlign: "top" }}>{name}</td>
              <td style={{ padding: "7px 0", color: "#aab2c5" }}>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Safety</h2>
      <p style={{ color: "#aab2c5", lineHeight: 1.6, fontSize: 14 }}>
        Signature-free by construction. This service only reads public state and <em>prepares</em> calldata —
        build_* tools return unsigned transactions for the user&apos;s own wallet to sign. Swap builds are
        re-decoded and verified field-by-field against the quote before they&apos;re returned; lending builds
        refuse anything that would endanger a position. No keys held, nothing ever submitted.
      </p>
    </main>
  );
}
