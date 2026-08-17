import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pantessa Hands MCP · Pantessa",
  description:
    "Give your agent hands that can't steal: one MCP URL to scan a wallet's movable money, plan an action Pantessa can build (stock buys, swaps, recurring buys, stop-losses, staking, votes), and hand its human ONE sign link where the guarded build happens and their own wallet signs. Never returns calldata or artifacts. Free, construction-only.",
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
