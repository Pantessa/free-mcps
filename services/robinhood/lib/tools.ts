import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { clip, type RhResult } from "./util";
import { reads } from "./reads";
import { morphoReads } from "./morpho";
import { builds } from "./tx";
import { swap } from "./swap";
import { registerBrokerageTools } from "./brokerage-tools";

function present(result: RhResult) {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: typeof result.data === "string" ? result.data : `Robinhood Chain service error (HTTP ${result.status}): ${JSON.stringify(result.data)}`,
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(clip(result.data)) }] };
}

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

// ── Shared arg schemas ───────────────────────────────────────────────────────

// The account address. Yeetful's planner substitutes the connected user's
// wallet as $USER_ADDRESS — "my portfolio" / "my loans" resolve to this.
const userArg = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe(
    "EVM address (0x…) of the account. For the CONNECTED USER's own portfolio/positions/transactions, pass their wallet address ($USER_ADDRESS).",
  );

// Human-readable token amount as a decimal string ("1", "0.5") — never atoms.
const amountArg = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .describe('Token amount as a decimal string in HUMAN units, e.g. "100" USDG or "0.5" AAPL (not wei/atoms).');

const amountOrMaxArg = z
  .string()
  .regex(/^(\d+(\.\d+)?|max)$/)
  .describe('Token amount as a decimal string in HUMAN units, or "max" for the full balance/debt.');

const tokenArg = z
  .string()
  .min(1)
  .max(64)
  .describe('Token symbol ("AAPL", "TSLA", "USDG", case-insensitive) or 0x address on Robinhood Chain.');

const marketIdArg = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .describe("The 32-byte Morpho market id (0x…, 64 hex chars) from lending_markets.");

const asUser = (s: string) => s as `0x${string}`;

/** The flagship tool — kept in sync with the registration below (the Bazaar
 *  discovery extension validates this). */
export const PRIMARY_TOOL = {
  name: "portfolio",
  description:
    "Whole-wallet portfolio on Robinhood Chain: ETH, tokenized stocks/ETFs (AAPL, TSLA, SPY, …), USDG and other tokens, each USD-valued via Chainlink.",
  inputSchema: {
    type: "object",
    properties: {
      user: { type: "string", description: "EVM address (0x…) — the connected user's wallet ($USER_ADDRESS)." },
    },
    required: ["user"],
  },
} as const;

/** Register the Robinhood Chain read + lending + trading + bridge tool surface. */
export function registerRobinhoodTools(server: Server): void {
  // ── Chain + token data ─────────────────────────────────────────────────
  server.registerTool(
    "chain_info",
    {
      title: "Robinhood Chain Info",
      description:
        "Robinhood Chain (chain id 4663) at a glance: the Arbitrum-Orbit stack, RPC/explorer endpoints, and where each protocol lives — Uniswap v4 for stock-token trading, Morpho for lending, the canonical bridge. Answers 'what is Robinhood Chain / what runs on it?'. Getting money HERE: Yeetful's funding planner builds LiFi legs from Base/Ethereum/Arbitrum automatically (just ask the end action); the canonical bridge moves ETH from Ethereum; NEAR Intents (1Click chain \"hood\", since 2026-09-21) moves USDG in and USDG/ETH out in about half a minute, but lists none of the stock tokens.",
      inputSchema: {},
    },
    async () => present(await reads.chainInfo()),
  );

  server.registerTool(
    "stock_tokens",
    {
      title: "Stock Token Directory",
      description:
        "The tokenized stocks & ETFs on Robinhood Chain (AAPL, TSLA, NVDA, SPY, QQQ, …) plus the money tokens (USDG, USDe, WETH) — symbol, name, contract address, decimals, and Chainlink feed. Answers 'which stocks can I trade on Robinhood Chain?'.",
      inputSchema: {},
    },
    async () => present(await reads.stockTokens()),
  );

  server.registerTool(
    "token_info",
    {
      title: "Token Deep-Dive",
      description:
        "One Robinhood Chain token in depth: live Chainlink USD price (staleness-checked), total supply, and the ERC-8056 corporate-action state (uiMultiplier, pending multiplier changes, oracle pause). Answers 'what's AAPL trading at on-chain?'.",
      inputSchema: { token: tokenArg },
    },
    async ({ token }) => present(await reads.tokenInfo({ token })),
  );

  server.registerTool(
    "prices",
    {
      title: "Live Prices",
      description:
        "Batch Chainlink USD prices for Robinhood Chain tokens — pass symbols for specific ones or nothing for the whole board. Prices already include corporate-action multipliers. Answers 'price check TSLA and NVDA'.",
      inputSchema: {
        tokens: z.array(tokenArg).max(40).optional().describe("Symbols/addresses to price. Omit for every token with a feed."),
      },
    },
    async ({ tokens }) => present(await reads.prices({ tokens })),
  );

  server.registerTool(
    "portfolio",
    {
      title: "Robinhood Chain Portfolio",
      description:
        "Whole-wallet view on Robinhood Chain: native ETH, every tokenized stock/ETF, USDG/USDe/WETH — balances with live USD values and a total. This is the 'what do I hold on Robinhood Chain?' tool. Morpho lending positions live in lending_position.",
      inputSchema: { user: userArg },
    },
    async ({ user }) => present(await reads.portfolio({ user: asUser(user) })),
  );

  // ── Lending (Morpho) ───────────────────────────────────────────────────
  server.registerTool(
    "lending_markets",
    {
      title: "Morpho Lending Markets",
      description:
        "Morpho lending markets on Robinhood Chain: loan/collateral pair, supply & borrow APY, utilization, LLTV, and market size. Curated markets by default (USDG against USDe/syrupUSDG/…); includeUnlisted adds permissionless ones like early stock-collateral markets. Answers 'what can I lend/borrow on Robinhood Chain?'.",
      inputSchema: {
        includeUnlisted: z.boolean().optional().describe("Also show permissionless (unvetted) markets. Default false."),
      },
    },
    async ({ includeUnlisted }) => present(await morphoReads.markets({ includeUnlisted })),
  );

  server.registerTool(
    "lending_position",
    {
      title: "Morpho Lending Position",
      description:
        "A wallet's Morpho position on Robinhood Chain, computed from on-chain state: supplied assets (earning), posted collateral, borrowed debt with accrued interest, borrowing power, and health factor per market. Answers 'how are my loans doing / can I get liquidated?'.",
      inputSchema: {
        user: userArg,
        marketIds: z.array(marketIdArg).max(20).optional().describe("Specific market ids to check. Omit to scan all known markets."),
      },
    },
    async ({ user, marketIds }) => present(await morphoReads.position({ user: asUser(user), marketIds: marketIds as `0x${string}`[] | undefined })),
  );

  server.registerTool(
    "build_lend",
    {
      title: "Build: Lend (Supply to Morpho)",
      description:
        "Prepare UNSIGNED transactions to lend an asset into a Morpho market on Robinhood Chain and start earning the supply APY — exact-amount approve step included only when the live allowance is short. Balances are checked before building. 'Lend 100 USDG'.",
      inputSchema: { user: userArg, marketId: marketIdArg, amount: amountArg.describe('LOAN-asset amount to supply, e.g. "100" USDG.') },
    },
    async ({ user, marketId, amount }) => present(await builds.lend({ user: asUser(user), marketId, amount })),
  );

  server.registerTool(
    "build_supply_collateral",
    {
      title: "Build: Post Collateral",
      description:
        "Prepare UNSIGNED transactions to post collateral into a Morpho market on Robinhood Chain (collateral doesn't earn; it unlocks borrowing the loan asset). 'Post 1 TSLA as collateral'.",
      inputSchema: { user: userArg, marketId: marketIdArg, amount: amountArg.describe('COLLATERAL-asset amount to post, e.g. "1.5" TSLA.') },
    },
    async ({ user, marketId, amount }) => present(await builds.supplyCollateral({ user: asUser(user), marketId, amount })),
  );

  server.registerTool(
    "build_borrow",
    {
      title: "Build: Borrow",
      description:
        "Prepare an UNSIGNED borrow against posted Morpho collateral on Robinhood Chain. Fails closed: refuses when the amount exceeds borrowing power or market liquidity, warns when the resulting health factor is thin. 'Borrow 50 USDG against my TSLA'.",
      inputSchema: { user: userArg, marketId: marketIdArg, amount: amountArg.describe('LOAN-asset amount to borrow, e.g. "50" USDG.') },
    },
    async ({ user, marketId, amount }) => present(await builds.borrow({ user: asUser(user), marketId, amount })),
  );

  server.registerTool(
    "build_repay",
    {
      title: "Build: Repay",
      description:
        'Prepare UNSIGNED transactions to repay Morpho debt on Robinhood Chain. Pass "max" to clear the debt exactly (repaid by shares, immune to interest drift). Approve step included when needed. \'Repay my USDG loan\'.',
      inputSchema: { user: userArg, marketId: marketIdArg, amount: amountOrMaxArg },
    },
    async ({ user, marketId, amount }) => present(await builds.repay({ user: asUser(user), marketId, amount })),
  );

  server.registerTool(
    "build_withdraw",
    {
      title: "Build: Withdraw Supplied Assets",
      description:
        'Prepare an UNSIGNED withdrawal of assets supplied to a Morpho market on Robinhood Chain ("max" empties the position including accrued interest). Refuses when market utilization leaves too little un-borrowed liquidity.',
      inputSchema: { user: userArg, marketId: marketIdArg, amount: amountOrMaxArg },
    },
    async ({ user, marketId, amount }) => present(await builds.withdraw({ user: asUser(user), marketId, amount })),
  );

  server.registerTool(
    "build_withdraw_collateral",
    {
      title: "Build: Withdraw Collateral",
      description:
        "Prepare an UNSIGNED collateral withdrawal from a Morpho market on Robinhood Chain. Fails closed: refuses any withdrawal that would leave outstanding debt under-collateralized or the health factor razor-thin.",
      inputSchema: { user: userArg, marketId: marketIdArg, amount: amountOrMaxArg },
    },
    async ({ user, marketId, amount }) => present(await builds.withdrawCollateral({ user: asUser(user), marketId, amount })),
  );

  // ── Trading (Uniswap v4) ───────────────────────────────────────────────
  server.registerTool(
    "quote",
    {
      title: "Swap Quote (Uniswap v4)",
      description:
        "Live Uniswap v4 quote on Robinhood Chain for any registry pair — tokenized stocks quote against USDG ('how much AAPL for 500 USDG?'). Scans the standard no-hook pools, best price wins. A stock pair is checked against Robinhood's 24/7 tape (Yahoo Finance as the fallback): tapeCheck gives the fill's per-share price, the tape, and the gap. A pool more than 10% off the tape comes back offTape with NO buy estimate — its number is not the stock's price, and build_swap won't fill there. No tape → the quote is marked unchecked. Pairs with no stock keep a Chainlink cross-check. To actually trade, build_swap prepares the signable chain (including for venue-gated stock pools, via LiFi).",
      inputSchema: {
        sellToken: tokenArg.describe('Token to sell — symbol or address, e.g. "USDG".'),
        buyToken: tokenArg.describe('Token to buy, e.g. "AAPL".'),
        amount: amountArg.describe("Amount of sellToken to swap."),
      },
    },
    async ({ sellToken, buyToken, amount }) => present(await swap.quote({ sellToken, buyToken, amount })),
  );

  server.registerTool(
    "build_swap",
    {
      title: "Build: Swap Stock Tokens",
      description:
        "Prepare an UNSIGNED swap on Robinhood Chain — buy or sell tokenized stocks (AAPL, TSLA, NVDA, …) against USDG, or any quoted pair. Two settlement paths, picked automatically: pools that execute directly get ONE Universal Router Uniswap v4 swap (exact-amount Permit2 approvals only when live allowances are short); venue-gated stock pools — which only clear through Robinhood's backend-signed DexAggregator — build through LiFi's whitelisted router instead, with a 0.2% Yeetful fee as an explicit transfer step. Every stock fill is checked against Robinhood's 24/7 tape before anything is built: a pool whose quote — or whose minimum out at the chosen slippage — sits more than 10% off the tape, either side, is skipped for LiFi, whose fill must land inside the bound too, else the build is refused by name; no tape, no build. Either way the build is re-decoded and guard-verified (pinned addresses, exact amounts, independent price check, simulation) before it's returned, and balances are checked first. 'Buy AAPL with 500 USDG' / 'buy 5 USDG of AAPL' — stock swaps ARE buildable here.",
      inputSchema: {
        user: userArg,
        sellToken: tokenArg.describe("Token to sell."),
        buyToken: tokenArg.describe("Token to buy."),
        amount: amountArg.describe("Amount of sellToken to swap."),
        slippageBps: z.number().int().min(1).max(5000).optional().describe("Slippage tolerance in basis points (100 = 1%). Default 100."),
      },
    },
    async ({ user, sellToken, buyToken, amount, slippageBps }) =>
      present(await swap.build({ user: asUser(user), sellToken, buyToken, amount, slippageBps })),
  );

  // ── Bridge ─────────────────────────────────────────────────────────────
  server.registerTool(
    "bridge_info",
    {
      title: "Bridge Overview",
      description:
        "How to move funds between Ethereum and Robinhood Chain over the canonical Arbitrum bridge: routes, timing (deposits ≈ minutes, withdrawals ≈ 7 days + an L1 claim), contract addresses, and what must go through the bridge UI instead. Includes the lane map — when a funding shortfall should use Yeetful's automatic LiFi legs instead of this bridge, and what NEAR Intents covers on Robinhood Chain (USDG in, USDG/ETH out; no stocks, and no liquidity into gas ETH so far).",
      inputSchema: {},
    },
    async () => present(await builds.bridgeInfo()),
  );

  server.registerTool(
    "build_bridge_deposit",
    {
      title: "Build: Bridge ETH In",
      description:
        "Prepare an UNSIGNED Ethereum-mainnet transaction (chainId 1!) that bridges ETH into Robinhood Chain via the canonical Delayed Inbox — the same address is credited on the L2 within minutes. L1 balance checked before building. 'Bridge 0.1 ETH to Robinhood Chain'. ETH only, from Ethereum only — to FUND a stock buy from USDC (any chain), skip manual bridging and ask for the buy itself: the funding planner builds LiFi legs automatically.",
      inputSchema: { user: userArg, amount: amountArg.describe('ETH amount to bridge in, e.g. "0.1".') },
    },
    async ({ user, amount }) => present(await builds.bridgeDeposit({ user: asUser(user), amount })),
  );

  server.registerTool(
    "build_bridge_withdraw",
    {
      title: "Build: Bridge ETH Out",
      description:
        "Prepare an UNSIGNED Robinhood Chain transaction that starts an ETH withdrawal to Ethereum over the canonical bridge. NOT instant: the exit waits out the ~7-day challenge period and is then claimed on Ethereum via the bridge UI. 'Withdraw 0.5 ETH back to mainnet'.",
      inputSchema: {
        user: userArg,
        amount: amountArg.describe('ETH amount to withdraw, e.g. "0.5".'),
        destination: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional().describe("Ethereum address to receive the ETH. Defaults to the sender."),
      },
    },
    async ({ user, amount, destination }) => present(await builds.bridgeWithdraw({ user: asUser(user), amount, destination })),
  );

  // ── Brokerage (Robinhood Crypto Trading API — the user's real Robinhood
  //    account; per-request credentials, two-step guarded orders) ─────────
  registerBrokerageTools(server);
}
