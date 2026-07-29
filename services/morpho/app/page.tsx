export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Morpho MCP</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        Morpho (Blue) over MCP on Ethereum and Base — market discovery with
        live APYs via the official Blue API, per-address positions computed
        from on-chain state (supplied assets, posted collateral, debt with
        accrued interest, health factor), local health-factor previews, and
        construction-only lend/borrow/repay/withdraw transactions encoded
        from the pinned singleton ABI. Free, no API key.
      </p>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>Endpoint</h2>
      <pre style={pre}>POST https://morpho-mcp.yeetful.com/mcp</pre>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Tools</h2>
      <ul style={{ color: "#cdd3df" }}>
        <li>markets / market_info — curated markets with live supply/borrow APYs, utilization, LLTV, size; one market in depth</li>
        <li>position — supplied (earning), collateral posted, debt with accrued interest, health factor for any address</li>
        <li>preview — health factor AFTER a hypothetical action, computed locally before anything is built</li>
        <li>build_lend / build_supply_collateral / build_borrow / build_repay / build_withdraw / build_withdraw_collateral — unsigned transactions the user signs</li>
      </ul>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Safety</h2>
      <p style={{ color: "#8b93a7" }}>
        Signature-free by construction — reads come from on-chain state and
        Morpho&apos;s public API; the build_* tools encode calldata locally
        against the pinned, bytecode-verified singleton and return unsigned
        transactions for the USER&apos;s wallet to sign. Builds fail closed on
        balances, borrowing power, liquidity, and thin health factors. No keys
        held, nothing submitted. Designed to flow into Yeetful&apos;s
        guardrail + sign pipeline.
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
