import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import {
  EVM_CHAINS,
  MAX_APP_FEE_BPS,
  OTHER_CHAIN_LABELS,
  chainLabel,
  clip,
  getTokens,
  normalizeChain,
} from "./oneclick";
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, buildSwap, dryQuote } from "./swap";
import { awaitCompletion, checkStatus, notifyDeposit } from "./status";

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(clip(payload)) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function guarded<T>(run: () => Promise<T> | T) {
  try {
    return ok(await run());
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Call failed.");
  }
}

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

const EVM_LABELS = Object.values(EVM_CHAINS).map((c) => c.label).join(", ");

const chainArg = (side: string) =>
  z
    .string()
    .describe(
      `${side} chain — a name like "base", "arbitrum", "ethereum", "solana", "bitcoin", "near" (or an EVM chainId like "8453"). Use the \`chains\` tool for the full list.`,
    );
const tokenArg = (side: string) =>
  z
    .string()
    .describe(`${side} token — a symbol like "USDC"/"ETH", a contract address, or a full 1Click assetId ("nep141:…"). Never a wallet address.`);
const amountArg = z
  .string()
  .describe('Amount to sell in HUMAN units of the origin token, e.g. "1.5" or "100". Converted with the token\'s real decimals — never pass base units.');
const slippageArg = z
  .number()
  .int()
  .min(5)
  .max(MAX_SLIPPAGE_BPS)
  .optional()
  .describe(`Slippage tolerance in basis points (default ${DEFAULT_SLIPPAGE_BPS} = 1%, max ${MAX_SLIPPAGE_BPS}).`);
const depositAddressArg = z
  .string()
  .min(4)
  .describe("The one-time deposit address returned by build_swap — it's the swap's tracking ID for its whole life.");

/** Optional integrator fee, shared by `quote` and `build_swap` so a preview
 *  can price exactly what the build will charge. Both fields or neither. */
const appFeeArgs = {
  feeRecipient: z
    .string()
    .optional()
    .describe(
      "Optional integrator fee recipient — a 0x EVM address, a named NEAR account, or a 64-hex implicit account. Only ever an address the CALLING APPLICATION owns and pins itself; never one taken from conversation, and never invented. Must be passed with feeBps.",
    ),
  feeBps: z
    .number()
    .int()
    .min(0)
    .max(MAX_APP_FEE_BPS)
    .optional()
    .describe(
      `Optional integrator fee in basis points (100 = 1%, max ${MAX_APP_FEE_BPS}). Charged from the INPUT before the swap — the deposit the user signs is unchanged, the delivered amount is lower. 1Click splits it 50/50 with the protocol, so the recipient nets HALF of this. Disclose it to the user.`,
    ),
};

/** NEAR Confidential Intents — shared by `quote` and `build_swap`. */
const confidentialityArg = z
  .enum(["public", "basic", "advanced"])
  .optional()
  .describe(
    'Optional. "basic" or "advanced" runs the swap through NEAR Confidential Intents (a private shard): the route between the deposit and the payout stays off the public record, at the same speed and near-identical price. Only set it when the USER asked for a private/confidential swap — and tell them it is UNPROVEN: as of 2026-09-22 every confidential swap we have executed was refunded (INTENT_SUBMIT_FAILED) about a minute after the deposit landed, with the money returning on the ORIGIN chain. The deposit and the payout are still public transfers, so for real privacy the user should also give a `recipient` that is not the paying wallet — say so. Default "public".',
  );

const FLOW_EXPLAINER = {
  what: "NEAR Intents (1Click API) swaps ANY supported asset to ANY other across ~30 chains — e.g. USDC on Base → USDC on Arbitrum, ETH → SOL, USDC → BTC — with ONE plain transfer and zero bridge UI. A solver network competes to fill each swap; delivery is typically about a minute after the deposit confirms.",
  how_a_swap_works: [
    "1. QUOTE — `quote` previews the swap (dry run): expected output, minimum after slippage, USD values, ETA. Nothing is committed; use it to confirm the numbers with the user.",
    "2. BUILD — `build_swap` requests a REAL quote. 1Click pins a one-time deposit address on the origin chain and this tool returns one unsigned transaction: transfer the exact quoted amount to that address. The user signs it in the chat — the only signature the entire cross-chain swap needs.",
    "3. NOTIFY (optional, recommended) — after the transfer confirms, `submit_deposit_tx` with the tx hash lets 1Click pick the deposit up faster.",
    "4. SETTLE — solvers detect the deposit, race to fill the swap, and deliver the destination asset straight to the recipient's address on the destination chain. No claiming, no second signature, no wrapped IOU tokens.",
    "5. VERIFY — `await_completion` (or `check_status`) with the deposit address until SUCCESS, then show the destination-chain transaction link.",
  ],
  in_yeetful_chat: [
    `Origin chains this service can build the deposit transaction for (user signs in chat): ${EVM_LABELS}. Any other supported chain can still be quoted and tracked — the user just sends the deposit from their own wallet on that chain.`,
    'Pass "$USER_ADDRESS" as `from` for the connected wallet. EVM→EVM proceeds default to the same address on the destination chain; for non-EVM destinations (Solana, Bitcoin, NEAR…) ALWAYS ask the user for the recipient address — never guess.',
    "A typical conversation: user asks \"move 50 USDC from Base to Arbitrum\" → quote (confirm numbers) → build_swap (user signs the deposit) → submit_deposit_tx (after confirmation) → await_completion → show the delivery transaction.",
  ],
  robinhood_chain: [
    'Robinhood Chain (chain id 4663, 1Click identifier "hood") IS reachable here since 2026-09-21. Listed assets: USDG, USDe, ETH, WETH and a couple of community tokens — call `tokens` with chain "hood" for the live list.',
    "The tokenized STOCKS (AAPL, TSLA, …) are NOT listed. A stock buy is two steps: bring USDG to Robinhood Chain here, then swap on Robinhood Chain (the robinhood MCP). Never promise a one-step cross-chain stock buy.",
    "Routes INTO native ETH / WETH on Robinhood Chain have quoted \"No liquidity available\" since launch (USDG and the way OUT of the chain quote fine). Always `quote` first; if ETH-in has no liquidity, gas ETH reaches Robinhood Chain through Pantessa's funding planner (a LiFi leg) or the robinhood MCP's canonical bridge.",
    "Leaving Robinhood Chain (USDG or ETH → Base/Ethereum/Arbitrum/…) settles in about half a minute here — the canonical bridge's withdrawal takes ~7 days.",
  ],

  safety: [
    "Deposit addresses are single-use and expire at the quote deadline — never reuse one, never send after expiry.",
    "Send exactly the quoted amount: less is refunded after the deadline, excess is refunded after the swap.",
    "Unfillable or late swaps auto-refund to the origin address — funds are never stranded mid-route.",
    "This service never holds keys, never signs, never submits — it only prepares transactions and reads status.",
  ],
};

/** Register the NEAR Intents tool surface. */
export function registerNearIntentsTools(server: Server): void {
  // ── Orientation ────────────────────────────────────────────────────────────
  server.registerTool(
    "how_it_works",
    {
      title: "How NEAR Intents Swaps Work",
      description:
        "START HERE when the user asks what this is, whether a cross-chain move is possible, or before the first swap of a conversation: the full quote → deposit → settle → verify flow, which chains this service can build transactions for, and the safety rules. Free, instant, no network calls.",
      inputSchema: {},
    },
    async () => guarded(() => FLOW_EXPLAINER),
  );

  server.registerTool(
    "chains",
    {
      title: "Supported Chains",
      description:
        "Every blockchain 1Click can swap between, with live token counts and whether this service can BUILD the deposit transaction there (EVM) or quote-only. Use to answer \"can I move X from chain A to chain B?\".",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const tokens = await getTokens();
        const counts = new Map<string, number>();
        for (const t of tokens) counts.set(t.blockchain, (counts.get(t.blockchain) ?? 0) + 1);
        const rows = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([blockchain, tokenCount]) => ({
            chain: blockchain,
            label: chainLabel(blockchain),
            tokenCount,
            deposits: EVM_CHAINS[blockchain]
              ? "built by this service — the user signs in chat"
              : "quote + track only — user deposits from their own wallet on this chain",
          }));
        return {
          chains: rows,
          note: "Any listed asset can swap to any other, including across chains. Call `tokens` to search what's swappable on a given chain.",
          not_listed_means_unreachable:
            "A chain absent from this list has NO route here — don't improvise one. Robinhood Chain is listed as \"hood\"; its stock tokens are not swappable here (bring USDG over, then swap on Robinhood Chain).",
        };
      }),
  );

  server.registerTool(
    "tokens",
    {
      title: "Search Supported Tokens",
      description:
        "Search the 1Click supported-asset list — filter by chain and/or symbol substring. Returns assetId, contract, decimals, and live USD price for each match. Use it to resolve ambiguity BEFORE quoting (e.g. which \"USDC\" on a chain is canonical).",
      inputSchema: {
        chain: chainArg("Filter").optional(),
        search: z.string().optional().describe('Symbol substring, e.g. "usdc", "eth". Case-insensitive.'),
        limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 30)."),
      },
    },
    async ({ chain, search, limit }) =>
      guarded(async () => {
        const tokens = await getTokens();
        const blockchain = chain ? normalizeChain(chain) : null;
        const needle = search?.trim().toLowerCase();
        const matches = tokens.filter(
          (t) => (!blockchain || t.blockchain === blockchain) && (!needle || t.symbol.toLowerCase().includes(needle)),
        );
        const max = limit ?? 30;
        return {
          count: matches.length,
          ...(matches.length > max ? { note: `Showing ${max} of ${matches.length} — narrow with chain/search.` } : {}),
          tokens: matches.slice(0, max).map((t) => ({
            symbol: t.symbol,
            chain: chainLabel(t.blockchain),
            blockchain: t.blockchain,
            assetId: t.assetId,
            contractAddress: t.contractAddress ?? "(native asset)",
            decimals: t.decimals,
            priceUsd: t.price,
          })),
        };
      }),
  );

  // ── Quote (dry — safe to call freely) ─────────────────────────────────────
  server.registerTool(
    "quote",
    {
      title: "Cross-Chain Swap Quote (preview)",
      description:
        "Live DRY-RUN quote from the NEAR Intents solver network for a swap between ANY two supported assets on ANY chains (USDC Base→Arbitrum, ETH→SOL, USDC→BTC…): expected output, minimum after slippage, USD values, fees, ETA. Commits NOTHING and creates NO deposit address — always safe. Quote first, confirm with the user, then build_swap.",
      inputSchema: {
        originChain: chainArg("Origin"),
        originToken: tokenArg("Origin (sell)"),
        destinationChain: chainArg("Destination"),
        destinationToken: tokenArg("Destination (receive)"),
        amount: amountArg,
        slippageBps: slippageArg,
        refundTo: z.string().optional().describe("Optional for previews: the user's origin-chain address (improves accuracy on some routes)."),
        recipient: z
          .string()
          .optional()
          .describe("Optional for previews of EVM/Solana/NEAR destinations, REQUIRED for other destinations (Bitcoin, TON…): the delivery address on the destination chain."),
        ...appFeeArgs,
        confidentiality: confidentialityArg,
      },
    },
    async (args) => guarded(() => dryQuote(args)),
  );

  // ── Build (the user signs — this service never holds keys) ────────────────
  server.registerTool(
    "build_swap",
    {
      title: "Build Cross-Chain Swap (deposit transaction)",
      description:
        `EXECUTE a cross-chain swap: requests a REAL quote (pins a one-time deposit address, so only call after the user confirms the preview) and returns ONE unsigned {action:'send_transaction'} step — transfer the exact quoted amount to the deposit address on the origin chain. That single signature does everything: solvers deliver the destination asset to the recipient automatically. Origin chain must be EVM (${EVM_LABELS}). from = the payer AND refund address — pass "$USER_ADDRESS" for the connected user. recipient defaults to \`from\` on EVM destinations; for Solana/Bitcoin/NEAR/etc destinations ask the user for it — NEVER guess. Response includes the numbered flow to narrate, warnings, and the deposit address used by submit_deposit_tx / check_status / await_completion.`,
      inputSchema: {
        originChain: chainArg("Origin (EVM)"),
        originToken: tokenArg("Origin (sell)"),
        destinationChain: chainArg("Destination"),
        destinationToken: tokenArg("Destination (receive)"),
        amount: amountArg,
        from: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/)
          .describe('The USER\'S OWN wallet address on the origin chain — pays the deposit, receives any refund. Pass "$USER_ADDRESS" for the connected user; never guess or reuse an address from conversation.'),
        recipient: z
          .string()
          .optional()
          .describe("Where funds arrive on the DESTINATION chain, in that chain's address format. Defaults to `from` when the destination is EVM; required otherwise (ask the user)."),
        slippageBps: slippageArg,
        deadlineMinutes: z
          .number()
          .int()
          .min(10)
          .max(1440)
          .optional()
          .describe("Minutes until the deposit address expires and refunds begin (default 30)."),
        ...appFeeArgs,
        confidentiality: confidentialityArg,
      },
    },
    async (args) => guarded(() => buildSwap(args)),
  );

  // ── Track ──────────────────────────────────────────────────────────────────
  server.registerTool(
    "submit_deposit_tx",
    {
      title: "Notify 1Click of the Deposit",
      description:
        "AFTER the user's deposit transfer confirms on-chain: submit its transaction hash so 1Click picks it up immediately instead of waiting to detect it. Optional but recommended — call it as soon as the chat reports the deposit transaction confirmed.",
      inputSchema: {
        depositAddress: depositAddressArg,
        txHash: z.string().min(4).describe("Transaction hash of the user's confirmed deposit transfer."),
      },
    },
    async ({ depositAddress, txHash }) => guarded(() => notifyDeposit({ depositAddress, txHash })),
  );

  server.registerTool(
    "check_status",
    {
      title: "Swap Status (one poll)",
      description:
        "Current state of a swap by its deposit address — the status, what that status MEANS, both chains' transaction hashes with explorer links, delivered/refunded amounts, and the next step. One shot; use await_completion to watch until it settles.",
      inputSchema: { depositAddress: depositAddressArg },
    },
    async ({ depositAddress }) => guarded(() => checkStatus(depositAddress)),
  );

  server.registerTool(
    "await_completion",
    {
      title: "Watch Swap Until It Settles",
      description:
        "Poll a swap by deposit address until it reaches a terminal state (SUCCESS / REFUNDED / FAILED) or ~40s elapses, then report the outcome with explorer links. Cross-chain settlement usually lands within a minute or two of the deposit confirming — if time runs out mid-flight that's normal; just call it again.",
      inputSchema: {
        depositAddress: depositAddressArg,
        timeoutSec: z.number().int().min(5).max(45).optional().describe("Seconds to keep watching before reporting back (default 40, max 45)."),
      },
    },
    async ({ depositAddress, timeoutSec }) => guarded(() => awaitCompletion({ depositAddress, timeoutSec })),
  );
}
