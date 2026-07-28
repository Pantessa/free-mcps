const pre: React.CSSProperties = {
  background: "#11141b",
  border: "1px solid #232838",
  borderRadius: 8,
  padding: "10px 14px",
  overflowX: "auto",
  color: "#cdd3df",
};

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Yeetful Finance MCP</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        &quot;Insufficient funds&quot; is an offer, never a wall. When any
        action can&apos;t be funded — a stake, a supply, a deposit, a swap —
        this planner scans the wallet&apos;s movable ETH + USDC across Base,
        Arbitrum, and Ethereum and answers with an executable cross-chain
        funding plan: ordered NEAR Intents legs, a destination gas leg when
        the wallet couldn&apos;t even sign the follow-up, and honest numbers
        when the whole wallet can&apos;t cover it.
      </p>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>Endpoint</h2>
      <pre style={pre}>POST https://funding-mcp.yeetful.com/mcp</pre>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Tools</h2>
      <ul style={{ color: "#cdd3df" }}>
        <li>plan_funding — shortfall in, ranked executable options out (legs for the NEAR Intents MCP&apos;s build_swap)</li>
        <li>scan_funding_sources — movable ETH + USDC everywhere, gas-reserve aware, failed chains reported as unknown</li>
        <li>eth_price — the planner&apos;s own ETH/USD read (one QuoterV2 staticcall on Base)</li>
        <li>chains — Base, Arbitrum, Ethereum (Robinhood Chain rides the robinhood MCP&apos;s LiFi plan)</li>
      </ul>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Doctrine</h2>
      <p style={{ color: "#8b93a7" }}>
        Same-token sources outrank stables outrank ETH; destination-chain
        balances are never sources; a source only counts where the wallet
        holds gas to sign; margins cover solver fees and overshoot lands in
        the user&apos;s own wallet; funds must never land where the wallet
        can&apos;t sign the follow-up. Construction-only — this service reads
        balances and prices; it cannot sign, submit, or move anything. The
        legs it emits are executed by the NEAR Intents MCP under its own
        deposit-address guard.
      </p>

      <p style={{ color: "#8b93a7", marginTop: 24 }}>
        Part of the free <code>yeetful-tool-*</code> fleet. Compose it at{" "}
        <a href="https://yeetful.com" style={{ color: "#7cf5c8" }}>
          yeetful.com
        </a>
        .
      </p>
    </main>
  );
}
