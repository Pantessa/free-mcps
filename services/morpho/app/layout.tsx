import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Morpho MCP · Yeetful",
  description:
    "Morpho (Blue) over MCP on Ethereum + Base — markets with live supply/borrow APYs, per-address positions computed from on-chain state (supplied, collateral, debt, health factor), health-factor previews, and construction-only lend/borrow/repay/withdraw transactions. Free, no API key. This service never signs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#0a0c10",
          color: "#e6e9ef",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}
      >
        {children}
      </body>
    </html>
  );
}
