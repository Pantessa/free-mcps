import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { morphoReads } from "./morpho";
import { builds, preview } from "./tx";
import { clip, type MorphoResult } from "./util";
import { DEFAULT_CHAIN_ID, type SupportedChainId } from "./registry";

function present(result: MorphoResult) {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: typeof result.data === "string" ? result.data : `Morpho service error (HTTP ${result.status}): ${JSON.stringify(result.data)}`,
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(clip(result.data)) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

// ── Shared arg schemas ───────────────────────────────────────────────────────

// The account address. Yeetful's planner substitutes the connected user's
// wallet as $USER_ADDRESS — "my position" / "my loans" resolve to this.
const userArg = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe(
    "EVM address (0x…) of the account. For the CONNECTED USER's own position/loans/transactions, pass their wallet address ($USER_ADDRESS).",
  );

// Every tool is chain-scoped: Base by default, Ethereum on request.
// (Morpho on Robinhood Chain 4663 lives in the robinhood MCP, not here.)
const chainIdArg = z
  .preprocess(
    (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v),
    z.union([z.literal(1), z.literal(8453)]),
  )
  .default(DEFAULT_CHAIN_ID)
  .describe("Chain id: 8453 = Base (default), 1 = Ethereum mainnet. Market ids are chain-specific — use the chainId the market came from.");

// Human-readable token amount as a decimal string ("100", "0.5") — never atoms.
const amountArg = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .describe('Token amount as a decimal string in HUMAN units, e.g. "100" USDC or "0.5" WETH (not wei/atoms).');

const amountOrMaxArg = z
  .string()
  .regex(/^(\d+(\.\d+)?|max)$/)
  .describe('Token amount as a decimal string in HUMAN units, or "max" for the full balance/debt.');

const marketIdArg = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .describe("The 32-byte Morpho market id (0x…, 64 hex chars) from `markets` — NOT a token symbol or address.");

const asUser = (s: string) => s as `0x${string}`;
const asChain = (n: number) => n as SupportedChainId;

/** Register the Morpho market + position + transaction-building tool surface. */
export function registerMorphoTools(server: Server): void {
  // ── Market data ────────────────────────────────────────────────────────
  server.registerTool(
    "markets",
    {
      title: "Morpho Lending Markets",
      description:
        "Morpho (Blue) lending markets on Base or Ethereum: loan/collateral pair, supply & borrow APY, utilization, LLTV, and market size in USD. Curated (listed) markets by default; includeUnlisted adds permissionless ones. Answers 'what can I lend/borrow on Morpho?' — use the returned marketId with the build_* tools.",
      inputSchema: {
        chainId: chainIdArg,
        includeUnlisted: z.boolean().optional().describe("Also show permissionless (unvetted) markets. Default false."),
      },
    },
    async ({ chainId, includeUnlisted }) => present(await morphoReads.markets({ chainId: asChain(chainId), includeUnlisted })),
  );

  server.registerTool(
    "market_info",
    {
      title: "Morpho Market Deep-Dive",
      description:
        "One Morpho market in depth, straight from the chain: loan + collateral assets (addresses, decimals), LLTV, live supply/borrow APY, utilization, available liquidity, fee, and the oracle's collateral price. Use before lending or borrowing to sanity-check the market.",
      inputSchema: { chainId: chainIdArg, marketId: marketIdArg },
    },
    async ({ chainId, marketId }) => present(await morphoReads.marketInfo({ chainId: asChain(chainId), marketId })),
  );

  // ── Account views ──────────────────────────────────────────────────────
  server.registerTool(
    "position",
    {
      title: "Morpho Position",
      description:
        "A wallet's Morpho position on Base or Ethereum, computed from on-chain state: supplied assets (earning), posted collateral, borrowed debt with accrued interest, borrowing power, and health factor per market. This is the 'show my Morpho position / can I get liquidated?' tool. Scans the 100 largest indexed markets by default; pass marketIds to narrow or to reach a niche market.",
      inputSchema: {
        user: userArg,
        chainId: chainIdArg,
        marketIds: z.array(marketIdArg).max(20).optional().describe("Specific market ids to check. Omit to scan all known markets."),
      },
    },
    async ({ user, chainId, marketIds }) =>
      present(await morphoReads.position({ chainId: asChain(chainId), user: asUser(user), marketIds: marketIds as `0x${string}`[] | undefined })),
  );

  // ── Simulation ─────────────────────────────────────────────────────────
  server.registerTool(
    "preview",
    {
      title: "Preview Position After Action",
      description:
        "Simulate a lend/supply_collateral/borrow/repay/withdraw/withdraw_collateral BEFORE building it: health factor now vs after, borrowing power after — computed locally from live on-chain state and the market's oracle. Nothing is built or signed. Use this before build_borrow / a large build_withdraw_collateral so the user sees the health-factor impact first.",
      inputSchema: {
        action: z.enum(["lend", "supply_collateral", "borrow", "repay", "withdraw", "withdraw_collateral"]).describe("The action to simulate."),
        user: userArg.describe("The wallet the action would run as — $USER_ADDRESS for the connected user."),
        chainId: chainIdArg,
        marketId: marketIdArg,
        amount: amountOrMaxArg.describe('Amount to simulate, or "max" (repay/withdraw/withdraw_collateral only).'),
      },
    },
    async ({ action, user, chainId, marketId, amount }) =>
      present(await preview({ chainId: asChain(chainId), user: asUser(user), marketId, action, amount })),
  );

  // ── Transaction building (construction-only — the USER signs) ─────────
  registerBuildTools(server);
}

// ── Build tools (split out for readability; same registration pass) ─────────

function registerBuildTools(server: Server): void {
  const sharedNote =
    "Returns UNSIGNED transaction step(s) {action:'send_transaction', tx:{to,data,value,chainId}} for the USER's wallet — an exact-amount ERC-20 approve step first when the live allowance is short. Balances and market health are checked before building. Nothing is signed or submitted by this service.";

  server.registerTool(
    "build_lend",
    {
      title: "Build: Lend (Supply to Morpho)",
      description: `Prepare transactions to lend an asset into a Morpho market and start earning the supply APY. ${sharedNote} 'Lend 100 USDC on Base'.`,
      inputSchema: { user: userArg, chainId: chainIdArg, marketId: marketIdArg, amount: amountArg.describe('LOAN-asset amount to supply, e.g. "100" USDC.') },
    },
    async ({ user, chainId, marketId, amount }) => present(await builds.lend({ chainId: asChain(chainId), user: asUser(user), marketId, amount })),
  );

  server.registerTool(
    "build_supply_collateral",
    {
      title: "Build: Post Collateral",
      description: `Prepare transactions to post collateral into a Morpho market (collateral doesn't earn; it unlocks borrowing the loan asset). ${sharedNote} 'Post 0.5 WETH as collateral'.`,
      inputSchema: { user: userArg, chainId: chainIdArg, marketId: marketIdArg, amount: amountArg.describe('COLLATERAL-asset amount to post, e.g. "0.5" WETH.') },
    },
    async ({ user, chainId, marketId, amount }) => present(await builds.supplyCollateral({ chainId: asChain(chainId), user: asUser(user), marketId, amount })),
  );

  server.registerTool(
    "build_borrow",
    {
      title: "Build: Borrow",
      description: `Prepare a borrow against posted Morpho collateral. Fails closed: refuses when the amount exceeds borrowing power or market liquidity, warns when the resulting health factor is thin. ${sharedNote} 'Borrow 50 USDC against my WETH'.`,
      inputSchema: { user: userArg, chainId: chainIdArg, marketId: marketIdArg, amount: amountArg.describe('LOAN-asset amount to borrow, e.g. "50" USDC.') },
    },
    async ({ user, chainId, marketId, amount }) => present(await builds.borrow({ chainId: asChain(chainId), user: asUser(user), marketId, amount })),
  );

  server.registerTool(
    "build_repay",
    {
      title: "Build: Repay",
      description: `Prepare transactions to repay Morpho debt. Pass "max" to clear the debt exactly (repaid by shares, immune to interest drift — the approve carries a ~0.05% buffer). ${sharedNote}`,
      inputSchema: { user: userArg, chainId: chainIdArg, marketId: marketIdArg, amount: amountOrMaxArg },
    },
    async ({ user, chainId, marketId, amount }) => present(await builds.repay({ chainId: asChain(chainId), user: asUser(user), marketId, amount })),
  );

  server.registerTool(
    "build_withdraw",
    {
      title: "Build: Withdraw Supplied Assets",
      description: `Prepare a withdrawal of assets supplied to a Morpho market ("max" empties the position including accrued interest). Refuses when market utilization leaves too little un-borrowed liquidity. ${sharedNote}`,
      inputSchema: { user: userArg, chainId: chainIdArg, marketId: marketIdArg, amount: amountOrMaxArg },
    },
    async ({ user, chainId, marketId, amount }) => present(await builds.withdraw({ chainId: asChain(chainId), user: asUser(user), marketId, amount })),
  );

  server.registerTool(
    "build_withdraw_collateral",
    {
      title: "Build: Withdraw Collateral",
      description: `Prepare a collateral withdrawal from a Morpho market. Fails closed: refuses any withdrawal that would leave outstanding debt under-collateralized or the health factor razor-thin. ${sharedNote}`,
      inputSchema: { user: userArg, chainId: chainIdArg, marketId: marketIdArg, amount: amountOrMaxArg },
    },
    async ({ user, chainId, marketId, amount }) => present(await builds.withdrawCollateral({ chainId: asChain(chainId), user: asUser(user), marketId, amount })),
  );
}

// Kept in sync with the flagship tool above — the Bazaar discovery extension
// validates this JSON Schema.
export const PRIMARY_TOOL = {
  name: "position",
  description:
    "A wallet's Morpho (Blue) lending position on Base or Ethereum, computed from on-chain state: supplied assets earning, posted collateral, debt with accrued interest, borrowing power, health factor per market. Other tools: markets (curated markets with live APYs + the marketId every other tool takes), market_info, preview (health factor AFTER a hypothetical action), build_lend/build_supply_collateral/build_borrow/build_repay/build_withdraw/build_withdraw_collateral (unsigned txs the user signs — user = \"$USER_ADDRESS\" for the connected user). Every tool takes chainId: 8453 = Base (default), 1 = Ethereum.",
  inputSchema: {
    type: "object",
    properties: {
      user: {
        type: "string",
        description: "EVM address (0x…) — $USER_ADDRESS for the connected user.",
      },
      chainId: {
        type: "number",
        enum: [1, 8453],
        description: "8453 = Base (default), 1 = Ethereum mainnet.",
      },
    },
    required: ["user"],
    additionalProperties: false,
  },
  example: { user: "0x0000000000000000000000000000000000000000", chainId: 8453 },
} as const;
