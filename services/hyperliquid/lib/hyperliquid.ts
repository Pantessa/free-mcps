// Hyperliquid public API client. app.hyperliquid.xyz is the app;
// api.hyperliquid.xyz is the API — a single free, public POST endpoint
// (`/info`, body `{"type": ...}`), NO auth required. Rate limits are per-IP
// and weight-based (1200/min; l2Book/allMids/clearinghouseState weigh 2, the
// meta + history types weigh 20 — hence the meta caches below).
//
// We call the HTTP API directly (same ethos as the snapshot sibling — raw
// fetch, zero SDK deps); the tool surface and request-type coverage are
// modeled on @nktkas/hyperliquid, the best-maintained TS SDK.

const API_URL = () => process.env.HYPERLIQUID_API_URL ?? "https://api.hyperliquid.xyz";
export const WS_URL = () => process.env.HYPERLIQUID_WS_URL ?? "wss://api.hyperliquid.xyz/ws";

// Cap payloads returned through MCP so a huge response can't blow up the
// agent's context. Clipping happens at the TOOL layer (after shaping) — the
// raw meta responses legitimately exceed this and are consumed internally.
const MAX_RESPONSE_CHARS = 24_000;

// Injectable seam for tests — production passes nothing (global fetch).
export interface HlOpts {
  fetchImpl?: typeof fetch;
}

export interface HlResult {
  ok: boolean;
  status: number;
  data: unknown;
}

/** Clip an already-shaped payload to the MCP size budget. */
export function clip(data: unknown): unknown {
  if (typeof data === "string") return data;
  const serialized = JSON.stringify(data);
  if (serialized.length <= MAX_RESPONSE_CHARS) return data;
  return {
    note: `Response truncated to ~${MAX_RESPONSE_CHARS} chars — narrow your filters (fewer coins, lower first/depth, shorter time window). \`preview\` is a raw (clipped) JSON string.`,
    preview: serialized.slice(0, MAX_RESPONSE_CHARS),
  };
}

/** POST a request to the Hyperliquid `/info` endpoint. No auth, no key. */
export async function infoRequest(
  body: Record<string, unknown>,
  opts?: HlOpts,
): Promise<HlResult> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const res = await doFetch(`${API_URL()}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, data: parsed };
}

// ── API shapes (fields verified against the live API, 2026-07-06) ───────────

export interface PerpAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
}
export interface PerpCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs: string[] | null;
}
export interface SpotToken {
  name: string;
  index: number;
  szDecimals?: number;
  tokenId?: string;
  isCanonical?: boolean;
}
export interface SpotPair {
  name: string; // "PURR/USDC" (canonical) or "@12"
  tokens: [number, number];
  index: number;
  isCanonical?: boolean;
}
export interface SpotCtx {
  coin: string; // native pair name, "@12" style
  markPx: string;
  midPx: string | null;
  prevDayPx: string;
  dayNtlVlm: string;
  circulatingSupply?: string;
}

const num = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const pctChange24h = (now: string | null | undefined, prev: string | null | undefined): number | null => {
  const a = num(now);
  const b = num(prev);
  if (a === null || b === null || b === 0) return null;
  return Math.round(((a - b) / b) * 10_000) / 100;
};

export const isEvmAddress = (s: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(s);

// ── Meta caches ──────────────────────────────────────────────────────────────
// metaAndAssetCtxs / spotMetaAndAssetCtxs weigh 20 of the 1200/min budget and
// the meta half changes only when assets (de)list — cache per instance.

const META_TTL_MS = 5 * 60_000;

/** Test seam: drop the per-instance meta caches. */
export function clearMetaCaches(): void {
  perpCache = null;
  spotCache = null;
}

interface PerpMetaCache {
  at: number;
  universe: PerpAsset[];
  ctxs: PerpCtx[];
}
let perpCache: PerpMetaCache | null = null;

async function perpMetaAndCtxs(opts?: HlOpts): Promise<PerpMetaCache | HlResult> {
  if (perpCache && Date.now() - perpCache.at < META_TTL_MS) return perpCache;
  const r = await infoRequest({ type: "metaAndAssetCtxs" }, opts);
  if (!r.ok) return r;
  const [meta, ctxs] = r.data as [{ universe: PerpAsset[] }, PerpCtx[]];
  if (!meta?.universe || !Array.isArray(ctxs)) {
    return { ok: false, status: 502, data: "unexpected metaAndAssetCtxs shape" };
  }
  perpCache = { at: Date.now(), universe: meta.universe, ctxs };
  return perpCache;
}

export interface SpotMaps {
  /** native pair name ("@N" or "PURR/USDC") → display name "TOKEN/USDC" */
  displayByPair: Map<string, string>;
  /** UPPERCASED display name AND bare token name → native pair name */
  pairByAlias: Map<string, string>;
}

interface SpotMetaCache {
  at: number;
  universe: SpotPair[];
  tokens: SpotToken[];
  ctxs: SpotCtx[];
  maps: SpotMaps;
}
let spotCache: SpotMetaCache | null = null;

export function buildSpotMaps(universe: SpotPair[], tokens: SpotToken[]): SpotMaps {
  const displayByPair = new Map<string, string>();
  const pairByAlias = new Map<string, string>();
  for (const pair of universe) {
    const base = tokens[pair.tokens[0]]?.name ?? pair.name;
    const quote = tokens[pair.tokens[1]]?.name ?? "USDC";
    const display = pair.name.includes("/") ? pair.name : `${base}/${quote}`;
    displayByPair.set(pair.name, display);
    pairByAlias.set(display.toUpperCase(), pair.name);
    // Bare token alias ("PURR" → its USDC pair) — first pair wins.
    const bare = base.toUpperCase();
    if (!pairByAlias.has(bare)) pairByAlias.set(bare, pair.name);
  }
  return { displayByPair, pairByAlias };
}

async function spotMetaAndCtxs(opts?: HlOpts): Promise<SpotMetaCache | HlResult> {
  if (spotCache && Date.now() - spotCache.at < META_TTL_MS) return spotCache;
  const r = await infoRequest({ type: "spotMetaAndAssetCtxs" }, opts);
  if (!r.ok) return r;
  const [meta, ctxs] = r.data as [{ universe: SpotPair[]; tokens: SpotToken[] }, SpotCtx[]];
  if (!meta?.universe || !meta?.tokens || !Array.isArray(ctxs)) {
    return { ok: false, status: 502, data: "unexpected spotMetaAndAssetCtxs shape" };
  }
  spotCache = {
    at: Date.now(),
    universe: meta.universe,
    tokens: meta.tokens,
    ctxs,
    maps: buildSpotMaps(meta.universe, meta.tokens),
  };
  return spotCache;
}

const isErr = (v: unknown): v is HlResult =>
  typeof v === "object" && v !== null && "ok" in v && (v as HlResult).ok === false;

/**
 * Resolve a human coin name to what the API expects:
 * - perp names pass through ("BTC", "ETH" — case-normalized)
 * - spot pairs/tokens resolve to the native "@N" name ("PURR", "HYPE/USDC")
 * Returns the resolved coin + whether it's spot, or null if unknown.
 */
export async function resolveCoin(
  coin: string,
  opts?: HlOpts,
): Promise<{ coin: string; display: string; kind: "perp" | "spot" } | null> {
  const upper = coin.trim().toUpperCase();
  const looksSpot = upper.includes("/") || upper.startsWith("@");
  if (!looksSpot) {
    const perps = await perpMetaAndCtxs(opts);
    if (!isErr(perps) && (perps as PerpMetaCache).universe.some((a) => a.name.toUpperCase() === upper)) {
      const exact = (perps as PerpMetaCache).universe.find((a) => a.name.toUpperCase() === upper)!;
      return { coin: exact.name, display: exact.name, kind: "perp" };
    }
  }
  const spot = await spotMetaAndCtxs(opts);
  if (isErr(spot)) return looksSpot ? null : { coin: coin.trim(), display: coin.trim(), kind: "perp" };
  const s = spot as SpotMetaCache;
  // Native names ("@12", "PURR/USDC") pass through; aliases resolve.
  const native = s.maps.displayByPair.has(upper) ? upper : (s.maps.pairByAlias.get(upper) ?? null);
  if (native) {
    return { coin: native, display: s.maps.displayByPair.get(native) ?? native, kind: "spot" };
  }
  return null;
}

// ── Account collateral ──────────────────────────────────────────────────────
//
// `clearinghouseState.withdrawable` is NOT an account's tradable collateral.
// On a unified account (`userAbstraction` = "unifiedAccount"; portfolio margin
// behaves the same) the venue keeps collateral in SPOT USDC and sweeps the perp
// ledger down to the margin in use, so that field reads ~$0 — or a stale figure
// between sweeps — for a fully funded account. Measured 2026-09-21 on a live
// unified wallet: withdrawable "0.0" while $122 of free spot USDC backed an
// open $385 position. Classic accounts return "default" and are unaffected.

/** Free spot USDC (total − hold) from a `spotClearinghouseState` payload. */
export function freeSpotUsdc(spotState: unknown): number | null {
  const balances = (spotState as { balances?: { coin?: string; total?: string; hold?: string }[] } | null)?.balances;
  const usdc = (balances ?? []).find((b) => b?.coin === "USDC");
  if (!usdc) return null;
  const free = Number(usdc.total) - Number(usdc.hold ?? 0);
  return Number.isFinite(free) ? free : null;
}

/** Account modes in which spot USDC backs perp margin. */
export function spotBacksPerps(accountMode: string | null | undefined): boolean {
  return accountMode === "unifiedAccount" || accountMode === "portfolioMargin";
}

/** The collateral a trade can actually draw on: the best finite figure of the
 *  perp ledger's `withdrawable` and — only when the mode lets spot back perps
 *  — free spot USDC. Never less than `withdrawable`. */
export function availableToTradeUsd(input: {
  perpWithdrawable?: string | number | null;
  accountMode?: string | null;
  spotUsdcFree?: number | null;
}): number {
  const candidates = [Number(input.perpWithdrawable)];
  if (spotBacksPerps(input.accountMode)) candidates.push(Number(input.spotUsdcFree));
  return Math.max(0, ...candidates.filter((n) => Number.isFinite(n)));
}

/** Money as the venue writes it: up to 6 decimals, no trailing zeros. */
function fmtUsd(n: number): string {
  return String(Number(n.toFixed(6)));
}

// ── Typed query wrappers (the curated tool surface) ─────────────────────────

export const queries = {
  /** Perp markets merged from universe + asset ctxs, sorted by 24h volume. */
  perpMarkets: async (
    args: { coins?: string[]; first?: number },
    opts?: HlOpts,
  ): Promise<HlResult> => {
    const r = await perpMetaAndCtxs(opts);
    if (isErr(r)) return r;
    const { universe, ctxs } = r as PerpMetaCache;
    const wanted = args.coins?.map((c) => c.toUpperCase());
    let markets = universe
      .map((asset, i) => ({ asset, ctx: ctxs[i] }))
      .filter(({ asset }) => !asset.isDelisted)
      .filter(({ asset }) => !wanted || wanted.includes(asset.name.toUpperCase()))
      .map(({ asset, ctx }) => ({
        coin: asset.name,
        markPx: ctx?.markPx ?? null,
        midPx: ctx?.midPx ?? null,
        oraclePx: ctx?.oraclePx ?? null,
        change24hPct: pctChange24h(ctx?.markPx, ctx?.prevDayPx),
        volume24hUsd: num(ctx?.dayNtlVlm),
        openInterestUsd:
          num(ctx?.openInterest) !== null && num(ctx?.markPx) !== null
            ? Math.round(num(ctx!.openInterest)! * num(ctx!.markPx)! * 100) / 100
            : null,
        fundingHourly: ctx?.funding ?? null,
        fundingAnnualizedPct:
          num(ctx?.funding) !== null ? Math.round(num(ctx!.funding)! * 24 * 365 * 10_000) / 100 : null,
        maxLeverage: asset.maxLeverage,
        szDecimals: asset.szDecimals,
      }));
    markets.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
    const unknown = wanted?.filter((w) => !markets.some((m) => m.coin.toUpperCase() === w));
    if (!wanted) markets = markets.slice(0, Math.min(args.first ?? 20, 100));
    return {
      ok: true,
      status: 200,
      data: {
        markets,
        ...(unknown && unknown.length > 0
          ? { note: `Not found as perps: ${unknown.join(", ")} — spot pairs live in spot_markets.` }
          : {}),
      },
    };
  },

  /** Spot markets with "@N" pairs resolved to TOKEN/USDC names. */
  spotMarkets: async (
    args: { coins?: string[]; first?: number },
    opts?: HlOpts,
  ): Promise<HlResult> => {
    const r = await spotMetaAndCtxs(opts);
    if (isErr(r)) return r;
    const s = r as SpotMetaCache;
    const ctxByPair = new Map(s.ctxs.map((c) => [c.coin, c]));
    const wanted = args.coins?.map((c) => {
      const upper = c.toUpperCase();
      return s.maps.pairByAlias.get(upper) ?? upper;
    });
    let markets = s.universe
      .filter((pair) => !wanted || wanted.includes(pair.name))
      .map((pair) => {
        const ctx = ctxByPair.get(pair.name);
        return {
          pair: s.maps.displayByPair.get(pair.name) ?? pair.name,
          nativeName: pair.name, // what l2Book/candles/watch expect for spot
          markPx: ctx?.markPx ?? null,
          midPx: ctx?.midPx ?? null,
          change24hPct: pctChange24h(ctx?.markPx, ctx?.prevDayPx),
          volume24hUsd: num(ctx?.dayNtlVlm),
          circulatingSupply: ctx?.circulatingSupply ?? null,
        };
      });
    markets.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
    if (!wanted) markets = markets.slice(0, Math.min(args.first ?? 20, 100));
    return { ok: true, status: 200, data: { markets } };
  },

  /** Mid prices — all coins or a filtered set (perp names + spot aliases). */
  prices: async (args: { coins?: string[] }, opts?: HlOpts): Promise<HlResult> => {
    const r = await infoRequest({ type: "allMids" }, opts);
    if (!r.ok) return r;
    const mids = r.data as Record<string, string>;
    if (!args.coins || args.coins.length === 0) {
      // Unfiltered: perp mids only (spot "@N" keys are noise without names).
      const perpsOnly = Object.fromEntries(
        Object.entries(mids).filter(([k]) => !k.startsWith("@") && !k.startsWith("#")),
      );
      return { ok: true, status: 200, data: { mids: perpsOnly, note: "Perp mids. For spot prices pass coins or use spot_markets." } };
    }
    const out: Record<string, string | null> = {};
    for (const c of args.coins) {
      const resolved = await resolveCoin(c, opts);
      if (!resolved) {
        out[c] = null;
        continue;
      }
      out[resolved.display] = mids[resolved.coin] ?? null;
    }
    return { ok: true, status: 200, data: { mids: out } };
  },

  /** L2 orderbook with best-bid/ask summary, depth-trimmed. */
  orderbook: async (
    args: { coin: string; depth?: number; nSigFigs?: number },
    opts?: HlOpts,
  ): Promise<HlResult> => {
    const resolved = await resolveCoin(args.coin, opts);
    if (!resolved) return { ok: false, status: 404, data: `Unknown coin: ${args.coin}` };
    const body: Record<string, unknown> = { type: "l2Book", coin: resolved.coin };
    if (args.nSigFigs) body.nSigFigs = args.nSigFigs;
    const r = await infoRequest(body, opts);
    if (!r.ok) return r;
    const book = r.data as { coin: string; time: number; levels: [{ px: string; sz: string; n: number }[], { px: string; sz: string; n: number }[]] };
    const depth = Math.min(Math.max(args.depth ?? 10, 1), 20);
    const [bids, asks] = book.levels ?? [[], []];
    const bestBid = num(bids[0]?.px);
    const bestAsk = num(asks[0]?.px);
    return {
      ok: true,
      status: 200,
      data: {
        coin: resolved.display,
        kind: resolved.kind,
        time: book.time,
        bestBid: bids[0]?.px ?? null,
        bestAsk: asks[0]?.px ?? null,
        mid: bestBid !== null && bestAsk !== null ? String((bestBid + bestAsk) / 2) : null,
        spreadPct:
          bestBid !== null && bestAsk !== null && bestBid > 0
            ? Math.round(((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 1_000_000) / 10_000
            : null,
        bids: bids.slice(0, depth),
        asks: asks.slice(0, depth),
      },
    };
  },

  /** OHLCV candles. Note the API wants a nested `req` object. */
  candles: async (
    args: { coin: string; interval: string; hoursBack?: number; startTime?: number; endTime?: number },
    opts?: HlOpts,
  ): Promise<HlResult> => {
    const resolved = await resolveCoin(args.coin, opts);
    if (!resolved) return { ok: false, status: 404, data: `Unknown coin: ${args.coin}` };
    const endTime = args.endTime ?? Date.now();
    const startTime = args.startTime ?? endTime - (args.hoursBack ?? 24) * 3_600_000;
    const r = await infoRequest(
      { type: "candleSnapshot", req: { coin: resolved.coin, interval: args.interval, startTime, endTime } },
      opts,
    );
    if (!r.ok) return r;
    const raw = (r.data as { t: number; o: string; h: string; l: string; c: string; v: string; n: number }[]) ?? [];
    return {
      ok: true,
      status: 200,
      data: {
        coin: resolved.display,
        interval: args.interval,
        candles: raw.map((k) => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, trades: k.n })),
      },
    };
  },

  /** Funding for one perp: current + predicted (cross-venue) + recent history. */
  funding: async (
    args: { coin: string; hoursBack?: number },
    opts?: HlOpts,
  ): Promise<HlResult> => {
    const upper = args.coin.trim().toUpperCase();
    const endTime = Date.now();
    const startTime = endTime - (args.hoursBack ?? 24) * 3_600_000;
    const [history, predicted] = await Promise.all([
      infoRequest({ type: "fundingHistory", coin: upper, startTime, endTime }, opts),
      infoRequest({ type: "predictedFundings" }, opts),
    ]);
    if (!history.ok) return history;
    const predictedForCoin = predicted.ok
      ? ((predicted.data as [string, [string, { fundingRate: string; nextFundingTime: number } | null][]][]) ?? []).find(
          ([coin]) => coin.toUpperCase() === upper,
        )?.[1] ?? null
      : null;
    return {
      ok: true,
      status: 200,
      data: {
        coin: upper,
        fundingIsHourly: true,
        history: history.data,
        predictedByVenue: predictedForCoin,
      },
    };
  },

  /**
   * Full account view for an address: perp positions + margin, spot balances,
   * and per-period PnL. This is the "$USER_ADDRESS portfolio" tool.
   */
  portfolio: async (args: { user: string }, opts?: HlOpts): Promise<HlResult> => {
    const [perp, spot, series, abstraction] = await Promise.all([
      infoRequest({ type: "clearinghouseState", user: args.user }, opts),
      infoRequest({ type: "spotClearinghouseState", user: args.user }, opts),
      infoRequest({ type: "portfolio", user: args.user }, opts),
      // Fail-soft: an unreadable mode just means we fall back to the perp
      // ledger's own `withdrawable`, which is what this tool always said.
      infoRequest({ type: "userAbstraction", user: args.user }, opts).catch(() => null),
    ]);
    if (!perp.ok) return perp;
    const perpState = perp.data as {
      marginSummary?: Record<string, string>;
      withdrawable?: string;
      assetPositions?: { position: Record<string, unknown>; type: string }[];
    };
    // The portfolio series are huge [ms, value][] arrays — summarize to the
    // latest account value + PnL + volume per period.
    let pnl: Record<string, { accountValue: string | null; pnl: string | null; volume: string | null }> | null = null;
    if (series.ok && Array.isArray(series.data)) {
      pnl = {};
      for (const entry of series.data as [string, { accountValueHistory?: [number, string][]; pnlHistory?: [number, string][]; vlm?: string }][]) {
        const [period, d] = entry;
        pnl[period] = {
          accountValue: d?.accountValueHistory?.at(-1)?.[1] ?? null,
          pnl: d?.pnlHistory?.at(-1)?.[1] ?? null,
          volume: d?.vlm ?? null,
        };
      }
      // Keep the headline periods; perp* variants are near-duplicates.
      pnl = Object.fromEntries(Object.entries(pnl).filter(([k]) => !k.startsWith("perp")));
    }
    const accountMode = typeof abstraction?.data === "string" ? abstraction.data : null;
    const spotUsdcFree = spot.ok ? freeSpotUsdc(spot.data) : null;
    const available = availableToTradeUsd({
      perpWithdrawable: perpState.withdrawable,
      accountMode,
      spotUsdcFree,
    });
    return {
      ok: true,
      status: 200,
      data: {
        user: args.user,
        accountMode,
        perp: {
          accountValueUsd: perpState.marginSummary?.accountValue ?? null,
          totalMarginUsedUsd: perpState.marginSummary?.totalMarginUsed ?? null,
          totalNotionalUsd: perpState.marginSummary?.totalNtlPos ?? null,
          withdrawableUsd: perpState.withdrawable ?? null,
          availableToTradeUsd: fmtUsd(available),
          ...(spotBacksPerps(accountMode) && available > Number(perpState.withdrawable ?? 0)
            ? {
                collateralNote:
                  "This account keeps its perp collateral in SPOT USDC, so `withdrawableUsd` reads ~0 while the account is funded. Size trades against `availableToTradeUsd`.",
              }
            : {}),
          positions: (perpState.assetPositions ?? []).map((p) => p.position),
        },
        spot: {
          balances: spot.ok ? (spot.data as { balances?: unknown[] })?.balances ?? [] : [],
        },
        pnl,
      },
    };
  },

  /** Open orders with frontend detail (trigger/TP-SL/reduce-only flags). */
  openOrders: async (args: { user: string }, opts?: HlOpts): Promise<HlResult> => {
    const r = await infoRequest({ type: "frontendOpenOrders", user: args.user }, opts);
    if (!r.ok) return r;
    const orders = (r.data as Record<string, unknown>[]) ?? [];
    return {
      ok: true,
      status: 200,
      data: { user: args.user, count: orders.length, orders },
    };
  },

  /** Recent fills, optionally time-bounded. side B=buy/long, A=sell/short. */
  fills: async (
    args: { user: string; startTime?: number; endTime?: number; first?: number },
    opts?: HlOpts,
  ): Promise<HlResult> => {
    const body: Record<string, unknown> = args.startTime
      ? { type: "userFillsByTime", user: args.user, startTime: args.startTime, ...(args.endTime ? { endTime: args.endTime } : {}) }
      : { type: "userFills", user: args.user };
    const r = await infoRequest(body, opts);
    if (!r.ok) return r;
    const all = (r.data as Record<string, unknown>[]) ?? [];
    const first = Math.min(args.first ?? 25, 200);
    return {
      ok: true,
      status: 200,
      data: {
        user: args.user,
        totalReturned: all.length,
        fills: all.slice(0, first),
        ...(all.length > first ? { note: `Showing ${first} of ${all.length} — raise \`first\` or narrow the time window.` } : {}),
      },
    };
  },

  /** Status of one order by oid (number) or cloid (0x… string). */
  orderStatus: async (
    args: { user: string; oid: number | string },
    opts?: HlOpts,
  ): Promise<HlResult> => infoRequest({ type: "orderStatus", user: args.user, oid: args.oid }, opts),

  /** USDC ledger: funding payments or deposits/withdrawals/transfers. */
  ledger: async (
    args: { user: string; kind: "funding" | "transfers"; startTime?: number; endTime?: number },
    opts?: HlOpts,
  ): Promise<HlResult> => {
    const endTime = args.endTime ?? Date.now();
    const startTime = args.startTime ?? endTime - 7 * 24 * 3_600_000;
    return infoRequest(
      {
        type: args.kind === "funding" ? "userFunding" : "userNonFundingLedgerUpdates",
        user: args.user,
        startTime,
        endTime,
      },
      opts,
    );
  },
};
