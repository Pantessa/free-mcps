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
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Pantessa Hands</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        Give your agent hands that can&apos;t steal. One MCP URL and any agent —
        Claude Desktop, Claude Code, OpenClaw, your own — can scan a wallet&apos;s
        movable money, plan an action Pantessa knows how to build (stock buys on
        Robinhood Chain, swaps, recurring buys, stop-losses, staking, votes),
        and hand its human ONE link where the guarded build happens and their
        own wallet signs. This service never returns calldata, artifacts, or
        addresses: the agent plans, Pantessa&apos;s deterministic builders rebuild,
        the human stays the only signer.
      </p>
      <h2 style={{ fontSize: 18, marginBottom: 6 }}>Connect</h2>
      <pre style={pre}>
        <code>claude mcp add --transport http pantessa-hands https://hands-mcp.yeetful.com/mcp</code>
      </pre>
      <p style={{ color: "#8b93a7" }}>
        Tools: <code>what_pantessa_can_do</code> · <code>scan_wallet</code> ·{" "}
        <code>prepare_handoff</code> · <code>plan_stock_buy</code>. Free +
        rate-limited; discovery at <code>/api/info</code>. For a stateful
        negotiation loop that talks back, connect the desk at{" "}
        <code>/api/broker/mcp</code>. By{" "}
        <a href="https://www.pantessa.com" style={{ color: "#7dd3a8" }}>
          pantessa.com
        </a>
        .
      </p>
    </main>
  );
}
