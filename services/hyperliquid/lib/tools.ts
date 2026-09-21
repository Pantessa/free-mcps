import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { queries, infoRequest, clip, type HlResult } from "./hyperliquid";
import { guardInfoRequest, ALLOWED_INFO_TYPES } from "./info-guard";
import { awaitSettlement } from "./watch";

function present(result: HlResult) {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Hyperliquid API error (HTTP ${result.status}): ${JSON.stringify(result.data)}`,
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

// The account address. Yeetful's planner substitutes the connected user's
// wallet as $USER_ADDRESS — "my positions" / "my fills" resolve to this.
const userArg = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe(
    "EVM address (0x…) of the Hyperliquid account. For the CONNECTED USER's own portfolio/orders/fills, pass their wallet address ($USER_ADDRESS).",
  );

// Planners pass coins as an array OR a comma-separated string — accept both.
const coinsArg = z
  .preprocess(
    (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v),
    z.array(z.string()).max(50).optional(),
  )
  .describe('Coin filter, e.g. ["BTC","ETH"] (or "BTC,ETH"). Spot pairs like "PURR/USDC" or bare "PURR" also resolve.');

const firstArg = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("How many to return (default ~20, max 100).");

// Order id: numeric oid, "12345" as a string, or a 0x… cloid.
const oidArg = z
  .preprocess(
    (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v),
    z.union([z.number().int().positive(), z.string().regex(/^0x[0-9a-fA-F]{32}$/)]),
  )
  .describe("Order id: the numeric oid from open_orders/fills, or the 0x… cloid (client order id).");

const INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"] as const;

/** Register the Hyperliquid market + portfolio tool surface. */
export function registerHyperliquidTools(server: Server): void {
  // ── Market data ────────────────────────────────────────────────────────────
  server.registerTool(
    "markets",
    {
      title: "Perp Markets",
      description:
        "Hyperliquid perpetual markets: mark/mid/oracle price, 24h change + volume, open interest (USD), hourly + annualized funding, max leverage. Default = top markets by 24h volume; pass `coins` for specific ones. Answers 'what's trading on Hyperliquid' / 'BTC funding rate'.",
      inputSchema: { coins: coinsArg, first: firstArg },
    },
    async ({ coins, first }) => present(await queries.perpMarkets({ coins, first })),
  );

  server.registerTool(
    "spot_markets",
    {
      title: "Spot Markets",
      description:
        "Hyperliquid spot pairs (HYPE/USDC, PURR/USDC, …): mark/mid price, 24h change + volume. Native '@N' pair names are resolved to token names; the returned `nativeName` is what orderbook/candles/await_settlement expect for spot coins.",
      inputSchema: { coins: coinsArg, first: firstArg },
    },
    async ({ coins, first }) => present(await queries.spotMarkets({ coins, first })),
  );

  server.registerTool(
    "price",
    {
      title: "Live Prices",
      description:
        "Live mid prices. With `coins`, resolves perp names (BTC) and spot aliases (PURR, HYPE/USDC) in one call — the cheapest way to answer 'what's ETH at?'. Without `coins`, returns all perp mids.",
      inputSchema: { coins: coinsArg },
    },
    async ({ coins }) => present(await queries.prices({ coins })),
  );

  server.registerTool(
    "orderbook",
    {
      title: "Orderbook (L2)",
      description:
        "L2 orderbook for one coin (perp or spot): best bid/ask, mid, spread %, and up to 20 aggregated levels per side.",
      inputSchema: {
        coin: z.string().min(1).describe('Coin: perp name ("ETH") or spot pair ("HYPE/USDC", "@107").'),
        depth: z.number().int().min(1).max(20).optional().describe("Levels per side (default 10, max 20)."),
        nSigFigs: z
          .number()
          .int()
          .min(2)
          .max(5)
          .optional()
          .describe("Aggregate price levels to N significant figures (2–5; omit for full precision)."),
      },
    },
    async ({ coin, depth, nSigFigs }) => present(await queries.orderbook({ coin, depth, nSigFigs })),
  );

  server.registerTool(
    "candles",
    {
      title: "Candles (OHLCV)",
      description:
        "OHLCV candle history for one coin (perp or spot). Choose an `interval` and either `hoursBack` (default 24) or explicit startTime/endTime (ms). Keep interval × window sane — the response is capped.",
      inputSchema: {
        coin: z.string().min(1).describe('Coin: perp name ("BTC") or spot pair ("HYPE/USDC").'),
        interval: z.enum(INTERVALS).describe("Candle interval."),
        hoursBack: z.number().min(0.1).max(24 * 90).optional().describe("Lookback window in hours (default 24)."),
        startTime: z.number().int().optional().describe("Window start, ms since epoch (overrides hoursBack)."),
        endTime: z.number().int().optional().describe("Window end, ms since epoch (default now)."),
      },
    },
    async ({ coin, interval, hoursBack, startTime, endTime }) =>
      present(await queries.candles({ coin, interval, hoursBack, startTime, endTime })),
  );

  server.registerTool(
    "funding",
    {
      title: "Funding Rates",
      description:
        "Funding for one perp: recent hourly funding history plus the PREDICTED next rate on Hyperliquid vs Binance/Bybit (cross-venue basis). Rates are hourly fractions — ×24×365 for APR.",
      inputSchema: {
        coin: z.string().min(1).describe('Perp coin name, e.g. "ETH".'),
        hoursBack: z.number().min(1).max(24 * 30).optional().describe("History window in hours (default 24)."),
      },
    },
    async ({ coin, hoursBack }) => present(await queries.funding({ coin, hoursBack })),
  );

  // ── Account / portfolio (the $USER_ADDRESS surface) ────────────────────────
  server.registerTool(
    "portfolio",
    {
      title: "Account Portfolio",
      description:
        "Full Hyperliquid account view for an address: perp positions (size, entry, liquidation px, unrealized PnL, leverage), margin + collateral, spot balances, and day/week/month/all-time PnL. THE tool for 'what are my positions' / 'how is my account doing'. For 'how much can I trade with', read `perp.availableToTradeUsd`, NOT `perp.withdrawableUsd`: on a unified account (`accountMode` = \"unifiedAccount\", also portfolio margin) collateral lives in spot USDC and `withdrawableUsd` reads ~0 while the account is fully funded.",
      inputSchema: { user: userArg },
    },
    async ({ user }) => present(await queries.portfolio({ user })),
  );

  server.registerTool(
    "open_orders",
    {
      title: "Open Orders",
      description:
        "An address's resting orders with full detail: side, size, limit price, order type, trigger/TP-SL info, reduce-only flag, oid + cloid. Answers 'what orders do I have open?'.",
      inputSchema: { user: userArg },
    },
    async ({ user }) => present(await queries.openOrders({ user })),
  );

  server.registerTool(
    "fills",
    {
      title: "Trade Fills",
      description:
        "An address's executed trades (fills): price, size, side, direction (Open Long / Close Short…), closed PnL, fee, oid, tx hash. Most recent first; optionally time-bounded. Answers 'what did I trade today?' / 'did my order execute?'.",
      inputSchema: {
        user: userArg,
        startTime: z.number().int().optional().describe("Only fills at/after this ms timestamp."),
        endTime: z.number().int().optional().describe("Only fills at/before this ms timestamp."),
        first: firstArg,
      },
    },
    async ({ user, startTime, endTime, first }) =>
      present(await queries.fills({ user, startTime, endTime, first })),
  );

  server.registerTool(
    "order_status",
    {
      title: "Order Status",
      description:
        "Status of ONE order by oid or cloid: open / filled / canceled / rejected (+ the order's details and status timestamp). For live 'tell me when it settles', use await_settlement instead.",
      inputSchema: { user: userArg, oid: oidArg },
    },
    async ({ user, oid }) => present(await queries.orderStatus({ user, oid })),
  );

  server.registerTool(
    "ledger",
    {
      title: "USDC Ledger",
      description:
        "An address's USDC ledger: `kind=funding` for funding payments paid/received per position, `kind=transfers` for deposits, withdrawals, transfers and liquidations. Defaults to the last 7 days.",
      inputSchema: {
        user: userArg,
        kind: z.enum(["funding", "transfers"]).describe("funding = funding payments; transfers = deposits/withdrawals/transfers/liquidations."),
        startTime: z.number().int().optional().describe("Window start, ms since epoch (default 7 days ago)."),
        endTime: z.number().int().optional().describe("Window end, ms since epoch (default now)."),
      },
    },
    async ({ user, kind, startTime, endTime }) =>
      present(await queries.ledger({ user, kind, startTime, endTime })),
  );

  // ── Real-time settlement (WebSocket) ───────────────────────────────────────
  server.registerTool(
    "await_settlement",
    {
      title: "Await Settlement (live)",
      description:
        "BLOCK until an order settles, then report it — the real-time 'did it go through?' tool. Subscribes to the address's fills + order updates over Hyperliquid's WebSocket and returns as soon as a matching fill or terminal order status (filled/canceled/rejected) lands, or after `timeoutSeconds` (default 30, max 45). With `oid` it watches that order (checking first whether it ALREADY settled); with just `coin` or nothing it resolves on the address's next fill. On timeout the order may simply still be resting — check open_orders or call again.",
      inputSchema: {
        user: userArg,
        oid: oidArg.optional(),
        coin: z.string().optional().describe("Only settle on events for this coin (perp name or spot nativeName)."),
        timeoutSeconds: z.number().min(1).max(45).optional().describe("Max seconds to wait (default 30, max 45)."),
      },
    },
    async ({ user, oid, coin, timeoutSeconds }) => {
      const result = await awaitSettlement({ user, oid, coin, timeoutSeconds });
      return result.outcome === "error" ? fail(result.note) : ok(result);
    },
  );

  // ── Escape hatch ───────────────────────────────────────────────────────────
  // The curated tools cover the common intents; this exposes the FULL public
  // read surface (vaults, staking, fees, sub-accounts, TWAP fills…) so new
  // intents don't each need a new tool. READ-ONLY by construction — it only
  // ever POSTs to /info (trading lives on /exchange, which this service never
  // touches, and there is nothing signable here).
  server.registerTool(
    "info_query",
    {
      title: "Raw Info Query (read-only)",
      description: [
        "Escape hatch: run any READ-ONLY Hyperliquid /info request for data the other tools don't cover. Pass the JSON body, e.g. {\"type\":\"userFees\",\"user\":\"0x…\"} or {\"type\":\"vaultDetails\",\"vaultAddress\":\"0x…\"}.",
        `Allowed types: ${[...ALLOWED_INFO_TYPES].join(", ")}.`,
        "Timestamps are ms since epoch; prices/sizes are strings; user-data types take `user` (an address — $USER_ADDRESS for the connected user). Responses truncated ~24k chars.",
      ].join("\n"),
      inputSchema: {
        request: z
          .preprocess(
            // Planners often pass the body as a JSON string — accept both.
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
          .describe('The /info request body as an object (or JSON string), e.g. {"type":"userFees","user":"0x…"}.'),
      },
    },
    async ({ request }) => {
      const guard = guardInfoRequest(request);
      if (!guard.ok) return fail(`Request rejected: ${guard.error}`);
      return present(await infoRequest(request as Record<string, unknown>));
    },
  );
}

// JSON Schema for the PRIMARY tool, used in the Bazaar discovery extension.
// Kept in sync with `portfolio` above (this is what the validator reads).
export const PRIMARY_TOOL = {
  name: "portfolio",
  description:
    "Full Hyperliquid account view for an address: perp positions, margin, spot balances, PnL. Other tools: markets, spot_markets, price, orderbook, candles, funding, open_orders, fills, order_status, ledger, await_settlement (live WebSocket settlement watch), info_query (read-only escape hatch).",
  inputSchema: {
    type: "object",
    properties: {
      user: {
        type: "string",
        description: "EVM address (0x…) of the Hyperliquid account — $USER_ADDRESS for the connected user.",
      },
    },
    required: ["user"],
    additionalProperties: false,
  },
  example: { user: "0x0000000000000000000000000000000000000000" },
} as const;
