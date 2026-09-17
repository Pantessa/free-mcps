// ─────────────────────────────────────────────────────────────────────────
//  Tape parity for Robinhood Chain stock swaps (chain 4663).
//
//  A tokenized stock has two prices: Robinhood's tape (its 24/7 market-data
//  historicals, Yahoo Finance as the fallback) and the pool a swap fills in.
//  Every builder's slippage bound is measured from its OWN quote, so a pool
//  far from the tape still produced a fully guard-verified swap that lost the
//  money. Read-only scan, 2026-09-16: 22 curated Robinhood Chain stock pools
//  (AMAT, NOW, XOM, …) quoted 155×–2,700× the tape on a buy and paid under 1%
//  of it on a sell, and CLOV, FLY and RUN sat 35–83% off on one side. "Buy $50
//  of AMAT" built a guarded swap for ~0.0015 AMAT (~$0.64). The website fixed
//  its own builders in Pantessa/website#796 (lib/stock-tape.ts); this is the
//  same rule for build_swap and quote.
//
//  The rule:
//   · A swap with a stock or ETF on either side prices both legs — the stock
//     at the tape, USDG/USDe at face value, WETH at Coinbase's ETH-USD — and
//     compares the fill's per-share price with the tape.
//   · More than TAPE_BOUND_PCT away, EITHER side, is off tape (OffTapeError):
//     build_swap skips the Uniswap v4 pool for LiFi (Robinhood Chain's own
//     settlement venue), and refuses by name when LiFi's fill is off tape
//     too. Symmetric on purpose: a pool paying far MORE than the tape is the
//     thin side of the same broken pool, or a token that isn't the share we
//     think it is.
//   · Past TAPE_WARN_PCT the fill still builds, with a warning naming the gap.
//   · The minimum the transaction accepts must sit inside the bound as well.
//     The website's stock builders run at 0.5% slippage; build_swap lets the
//     caller pick up to 50%, which would otherwise let a checked quote sign
//     away a fill far off the tape.
//   · No tape, no build (fail closed). A stock no feed prices refuses by name;
//     a feed that didn't answer, or a last print older than TAPE_MAX_AGE_MS,
//     refuses with "try again in a moment".
//
//  Why 10%: measured at a $100 order on 2026-09-16, every working pool sat
//  within 3.8% of the tape and the thin-but-real ones inside 9%; every broken
//  one was 35% or more off.
// ─────────────────────────────────────────────────────────────────────────

import type { Address, RegistryToken } from "./registry";

/** A fill further than this from the tape, either side, is refused. */
export const TAPE_BOUND_PCT = 10;
/** A fill further than this still builds, with a warning that names the gap. */
export const TAPE_WARN_PCT = 3;
/** A last print older than this is no tape: 96h spans the 24-hour market's
 *  weekend close (Fri 8pm → Sun 8pm ET) plus a holiday. */
export const TAPE_MAX_AGE_MS = 96 * 60 * 60 * 1000;
/** Robinhood's batch historicals answers 400 past 75 symbols (measured
 *  2026-09-16: 75 → 200, 76 → 400). */
export const ROBINHOOD_BATCH_MAX = 75;
/** Quotes are reused per symbol this long (a quote then a build, seconds apart). */
export const TAPE_CACHE_MS = 15_000;

const UPSTREAM_TIMEOUT_MS = 6_000;
const UA = "Mozilla/5.0 (compatible; Pantessa/1.0; +https://www.pantessa.com)";

export const V4_VENUE = "Robinhood Chain's Uniswap v4 pool";
export const LIFI_VENUE = "Robinhood Chain's own settlement venue (via LiFi)";

/**
 * Registry symbols the price feeds know by another ticker. `null` marks a
 * listing no feed prices at all: it refuses by name, permanently.
 */
export const TAPE_SYMBOLS: Readonly<Record<string, string | null>> = {
  // The chain docs list the oil fund as CUSO; the 4663 token list, Robinhood's
  // market data and Yahoo all call it USO (CUSO answers nothing).
  CUSO: "USO",
  // On the 4663 token list, priced by neither Robinhood (no row) nor Yahoo
  // (404), 2026-09-16. Not in the registry — fenced in case it's added.
  CASHCAT: null,
};

// ── Legs ────────────────────────────────────────────────────────────────────

export type SwapLegKind = "stock" | "stable" | "coin" | "other";

export interface SwapLeg {
  /** The registry symbol the swap names (CUSO). */
  symbol: string;
  /** The ticker the price feed knows (USO; ETH for WETH). Null: no feed. */
  priceSymbol: string | null;
  address: Address;
  decimals: number;
  kind: SwapLegKind;
}

export type PriceFeed = "robinhood" | "yahoo" | "coinbase" | "face value";

export interface PricedLeg extends SwapLeg {
  usd: number;
  feed: PriceFeed;
  /** Unix ms of the print. */
  asOf: number;
}

export interface SwapTape {
  sell: PricedLeg;
  buy: PricedLeg;
}

const STABLES = new Set(["USDG", "USDE"]);

export const isStockToken = (t: Pick<RegistryToken, "kind">): boolean => t.kind === "stock" || t.kind === "etf";

/** What a registry token is to the tape check. */
export function swapLegOf(token: RegistryToken): SwapLeg {
  const base = { symbol: token.symbol, address: token.address, decimals: token.decimals };
  if (isStockToken(token)) {
    const mapped = Object.prototype.hasOwnProperty.call(TAPE_SYMBOLS, token.symbol) ? TAPE_SYMBOLS[token.symbol] : token.symbol;
    return { ...base, priceSymbol: mapped ?? null, kind: "stock" };
  }
  const upper = token.symbol.toUpperCase();
  if (STABLES.has(upper)) return { ...base, priceSymbol: upper, kind: "stable" };
  if (upper === "WETH") return { ...base, priceSymbol: "ETH", kind: "coin" };
  return { ...base, priceSymbol: null, kind: "other" };
}

// ── The fill, priced (pure) ─────────────────────────────────────────────────

export interface TapeFill {
  /** V4_VENUE or LIFI_VENUE. */
  venue: string;
  /** The stock the per-share price is for. */
  symbol: string;
  side: "buy" | "sell";
  /** This fill's USD per share (Infinity when it returns no shares). */
  sharePx: number;
  tapeUsd: number;
  feed: PriceFeed;
  asOf: number;
  /** (sharePx − tape) / tape × 100. */
  devPct: number;
}

/**
 * Price a quoted fill per share against the tape. A buy (stock out) pays
 * `in × price(in) / shares`; a sell (stock in) receives `out × price(out) /
 * shares`; stock-for-stock reads the stock bought. Null when neither leg is a
 * stock.
 */
export function tapeFillOf(venue: string, sell: PricedLeg, buy: PricedLeg, amountIn: bigint, amountOut: bigint): TapeFill | null {
  const sellHuman = Number(amountIn) / 10 ** sell.decimals;
  const buyHuman = Number(amountOut) / 10 ** buy.decimals;
  let fill: Omit<TapeFill, "devPct"> | null = null;
  if (buy.kind === "stock") {
    const px = buyHuman > 0 ? (sellHuman * sell.usd) / buyHuman : Number.POSITIVE_INFINITY;
    fill = { venue, symbol: buy.symbol, side: "buy", sharePx: px, tapeUsd: buy.usd, feed: buy.feed, asOf: buy.asOf };
  } else if (sell.kind === "stock") {
    const px = sellHuman > 0 ? (buyHuman * buy.usd) / sellHuman : 0;
    fill = { venue, symbol: sell.symbol, side: "sell", sharePx: px, tapeUsd: sell.usd, feed: sell.feed, asOf: sell.asOf };
  }
  if (!fill) return null;
  return { ...fill, devPct: ((fill.sharePx - fill.tapeUsd) / fill.tapeUsd) * 100 };
}

export type TapeBand = "ok" | "warn" | "off";

/** Within the warn line, past it, or past the refusal bound. Non-finite = off. */
export function tapeBand(devPct: number): TapeBand {
  if (!Number.isFinite(devPct)) return "off";
  const d = Math.abs(devPct);
  if (d > TAPE_BOUND_PCT) return "off";
  return d > TAPE_WARN_PCT ? "warn" : "ok";
}

const tapeName = (feed: PriceFeed) => (feed === "yahoo" ? "the Yahoo Finance tape" : "Robinhood's tape");

/** "$32,990.65" · "$421.84" · "$0.0132". */
export function fmtSharePx(n: number): string {
  if (!Number.isFinite(n)) return "no price";
  if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toPrecision(3)}`;
}

/** Magnitude only: "7,721" past 100%, "8.58" under it. */
export function fmtTapeGap(devPct: number): string {
  const d = Math.abs(devPct);
  return d >= 100 ? Math.round(d).toLocaleString("en-US") : d.toFixed(2);
}

const signedGap = (devPct: number) => `${devPct >= 0 ? "+" : "−"}${fmtTapeGap(devPct)}%`;

/** "78× Robinhood's tape ($421.84)" at double or more, else
 *  "8.58% above Robinhood's tape ($5.94)". */
function gapWords(f: TapeFill): string {
  const tape = `${tapeName(f.feed)} (${fmtSharePx(f.tapeUsd)})`;
  if (f.devPct >= 100) {
    const x = f.sharePx / f.tapeUsd;
    return `${x < 10 ? x.toFixed(1) : Math.round(x).toLocaleString("en-US")}× ${tape}`;
  }
  return `${fmtTapeGap(f.devPct)}% ${f.devPct >= 0 ? "above" : "below"} ${tape}`;
}

/** The refusal sentence: venue, stock, both prices, the gap, the bound. */
export function offTapeSentence(f: TapeFill): string {
  if (!Number.isFinite(f.devPct)) {
    return `${f.venue} returns no ${f.symbol} for this order, against ${tapeName(f.feed)}'s ${fmtSharePx(f.tapeUsd)} a share — outside the ${TAPE_BOUND_PCT}% bound.`;
  }
  return `${f.venue} fills this ${f.symbol} ${f.side} at ${fmtSharePx(f.sharePx)} a share — ${gapWords(f)}, outside the ${TAPE_BOUND_PCT}% bound.`;
}

/** The tape row a quote or build carries, for any band. */
export interface TapeCheck {
  status: TapeBand;
  venue: string;
  stock: string;
  side: "buy" | "sell";
  fillPerShare: string;
  tape: string;
  tapeFeed: string;
  tapeAsOf: string;
  deviation: string;
  bound: string;
  note: string;
  /** A build's minimum out, per share and vs the tape (builds only). */
  minimum?: string;
}

export function tapeCheckOf(f: TapeFill): TapeCheck {
  const status = tapeBand(f.devPct);
  const note =
    status === "off"
      ? offTapeSentence(f)
      : status === "warn"
        ? `This ${f.symbol} ${f.side} fills at ${fmtSharePx(f.sharePx)} a share, ${gapWords(f)} — inside the ${TAPE_BOUND_PCT}% bound, but a real gap.`
        : `Checked against ${tapeName(f.feed)}: this ${f.symbol} ${f.side} fills at ${fmtSharePx(f.sharePx)} a share vs ${fmtSharePx(f.tapeUsd)} (${signedGap(f.devPct)}, within the ${TAPE_BOUND_PCT}% bound).`;
  return {
    status,
    venue: f.venue,
    stock: f.symbol,
    side: f.side,
    fillPerShare: fmtSharePx(f.sharePx),
    tape: fmtSharePx(f.tapeUsd),
    tapeFeed: f.feed === "yahoo" ? "Yahoo Finance (fallback)" : "Robinhood 24/7 market data",
    tapeAsOf: new Date(f.asOf).toISOString(),
    deviation: Number.isFinite(f.devPct) ? signedGap(f.devPct) : "no shares",
    bound: `±${TAPE_BOUND_PCT}% refuses, ±${TAPE_WARN_PCT}% warns`,
    note,
  };
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** The venue's fill is past the bound — build_swap tries the next venue. */
export class OffTapeError extends Error {
  constructor(public fill: TapeFill) {
    super(offTapeSentence(fill));
    this.name = "OffTapeError";
  }
}

/** The minimum the transaction accepts is past the bound, though the quote isn't. */
export class OffTapeMinimumError extends Error {
  constructor(
    public fill: TapeFill,
    detail: string,
  ) {
    super(
      `${fill.venue} quotes this ${fill.symbol} ${fill.side} inside the bound, but the minimum the transaction accepts works out to ${fmtSharePx(fill.sharePx)} a share — ${gapWords(fill)}, outside the ${TAPE_BOUND_PCT}% bound. ${detail}`,
    );
    this.name = "OffTapeMinimumError";
  }
}

export type TapeMissReason = "no-feed" | "down" | "stale";

/** No usable price for a leg. `permanent` (no feed exists) refuses by name;
 *  the rest are worth retrying. */
export class TapeUnavailableError extends Error {
  constructor(
    message: string,
    public symbol: string,
    public reason: TapeMissReason,
    /** Short, for a read that reports it: "no AAPL quote from Robinhood's tape or Yahoo Finance". */
    public detail: string,
  ) {
    super(message);
    this.name = "TapeUnavailableError";
  }
  get permanent(): boolean {
    return this.reason === "no-feed";
  }
}

export function tapeMissMessage(symbol: string, reason: TapeMissReason, asOf?: number): string {
  if (reason === "no-feed") {
    return `No price feed covers ${symbol} (Robinhood's market data or Yahoo Finance), so there's nothing to check Robinhood Chain's pool against — this service only builds a stock swap it can check against the tape. Nothing was built.`;
  }
  if (reason === "stale") {
    const when = asOf ? new Date(asOf).toISOString().slice(0, 10) : "days ago";
    return `The last ${symbol} price on the tape is from ${when} — too old to check Robinhood Chain's pool against, so nothing was built. Try again once it trades.`;
  }
  return `Couldn't read the ${symbol} price from Robinhood's tape or Yahoo Finance just now, and this service won't build a stock swap without checking the pool against it — try again in a moment. Nothing was built.`;
}

// ── Reading the tape (with a test seam, lifi.ts-style) ──────────────────────

type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const realFetch: FetchLike = (...args) => fetch(...args);
let fetchImpl: FetchLike = realFetch;

export interface PriceQuote {
  usd: number;
  feed: PriceFeed;
  asOf: number;
}

const cache = new Map<string, { at: number; quote: PriceQuote }>();

/** Test seam: replace the feed fetch (null restores the real one). Clears the cache. */
export function setTapeFetchForTests(fake: FetchLike | null) {
  fetchImpl = fake ?? realFetch;
  cache.clear();
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

export function robinhoodBatchUrl(symbols: readonly string[]): string {
  return `https://api.robinhood.com/marketdata/historicals/?symbols=${encodeURIComponent(symbols.join(","))}&interval=5minute&span=day&bounds=24_7`;
}

interface RhRow {
  close_price?: string;
  interpolated?: boolean;
  begins_at?: string;
}

/** One batch call: each symbol's last non-interpolated close. Throws when the batch itself fails. */
async function fetchRobinhoodBatch(symbols: readonly string[]): Promise<Map<string, PriceQuote>> {
  const res = await getJson(robinhoodBatchUrl(symbols), { "user-agent": UA, accept: "application/json" });
  if (!res.ok) throw new Error(`robinhood ${res.status}`);
  const results = (res.body as { results?: Array<{ symbol?: string; historicals?: RhRow[] } | null> } | null)?.results;
  if (!Array.isArray(results)) throw new Error("robinhood shape");
  const out = new Map<string, PriceQuote>();
  for (const r of results) {
    // An unknown ticker comes back as a row with an empty symbol.
    if (!r?.symbol || !Array.isArray(r.historicals)) continue;
    const rows = r.historicals.filter((h) => !h.interpolated && Number(h.close_price) > 0);
    const last = rows[rows.length - 1];
    if (!last) continue;
    const asOf = last.begins_at ? Date.parse(last.begins_at) : Date.now();
    out.set(r.symbol.toUpperCase(), { usd: Number(last.close_price), feed: "robinhood", asOf: Number.isFinite(asOf) ? asOf : Date.now() });
  }
  return out;
}

async function fetchYahoo(symbol: string): Promise<PriceQuote | null> {
  const res = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`, {
    "user-agent": UA,
    accept: "application/json",
  });
  if (!res.ok) return null;
  const meta = (res.body as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; regularMarketTime?: number } }> } } | null)?.chart
    ?.result?.[0]?.meta;
  const usd = Number(meta?.regularMarketPrice);
  if (!(usd > 0)) return null;
  return { usd, feed: "yahoo", asOf: meta?.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now() };
}

async function fetchCoinbase(product: string): Promise<PriceQuote | null> {
  const res = await getJson(`https://api.exchange.coinbase.com/products/${product}/stats`, { accept: "application/json" });
  if (!res.ok) return null;
  const usd = Number((res.body as { last?: string } | null)?.last);
  return usd > 0 ? { usd, feed: "coinbase", asOf: Date.now() } : null;
}

const cached = (key: string): PriceQuote | null => {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < TAPE_CACHE_MS ? hit.quote : null;
};

/**
 * Tape prices for stock tickers: one Robinhood batch call per
 * ROBINHOOD_BATCH_MAX symbols, Yahoo per symbol for anything the batch didn't
 * price. A symbol no source priced is omitted. Never throws.
 */
export async function readStockTape(symbols: readonly string[]): Promise<Map<string, PriceQuote>> {
  const out = new Map<string, PriceQuote>();
  const toFetch: string[] = [];
  for (const s of new Set(symbols.map((x) => x.trim().toUpperCase()).filter(Boolean))) {
    const hit = cached(`tape:${s}`);
    if (hit) out.set(s, hit);
    else toFetch.push(s);
  }
  for (let i = 0; i < toFetch.length; i += ROBINHOOD_BATCH_MAX) {
    const chunk = toFetch.slice(i, i + ROBINHOOD_BATCH_MAX);
    const batch = await fetchRobinhoodBatch(chunk).catch(() => null);
    await Promise.all(
      chunk.map(async (s) => {
        const quote = batch?.get(s) ?? (await fetchYahoo(s).catch(() => null));
        if (!quote) return;
        out.set(s, quote);
        cache.set(`tape:${s}`, { at: Date.now(), quote });
      }),
    );
  }
  return out;
}

async function readEthUsd(): Promise<PriceQuote | null> {
  const hit = cached("coinbase:ETH-USD");
  if (hit) return hit;
  const quote = await fetchCoinbase("ETH-USD").catch(() => null);
  if (quote) cache.set("coinbase:ETH-USD", { at: Date.now(), quote });
  return quote;
}

/** Price both legs, or throw TapeUnavailableError (fail closed). */
async function priceLegs(legs: [SwapLeg, SwapLeg], now: number): Promise<[PricedLeg, PricedLeg]> {
  // A leg nothing can price refuses before any request goes out.
  for (const leg of legs) {
    if (leg.kind === "other") {
      throw new TapeUnavailableError(
        `There's no public price for ${leg.symbol} to check this stock swap against, so nothing was built.`,
        leg.symbol,
        "no-feed",
        `no public price for ${leg.symbol}`,
      );
    }
    if (leg.kind === "stock" && leg.priceSymbol === null) {
      throw new TapeUnavailableError(tapeMissMessage(leg.symbol, "no-feed"), leg.symbol, "no-feed", `no price feed covers ${leg.symbol}`);
    }
  }
  const stockSymbols = legs.filter((l) => l.kind === "stock").map((l) => l.priceSymbol as string);
  const [tape, eth] = await Promise.all([
    stockSymbols.length > 0 ? readStockTape(stockSymbols) : Promise.resolve(new Map<string, PriceQuote>()),
    legs.some((l) => l.kind === "coin") ? readEthUsd() : Promise.resolve(null),
  ]);
  const priced = legs.map((leg): PricedLeg => {
    if (leg.kind === "stable") return { ...leg, usd: 1, feed: "face value", asOf: now };
    if (leg.kind === "coin") {
      if (!eth) {
        throw new TapeUnavailableError(
          "Couldn't read the ETH price from Coinbase just now, and this service won't build a stock swap it can't price — try again in a moment. Nothing was built.",
          leg.symbol,
          "down",
          "no ETH price from Coinbase",
        );
      }
      return { ...leg, ...eth };
    }
    const quote = tape.get(leg.priceSymbol as string);
    if (!quote) {
      throw new TapeUnavailableError(tapeMissMessage(leg.symbol, "down"), leg.symbol, "down", `no ${leg.symbol} quote from Robinhood's tape or Yahoo Finance`);
    }
    if (now - quote.asOf > TAPE_MAX_AGE_MS) {
      const day = new Date(quote.asOf).toISOString().slice(0, 10);
      throw new TapeUnavailableError(tapeMissMessage(leg.symbol, "stale", quote.asOf), leg.symbol, "stale", `the last ${leg.symbol} print is from ${day}, too old`);
    }
    return { ...leg, ...quote };
  });
  return [priced[0], priced[1]];
}

/**
 * Price both legs of a swap for the tape check. Null when neither leg is a
 * stock — the check has nothing to say. Throws TapeUnavailableError when a
 * leg a stock swap needs can't be priced (fail closed).
 */
export async function readSwapTape(sell: RegistryToken, buy: RegistryToken, now = Date.now()): Promise<SwapTape | null> {
  const legs: [SwapLeg, SwapLeg] = [swapLegOf(sell), swapLegOf(buy)];
  if (legs[0].kind !== "stock" && legs[1].kind !== "stock") return null;
  const [s, b] = await priceLegs(legs, now);
  return { sell: s, buy: b };
}

/** Start the tape read alongside a quote without an unhandled rejection:
 *  await it after the quote lands (the read rethrows then). */
export function startSwapTape(sell: RegistryToken, buy: RegistryToken): Promise<SwapTape | null> {
  const read = readSwapTape(sell, buy);
  read.catch(() => undefined);
  return read;
}

// ── The checks a builder runs ───────────────────────────────────────────────

/**
 * Check a venue's quoted fill: null when there's no tape context (not a stock
 * swap), the tape row when the fill is inside the bound, and OffTapeError
 * when it isn't.
 */
export function checkFillAgainstTape(tape: SwapTape | null, venue: string, amountIn: bigint, amountOut: bigint): TapeCheck | null {
  if (!tape) return null;
  const fill = tapeFillOf(venue, tape.sell, tape.buy, amountIn, amountOut);
  if (!fill) return null;
  if (tapeBand(fill.devPct) === "off") throw new OffTapeError(fill);
  return tapeCheckOf(fill);
}

/**
 * Check the minimum a built transaction accepts. Returns the minimum's gap
 * from the tape ("+1.02%"), null without a stock leg, and throws
 * OffTapeMinimumError past the bound. `detail` says what set the minimum.
 */
export function checkMinimumAgainstTape(tape: SwapTape | null, venue: string, amountIn: bigint, minOut: bigint, detail: string): string | null {
  if (!tape) return null;
  const fill = tapeFillOf(venue, tape.sell, tape.buy, amountIn, minOut);
  if (!fill) return null;
  if (tapeBand(fill.devPct) === "off") throw new OffTapeMinimumError(fill, detail);
  return `${fmtSharePx(fill.sharePx)} a share (${signedGap(fill.devPct)} vs the tape)`;
}

/** A fill's gap from the tape (percent), or null without a stock leg — for a
 *  reference quote a builder only reads, never refuses on. */
export function fillDeviationPct(tape: SwapTape | null, amountIn: bigint, amountOut: bigint): number | null {
  if (!tape) return null;
  return tapeFillOf("reference", tape.sell, tape.buy, amountIn, amountOut)?.devPct ?? null;
}
