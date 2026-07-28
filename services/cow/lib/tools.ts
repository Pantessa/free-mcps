import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { apiGet, clip, CHAINS, SETTLEMENT_CONTRACT, VAULT_RELAYER, explorerOrderUrl, type CowResult } from "./cow";
import { chainOr400, isErr } from "./queries";
import * as q from "./queries";
import { guardApiGet, ALLOWED_PATH_EXAMPLES } from "./api-guard";
import { getDocPage, searchDocs } from "./docs";
import { knownSymbols } from "./tokens";

function present(result: CowResult) {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: `CoW order-book API error (HTTP ${result.status}): ${JSON.stringify(result.data)}`,
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(clip(result.data)) }] };
}

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(clip(payload)) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

// ── Shared arg schemas ───────────────────────────────────────────────────────

const CHAIN_ENUM = ["mainnet", "gnosis", "arbitrum", "base", "avalanche", "polygon", "bnb", "sepolia"] as const;

// The describe below has PROMISED these aliases since day one, but the bare
// z.enum rejected them — live 2026-07-28, a planner-routed build_swap_order
// with chain "ethereum" failed -32602 twice in one chat. Normalize case and
// map the aliases BEFORE the enum so the promise is real.
const CHAIN_ALIASES: Record<string, (typeof CHAIN_ENUM)[number]> = {
  ethereum: "mainnet",
  eth: "mainnet",
  xdai: "gnosis",
  arbitrum_one: "arbitrum",
  "arbitrum-one": "arbitrum",
  matic: "polygon",
  bsc: "bnb",
  binance: "bnb",
  avax: "avalanche",
};

export const chainValue = z.preprocess(
  (v) => (typeof v === "string" ? (CHAIN_ALIASES[v.toLowerCase()] ?? v.toLowerCase()) : v),
  z.enum(CHAIN_ENUM),
);

const chainArg = chainValue
  .optional()
  .describe('Chain (default "mainnet"). Aliases accepted: ethereum→mainnet, xdai→gnosis, arbitrum_one→arbitrum, matic→polygon, bsc→bnb, avax→avalanche.');

// The trading account. Yeetful's planner substitutes the connected user's
// wallet as $USER_ADDRESS — "my orders" / "swap my USDC" resolve to this.
const fromArg = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe(
    "EVM address (0x…) of the trading account — quotes are address-sensitive and the order is signed by this wallet. For the CONNECTED USER, pass their wallet address ($USER_ADDRESS).",
  );

const ownerArg = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe(
    "EVM address (0x…) of the account. For the CONNECTED USER's own orders/trades/portfolio, pass their wallet address ($USER_ADDRESS).",
  );

const tokenArg = (side: string) =>
  z.string().min(1).describe(`${side} token: a curated symbol (WETH, USDC, USDT, DAI, WBTC, COW, GNO, wxDAI, ARB, WAVAX, WPOL…, per chain) or any raw 0x address.`);

const decimalsArg = (side: string) =>
  z.number().int().min(0).max(36).optional().describe(`Decimals of the ${side} token — ONLY needed when passing a raw 0x address that is not in the curated map and an amount must be converted.`);

const receiverArg = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .optional()
  .describe("Optional recipient of the buy token (defaults to `from`).");

const uidArg = z
  .string()
  .regex(/^0x[a-fA-F0-9]{112}$/)
  .describe("The 56-byte order UID (0x…, 112 hex chars) from build/submit/user_orders.");

const appDataArg = z
  .string()
  .max(1000)
  .optional()
  .describe('Optional appData JSON string (≤1000 bytes), e.g. \'{"version":"1.3.0","appCode":"MyApp","metadata":{}}\'. Default: \'{"version":"1.3.0","metadata":{}}\'. The signed order carries keccak256 of this string.');

/** Register the CoW Protocol tool surface. */
export function registerCowTools(server: Server): void {
  // ── Discovery ──────────────────────────────────────────────────────────────
  server.registerTool(
    "chains",
    {
      title: "Supported Chains",
      description:
        "CoW Protocol deployments this service can reach: chain name, chainId, order-book base URL, settlement contract + GPv2VaultRelayer (SAME addresses on every chain), native currency, and the curated token symbols per chain.",
      inputSchema: {},
    },
    async () =>
      ok({
        settlementContract: SETTLEMENT_CONTRACT,
        vaultRelayer: `${VAULT_RELAYER} (approve sell tokens to THIS address, not the settlement contract)`,
        chains: Object.values(CHAINS).map((c) => ({
          chain: c.name,
          chainId: c.chainId,
          orderBookApi: `https://api.cow.fi/${c.network}/api/v1`,
          native: c.native,
          knownSymbols: knownSymbols(c.name),
        })),
      }),
  );

  // ── Pricing ────────────────────────────────────────────────────────────────
  server.registerTool(
    "quote",
    {
      title: "Swap Quote",
      description:
        'Price a swap on CoW Protocol (free, no commitment): kind "sell" = "swap 100 USDC for WETH" (amount = USDC to sell), kind "buy" = "buy exactly 0.05 WETH with USDC" (amount = WETH to receive). Returns human-readable sell/buy amounts, the network fee, and the raw quote. Quotes are address-sensitive — pass the user\'s wallet as `from` ($USER_ADDRESS).',
      inputSchema: {
        chain: chainArg,
        sellToken: tokenArg("Sell"),
        buyToken: tokenArg("Buy"),
        kind: z.enum(["sell", "buy"]).describe('"sell" = amount is how much you sell; "buy" = amount is how much you want to receive.'),
        amount: z.union([z.string(), z.number()]).describe("Amount in HUMAN units (e.g. 100 for 100 USDC, 0.5 for 0.5 WETH)."),
        from: fromArg,
        receiver: receiverArg,
        sellTokenDecimals: decimalsArg("sell"),
        buyTokenDecimals: decimalsArg("buy"),
      },
    },
    async (args) => present(await q.quote(args)),
  );

  // ── Order construction (client signs — this service never holds keys) ─────
  server.registerTool(
    "build_swap_order",
    {
      title: "Build Swap Order (EIP-712)",
      description:
        "Quote AND construct a ready-to-sign CoW swap order in one call. Returns the order, the full EIP-712 typed data {domain, types, primaryType:'Order', message} for the USER's wallet to sign (eth_signTypedData_v4), the vault-relayer approval prerequisite, and the appData JSON whose keccak256 the order carries. THE tool for 'swap 100 USDC to WETH'. This service NEVER signs — follow with submit_order once the user's wallet has signed.",
      inputSchema: {
        chain: chainArg,
        sellToken: tokenArg("Sell"),
        buyToken: tokenArg("Buy"),
        kind: z.enum(["sell", "buy"]).describe('"sell" = amount is how much you sell; "buy" = amount is how much you want to receive.'),
        amount: z.union([z.string(), z.number()]).describe("Amount in HUMAN units."),
        from: fromArg,
        receiver: receiverArg,
        slippageBps: z.number().int().min(0).max(5000).optional().describe("Slippage tolerance in basis points applied to the non-fixed side (default 50 = 0.5%)."),
        validFor: z.number().int().min(60).max(3600).optional().describe("Order validity in seconds from now (default 1800)."),
        partiallyFillable: z.boolean().optional().describe("Allow partial fills (default false = fill-or-kill)."),
        appData: appDataArg,
        sellTokenDecimals: decimalsArg("sell"),
        buyTokenDecimals: decimalsArg("buy"),
      },
    },
    async (args) => present(await q.buildSwapOrder(args)),
  );

  server.registerTool(
    "build_limit_order",
    {
      title: "Build Limit Order (EIP-712)",
      description:
        "Construct a ready-to-sign CoW LIMIT order from an explicit price: you state sellAmount AND buyAmount ('sell 1 WETH when it's worth at least 4000 USDC' → sellAmount 1, buyAmount 4000). Executes at your price OR BETTER, gasless, valid up to 1 year, optionally partially fillable. feeAmount is 0 — fees come out of surplus. Returns the same EIP-712 typed data + approval hint as build_swap_order; follow with submit_order after the user's wallet signs.",
      inputSchema: {
        chain: chainArg,
        sellToken: tokenArg("Sell"),
        buyToken: tokenArg("Buy"),
        sellAmount: z.union([z.string(), z.number()]).describe("Amount to sell, HUMAN units."),
        buyAmount: z.union([z.string(), z.number()]).describe("MINIMUM amount to receive, HUMAN units — this sets the limit price."),
        from: fromArg,
        receiver: receiverArg,
        validFor: z.number().int().min(60).max(365 * 24 * 3600).optional().describe("Validity in seconds from now (default 7 days, max 1 year)."),
        validTo: z.number().int().optional().describe("Absolute expiry, unix seconds (overrides validFor)."),
        partiallyFillable: z.boolean().optional().describe("Allow partial fills (default false)."),
        appData: appDataArg,
        sellTokenDecimals: decimalsArg("sell"),
        buyTokenDecimals: decimalsArg("buy"),
      },
    },
    async (args) => present(await q.buildLimitOrder(args)),
  );

  server.registerTool(
    "submit_order",
    {
      title: "Submit Signed Order",
      description:
        "POST an ALREADY-SIGNED order to the CoW order book and get back its orderUid + explorer link. Only call this with a signature produced by the USER's own wallet over the typedData from build_swap_order/build_limit_order — this service cannot and will not sign. Pass the `order` object from the build step unchanged, plus the signature.",
      inputSchema: {
        chain: chainArg,
        order: z
          .preprocess(
            (v) => {
              if (typeof v !== "string") return v;
              try {
                return JSON.parse(v);
              } catch {
                return v;
              }
            },
            z.record(z.unknown()),
          )
          .describe("The `order` object exactly as returned by build_swap_order/build_limit_order (object or JSON string)."),
        signature: z.string().regex(/^0x[a-fA-F0-9]*$/).describe("The user's wallet signature over the order's EIP-712 typed data."),
        from: fromArg,
        signingScheme: z.enum(["eip712", "ethsign", "eip1271", "presign"]).optional().describe("How the signature was produced (default eip712)."),
        fullAppData: z.string().max(1000).optional().describe("The fullAppData JSON from the build step (recommended — the order book registers it)."),
        quoteId: z.number().int().optional().describe("The quoteId from the build step (links order to quote for better analytics)."),
      },
    },
    async (args) => present(await q.submitOrder(args)),
  );

  server.registerTool(
    "cancel_orders",
    {
      title: "Cancel Orders (off-chain)",
      description:
        "Gasless order cancellation, two-phase: call WITHOUT `signature` to get the EIP-712 OrderCancellations typed data for the user's wallet to sign, then call again WITH the signature to submit the cancellation. Cancels up to 128 orders in one signature. (On-chain hard cancellation via invalidateOrder exists but costs gas and is out of scope here.)",
      inputSchema: {
        chain: chainArg,
        orderUids: z.array(z.string().regex(/^0x[a-fA-F0-9]{112}$/)).min(1).max(128).describe("Order UIDs to cancel."),
        signature: z.string().regex(/^0x[a-fA-F0-9]*$/).optional().describe("The user's signature over the OrderCancellations typed data (omit on the first call)."),
        signingScheme: z.enum(["eip712", "ethsign"]).optional(),
      },
    },
    async (args) => present(await q.cancelOrders(args)),
  );

  // ── Order/account reads (the $USER_ADDRESS surface) ────────────────────────
  server.registerTool(
    "order_status",
    {
      title: "Order Status",
      description:
        "One order by UID: status (open/fulfilled/cancelled/expired), fill percentage, executed amounts, pair, validity, and an explorer.cow.fi link. Answers 'did my swap go through?'.",
      inputSchema: { chain: chainArg, uid: uidArg },
    },
    async (args) => present(await q.orderStatus(args)),
  );

  server.registerTool(
    "user_orders",
    {
      title: "User Orders",
      description:
        "An address's CoW orders, newest first — open + recent, summarized (pair, kind, status, fill %, validity, uid, explorer link). Answers 'what orders do I have open?' ($USER_ADDRESS).",
      inputSchema: {
        chain: chainArg,
        owner: ownerArg,
        limit: z.number().int().min(1).max(100).optional().describe("How many to return (default 20, max 100)."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
      },
    },
    async (args) => present(await q.userOrders(args)),
  );

  server.registerTool(
    "user_trades",
    {
      title: "User Trades (fills)",
      description:
        "An address's executed CoW trades: pair, sell/buy amounts (atoms), settlement tx hash, block, explorer link. Newest first. Answers 'what did I trade?' ($USER_ADDRESS).",
      inputSchema: {
        chain: chainArg,
        owner: ownerArg,
        first: z.number().int().min(1).max(100).optional().describe("How many to return (default 20, max 100)."),
      },
    },
    async (args) => present(await q.userTrades(args)),
  );

  server.registerTool(
    "portfolio",
    {
      title: "CoW Portfolio",
      description:
        "CoW-centric account view for an address across chains: open orders (with fill %), recent fills, trade counts, and total traded volume per token — all derived from the order book (no on-chain balance calls). Default chains: mainnet, gnosis, arbitrum, base. THE tool for 'what's my CoW activity?' ($USER_ADDRESS).",
      inputSchema: {
        owner: ownerArg,
        chains: z
          .preprocess(
            (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v),
            z.array(chainValue).max(8).optional(),
          )
          .describe('Chains to scan, e.g. ["mainnet","base"] (or "mainnet,base"). Default: mainnet, gnosis, arbitrum, base.'),
      },
    },
    async (args) => present(await q.portfolio(args)),
  );

  // ── Market data ────────────────────────────────────────────────────────────
  server.registerTool(
    "native_price",
    {
      title: "Native Price",
      description:
        "The order book's price estimate for one token in the chain's native currency (ETH/xDAI/AVAX/POL/BNB) — the same price feed solvers use for fee math. Accepts a curated symbol or any 0x address.",
      inputSchema: { chain: chainArg, token: tokenArg("The") },
    },
    async (args) => present(await q.nativePrice(args)),
  );

  server.registerTool(
    "solver_competition",
    {
      title: "Solver Competition",
      description:
        "Which solvers bid on a settlement and who won: latest auction by default, or a specific settlement by its tx hash. Shows per-solver scores/ranking and the settlement tx hashes — CoW's MEV-protected batch auction, made visible.",
      inputSchema: {
        chain: chainArg,
        txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional().describe("Settlement transaction hash (omit for the latest auction)."),
      },
    },
    async (args) => present(await q.solverCompetition(args)),
  );

  // ── Escape hatch ───────────────────────────────────────────────────────────
  server.registerTool(
    "api_get",
    {
      title: "Raw API GET (read-only)",
      description: [
        "Escape hatch: GET any allowlisted CoW order-book path for data the other tools don't cover. Pass the path incl. the version prefix and query string.",
        `Allowed paths: ${ALLOWED_PATH_EXAMPLES.join(" · ")}.`,
        "Read-only by construction (GET only; order placement/cancellation are POST/DELETE and unreachable here). Responses truncated ~24k chars.",
      ].join("\n"),
      inputSchema: {
        chain: chainArg,
        path: z.string().min(1).max(700).describe('The versioned path + query, e.g. "/v1/trades?owner=0x…" or "/v2/solver_competition/latest".'),
      },
    },
    async ({ chain, path }) => {
      const c = chainOr400(chain);
      if (isErr(c)) return present(c);
      const guard = guardApiGet(path);
      if (!guard.ok) return fail(`Request rejected: ${guard.error}`);
      return present(await apiGet(c, guard.query ? `${guard.path}?${guard.query}` : guard.path));
    },
  );

  // ── Docs corpus ────────────────────────────────────────────────────────────
  server.registerTool(
    "docs_search",
    {
      title: "Search CoW Docs",
      description:
        "Search the official CoW Protocol documentation (docs.cow.fi, bundled offline) — protocol mechanics, batch auctions, solvers, MEV protection, order types (market/limit/TWAP/programmatic), fees, signing schemes, appData, CoW AMM, MEV Blocker, the COW token, and governance. Returns the top pages with snippets; fetch a full page with docs_page.",
      inputSchema: {
        query: z.string().min(2).max(200).describe('What to look up, e.g. "how are solvers ranked" or "limit order fees".'),
        first: z.number().int().min(1).max(10).optional().describe("Results to return (default 5)."),
      },
    },
    async ({ query, first }) => {
      const hits = await searchDocs(query, first ?? 5);
      if (hits.length === 0) return ok({ hits: [], note: "No pages matched. Try different terms — the corpus covers docs.cow.fi." });
      return ok({ hits, next: "Call docs_page with a hit's `path` for the full text." });
    },
  );

  server.registerTool(
    "docs_page",
    {
      title: "Read CoW Docs Page",
      description:
        "Fetch ONE page of the bundled CoW Protocol docs by its corpus path (from docs_search results), full text, clipped ~24k chars.",
      inputSchema: {
        path: z.string().min(1).max(300).describe('Corpus path from docs_search, e.g. "cow-protocol/reference/core/signing_schemes".'),
      },
    },
    async ({ path }) => {
      const page = await getDocPage(path);
      if (!page) return fail(`No docs page at "${path}". Use docs_search to find valid paths.`);
      return ok({ path: page.path, title: page.title, source: `https://docs.cow.fi/${page.path}`, text: page.text });
    },
  );
}

// JSON Schema for the PRIMARY tool, used in the Bazaar discovery extension.
// Kept in sync with `build_swap_order` above (this is what the validator reads).
export const PRIMARY_TOOL = {
  name: "build_swap_order",
  description:
    "Quote + construct a ready-to-sign CoW Protocol swap order (EIP-712 typed data the USER's wallet signs — the service never holds keys). Other tools: chains, quote, build_limit_order, submit_order, cancel_orders, order_status, user_orders, user_trades, portfolio, native_price, solver_competition, api_get (read-only escape hatch), docs_search + docs_page (official CoW docs, bundled).",
  inputSchema: {
    type: "object",
    properties: {
      chain: { type: "string", description: "mainnet | gnosis | arbitrum | base | avalanche | polygon | bnb | sepolia" },
      sellToken: { type: "string", description: "Symbol (USDC, WETH…) or 0x address" },
      buyToken: { type: "string", description: "Symbol or 0x address" },
      kind: { type: "string", enum: ["sell", "buy"] },
      amount: { type: "string", description: "Human units" },
      from: { type: "string", description: "Trading account — $USER_ADDRESS for the connected user" },
    },
    required: ["sellToken", "buyToken", "kind", "amount", "from"],
    additionalProperties: false,
  },
  example: { sellToken: "USDC", buyToken: "WETH", kind: "sell", amount: "100", from: "0x0000000000000000000000000000000000000001" },
} as const;

// Re-export the explorer helper for the smoke script.
export { explorerOrderUrl };
