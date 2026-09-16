// Tape parity (lib/tape.ts): a stock fill is priced per share against
// Robinhood's tape and refused past 10% either side; no tape, no build. The
// pure checks run on hand-built legs (AMAT isn't in this service's registry);
// the feed reader runs against a fake fetch — no live calls.

import { afterEach, describe, expect, it } from "vitest";
import { resolveToken, type RegistryToken } from "@/lib/registry";
import {
  LIFI_VENUE,
  OffTapeError,
  OffTapeMinimumError,
  ROBINHOOD_BATCH_MAX,
  TAPE_MAX_AGE_MS,
  TapeUnavailableError,
  V4_VENUE,
  checkFillAgainstTape,
  checkMinimumAgainstTape,
  fillDeviationPct,
  fmtSharePx,
  offTapeSentence,
  readStockTape,
  readSwapTape,
  setTapeFetchForTests,
  swapLegOf,
  tapeBand,
  tapeCheckOf,
  tapeFillOf,
  type PricedLeg,
  type SwapTape,
} from "@/lib/tape";
import { fakeTape } from "./fake-tape";

const NOW = Date.parse("2026-09-16T15:50:00Z");
const leg = (symbol: string, decimals: number, kind: PricedLeg["kind"], usd: number, feed: PricedLeg["feed"] = "robinhood"): PricedLeg => ({
  symbol,
  priceSymbol: symbol,
  address: "0x0000000000000000000000000000000000000001",
  decimals,
  kind,
  usd,
  feed: kind === "stable" ? "face value" : feed,
  asOf: NOW,
});

const USDG_LEG = leg("USDG", 6, "stable", 1);
const AMAT_LEG = leg("AMAT", 18, "stock", 421.84);
const AAPL_LEG = leg("AAPL", 18, "stock", 332.78);

const USDG = resolveToken("USDG")!;
const AAPL = resolveToken("AAPL")!;
const TSLA = resolveToken("TSLA")!;
const WETH = resolveToken("WETH")!;
const CUSO = resolveToken("CUSO")!;

afterEach(() => setTapeFetchForTests(null));

describe("the fill, priced against the tape (pure)", () => {
  it("refuses the shipped AMAT fill: 50 USDG → 0.001515581146145081 AMAT is $32,990.65 a share against a $421.84 tape", () => {
    const amountIn = 50_000_000n; // 50 USDG (6 decimals)
    const amountOut = 1_515_581_146_145_081n; // 0.001515581146145081 AMAT
    const fill = tapeFillOf(V4_VENUE, USDG_LEG, AMAT_LEG, amountIn, amountOut)!;
    expect(fill.side).toBe("buy");
    expect(fill.symbol).toBe("AMAT");
    expect(fmtSharePx(fill.sharePx)).toBe("$32,990.65");
    expect(fill.devPct).toBeGreaterThan(7_700); // 78× the tape
    expect(tapeBand(fill.devPct)).toBe("off");

    const tape: SwapTape = { sell: USDG_LEG, buy: AMAT_LEG };
    let thrown: unknown;
    try {
      checkFillAgainstTape(tape, V4_VENUE, amountIn, amountOut);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OffTapeError);
    expect((thrown as OffTapeError).message).toBe(
      "Robinhood Chain's Uniswap v4 pool fills this AMAT buy at $32,990.65 a share — 78× Robinhood's tape ($421.84), outside the 10% bound.",
    );
  });

  it("passes a healthy AAPL fill inside 0.1% of the tape", () => {
    const amountIn = 50_000_000n; // 50 USDG
    const amountOut = 150_200_000_000_000_000n; // 0.1502 AAPL → $332.89 a share
    const fill = tapeFillOf(V4_VENUE, USDG_LEG, AAPL_LEG, amountIn, amountOut)!;
    expect(Math.abs(fill.devPct)).toBeLessThan(0.1);
    expect(tapeBand(fill.devPct)).toBe("ok");

    const check = checkFillAgainstTape({ sell: USDG_LEG, buy: AAPL_LEG }, V4_VENUE, amountIn, amountOut)!;
    expect(check.status).toBe("ok");
    expect(check.fillPerShare).toBe("$332.89");
    expect(check.tape).toBe("$332.78");
    expect(check.deviation).toBe("+0.03%");
    expect(check.note).toBe(
      "Checked against Robinhood's tape: this AAPL buy fills at $332.89 a share vs $332.78 (+0.03%, within the 10% bound).",
    );
  });

  it("reads the sell side of a broken pool as off tape too (symmetric)", () => {
    // 0.1502 AAPL → 0.3 USDG: $2.00 a share against $332.78
    const fill = tapeFillOf(V4_VENUE, AAPL_LEG, USDG_LEG, 150_200_000_000_000_000n, 300_000n)!;
    expect(fill.side).toBe("sell");
    expect(tapeBand(fill.devPct)).toBe("off");
    expect(offTapeSentence(fill)).toBe(
      "Robinhood Chain's Uniswap v4 pool fills this AAPL sell at $2.00 a share — 99.40% below Robinhood's tape ($332.78), outside the 10% bound.",
    );
    // …and a pool paying far MORE than the tape is refused the same way.
    const rich = tapeFillOf(V4_VENUE, AAPL_LEG, USDG_LEG, 150_200_000_000_000_000n, 60_000_000n)!; // $399.47 a share, +20%
    expect(tapeBand(rich.devPct)).toBe("off");
  });

  it("draws the bands at 3% (warn) and 10% (refuse), either side; non-finite is off", () => {
    expect(tapeBand(0)).toBe("ok");
    expect(tapeBand(3)).toBe("ok");
    expect(tapeBand(-3.0001)).toBe("warn");
    expect(tapeBand(10)).toBe("warn");
    expect(tapeBand(10.0001)).toBe("off");
    expect(tapeBand(-10.0001)).toBe("off");
    expect(tapeBand(Number.NaN)).toBe("off");
    expect(tapeBand(Number.POSITIVE_INFINITY)).toBe("off");
  });

  it("builds inside the warn band with a note that names the gap", () => {
    // 50 USDG → 0.14286 AAPL = $350.00 a share, +5.17%
    const check = checkFillAgainstTape({ sell: USDG_LEG, buy: AAPL_LEG }, LIFI_VENUE, 50_000_000n, 142_857_142_857_142_857n)!;
    expect(check.status).toBe("warn");
    expect(check.note).toBe("This AAPL buy fills at $350.00 a share, 5.17% above Robinhood's tape ($332.78) — inside the 10% bound, but a real gap.");
  });

  it("refuses a venue that returns no shares", () => {
    const fill = tapeFillOf(V4_VENUE, USDG_LEG, AAPL_LEG, 50_000_000n, 0n)!;
    expect(tapeBand(fill.devPct)).toBe("off");
    expect(offTapeSentence(fill)).toContain("returns no AAPL for this order");
  });

  it("prices stock-for-stock at the stock bought, names a Yahoo-served tape, and ignores non-stock pairs", () => {
    const tsla = leg("TSLA", 18, "stock", 362.33);
    const fill = tapeFillOf(LIFI_VENUE, tsla, AAPL_LEG, 10n ** 18n, 1_080_000_000_000_000_000n)!; // 1 TSLA → 1.08 AAPL
    expect(fill.symbol).toBe("AAPL");
    expect(fill.sharePx).toBeCloseTo(335.49, 2);
    expect(tapeBand(fill.devPct)).toBe("ok");

    const yahooAapl = leg("AAPL", 18, "stock", 332.78, "yahoo");
    const off = tapeFillOf(V4_VENUE, USDG_LEG, yahooAapl, 50_000_000n, 1_515_581_146_145_081n)!;
    expect(offTapeSentence(off)).toContain("the Yahoo Finance tape ($332.78)");
    expect(tapeCheckOf(tapeFillOf(V4_VENUE, USDG_LEG, yahooAapl, 50_000_000n, 150_200_000_000_000_000n)!).tapeFeed).toBe("Yahoo Finance (fallback)");

    expect(tapeFillOf(V4_VENUE, USDG_LEG, leg("WETH", 18, "coin", 2400, "coinbase"), 50_000_000n, 10n ** 16n)).toBeNull();
    expect(checkFillAgainstTape(null, V4_VENUE, 1n, 1n)).toBeNull();
    expect(fillDeviationPct(null, 1n, 1n)).toBeNull();
  });

  it("checks the minimum a transaction accepts, not just the quote", () => {
    const tape: SwapTape = { sell: USDG_LEG, buy: AAPL_LEG };
    // healthy quote (0.1502 AAPL) at 1% slippage → minimum 0.148698 AAPL = $336.25, +1.04%
    expect(checkMinimumAgainstTape(tape, V4_VENUE, 50_000_000n, 148_698_000_000_000_000n, "")).toBe("$336.25 a share (+1.04% vs the tape)");
    // the same quote at 50% slippage lets the minimum sit at twice the tape
    let thrown: unknown;
    try {
      checkMinimumAgainstTape(tape, V4_VENUE, 50_000_000n, 75_100_000_000_000_000n, "The 50% slippage (slippageBps 5000) sets that minimum.");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OffTapeMinimumError);
    expect((thrown as Error).message).toContain("the minimum the transaction accepts works out to $665.78 a share");
    expect((thrown as Error).message).toContain("slippageBps 5000");
  });
});

describe("legs", () => {
  it("maps registry tokens: stocks/ETFs to the tape (CUSO reads USO), stables at face value, WETH as ETH", () => {
    expect(swapLegOf(AAPL)).toMatchObject({ kind: "stock", priceSymbol: "AAPL" });
    expect(swapLegOf(CUSO)).toMatchObject({ kind: "stock", symbol: "CUSO", priceSymbol: "USO" });
    expect(swapLegOf(resolveToken("SPY")!)).toMatchObject({ kind: "stock", priceSymbol: "SPY" });
    expect(swapLegOf(USDG)).toMatchObject({ kind: "stable" });
    expect(swapLegOf(resolveToken("USDe")!)).toMatchObject({ kind: "stable" });
    expect(swapLegOf(WETH)).toMatchObject({ kind: "coin", priceSymbol: "ETH" });
  });
});

describe("reading the tape (faked feeds)", () => {
  it("reads Robinhood's last non-interpolated close for the stock, USDG at face value", async () => {
    const urls = fakeTape({ robinhood: { AAPL: 332.78 }, asOf: NOW });
    const tape = (await readSwapTape(USDG, AAPL, NOW + 60_000))!;
    expect(tape.sell).toMatchObject({ kind: "stable", usd: 1, feed: "face value" });
    expect(tape.buy).toMatchObject({ kind: "stock", usd: 332.78, feed: "robinhood", asOf: NOW });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("interval=5minute&span=day&bounds=24_7");
  });

  it("asks the feeds for USO when the swap names CUSO", async () => {
    const urls = fakeTape({ robinhood: { USO: 156.07 } });
    const tape = (await readSwapTape(CUSO, USDG))!;
    expect(tape.sell).toMatchObject({ symbol: "CUSO", usd: 156.07 });
    expect(decodeURIComponent(urls[0])).toContain("symbols=USO&");
  });

  it("sends at most 75 symbols per Robinhood batch call", async () => {
    const table = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`S${i}`, 10 + i]));
    const urls = fakeTape({ robinhood: table });
    const got = await readStockTape(Object.keys(table));
    expect(got.size).toBe(80);
    const batches = urls.filter((u) => u.includes("api.robinhood.com"));
    expect(batches).toHaveLength(2);
    expect(new URL(batches[0]).searchParams.get("symbols")!.split(",")).toHaveLength(ROBINHOOD_BATCH_MAX);
    expect(urls.some((u) => u.includes("yahoo"))).toBe(false);
  });

  it("falls back to Yahoo per symbol when the batch is down or omits the symbol", async () => {
    let urls = fakeTape({ robinhoodStatus: 500, yahoo: { AAPL: 333.1 } });
    expect((await readSwapTape(USDG, AAPL))!.buy).toMatchObject({ usd: 333.1, feed: "yahoo" });
    expect(urls.some((u) => u.includes("query1.finance.yahoo.com/v8/finance/chart/AAPL"))).toBe(true);

    urls = fakeTape({ robinhood: {}, yahoo: { TSLA: 362.4 } });
    expect((await readSwapTape(TSLA, USDG))!.sell).toMatchObject({ usd: 362.4, feed: "yahoo" });
  });

  it("fails closed when no feed answers — transient, try again", async () => {
    fakeTape({ robinhoodStatus: 503 });
    const err = await readSwapTape(USDG, AAPL).catch((e) => e);
    expect(err).toBeInstanceOf(TapeUnavailableError);
    expect((err as TapeUnavailableError).reason).toBe("down");
    expect((err as TapeUnavailableError).permanent).toBe(false);
    expect((err as Error).message).toContain("try again in a moment");
  });

  it("treats a print older than 96 hours as no tape", async () => {
    fakeTape({ robinhood: { AAPL: 332.78 }, asOf: NOW - TAPE_MAX_AGE_MS - 60_000 });
    const err = await readSwapTape(USDG, AAPL, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(TapeUnavailableError);
    expect((err as TapeUnavailableError).reason).toBe("stale");
    expect((err as Error).message).toContain("The last AAPL price on the tape is from 2026-09-12");
  });

  it("refuses a listing no feed prices by name, permanently, without asking any feed", async () => {
    const urls = fakeTape({ robinhood: { CASHCAT: 1 } });
    const cashcat: RegistryToken = { symbol: "CASHCAT", name: "Cash Cat", address: "0x0000000000000000000000000000000000000c47", decimals: 18, feed: null, kind: "stock" };
    const err = await readSwapTape(USDG, cashcat).catch((e) => e);
    expect(err).toBeInstanceOf(TapeUnavailableError);
    expect((err as TapeUnavailableError).permanent).toBe(true);
    expect((err as Error).message).toContain("No price feed covers CASHCAT");
    expect(urls).toHaveLength(0);
  });

  it("prices WETH at Coinbase ETH-USD, and fails closed when Coinbase doesn't answer", async () => {
    fakeTape({ robinhood: { AAPL: 332.78 }, eth: 2391.64 });
    const tape = (await readSwapTape(WETH, AAPL))!;
    expect(tape.sell).toMatchObject({ kind: "coin", usd: 2391.64, feed: "coinbase" });

    fakeTape({ robinhood: { AAPL: 332.78 } });
    const err = await readSwapTape(WETH, AAPL).catch((e) => e);
    expect(err).toBeInstanceOf(TapeUnavailableError);
    expect((err as Error).message).toContain("Coinbase");
  });

  it("reads nothing for a pair with no stock", async () => {
    const urls = fakeTape({});
    expect(await readSwapTape(USDG, WETH)).toBeNull();
    expect(urls).toHaveLength(0);
  });

  it("reuses a symbol's quote for a few seconds (a quote, then a build)", async () => {
    const urls = fakeTape({ robinhood: { AAPL: 332.78 } });
    await readSwapTape(USDG, AAPL);
    await readSwapTape(AAPL, USDG);
    expect(urls).toHaveLength(1);
  });
});
