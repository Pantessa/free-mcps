import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Yeetful Finance MCP · Yeetful",
  description:
    "The universal funding planner over MCP — scan a wallet's movable ETH + USDC across Base/Arbitrum/Ethereum and turn any insufficient-funds refusal into an executable cross-chain funding plan (NEAR Intents legs, destination gas included). Free, construction-only, no API key required to call.",
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
