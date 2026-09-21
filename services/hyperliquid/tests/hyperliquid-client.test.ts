import { describe, it, expect, beforeEach } from "vitest";
import {
  queries,
  resolveCoin,
  clip,
  clearMetaCaches,
  buildSpotMaps,
  availableToTradeUsd,
  freeSpotUsdc,
  spotBacksPerps,
} from "@/lib/hyperliquid";

// ── Canned fixtures (shapes mirror the live API, probed 2026-07-06) ─────────

const PERP_META = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 40 },
    { name: "ETH", szDecimals: 4, maxLeverage: 25 },
    { name: "MATIC", szDecimals: 1, maxLeverage: 20, isDelisted: true },
  ],
};
const PERP_CTXS = [
  { funding: "0.0000125", openInterest: "10000", prevDayPx: "95000", dayNtlVlm: "2000000000", premium: "0", oraclePx: "100100", markPx: "100000", midPx: "100050", impactPxs: null },
  { funding: "-0.00001", openInterest: "50000", prevDayPx: "1800", dayNtlVlm: "900000000", premium: "0", oraclePx: "1771", markPx: "1770", midPx: "1770.5", impactPxs: null },
  { funding: "0", openInterest: "0", prevDayPx: "0.5", dayNtlVlm: "0", premium: null, oraclePx: "0.5", markPx: "0.5", midPx: null, impactPxs: null },
];

const SPOT_META = {
  tokens: [
    { name: "USDC", index: 0 },
    { name: "PURR", index: 1 },
    { name: "HYPE", index: 2 },
  ],
  universe: [
    { name: "PURR/USDC", tokens: [1, 0] as [number, number], index: 0, isCanonical: true },
    { name: "@1", tokens: [2, 0] as [number, number], index: 1, isCanonical: false },
  ],
};
const SPOT_CTXS = [
  { coin: "PURR/USDC", markPx: "0.35", midPx: "0.351", prevDayPx: "0.30", dayNtlVlm: "1000000" },
  { coin: "@1", markPx: "44.5", midPx: "44.6", prevDayPx: "40.0", dayNtlVlm: "50000000", circulatingSupply: "333000000" },
];

const FIXTURES: Record<string, unknown> = {
  metaAndAssetCtxs: [PERP_META, PERP_CTXS],
  spotMetaAndAssetCtxs: [SPOT_META, SPOT_CTXS],
  allMids: { BTC: "100050", ETH: "1770.5", "@1": "44.6", "PURR/USDC": "0.351" },
  l2Book: {
    coin: "ETH",
    time: 1783339036818,
    levels: [
      Array.from({ length: 15 }, (_, i) => ({ px: String(1770 - i), sz: "10", n: 2 })),
      Array.from({ length: 15 }, (_, i) => ({ px: String(1771 + i), sz: "8", n: 3 })),
    ],
  },
  candleSnapshot: [
    { t: 1, T: 2, s: "ETH", i: "1h", o: "1700", h: "1780", l: "1690", c: "1770", v: "12345", n: 42 },
  ],
  clearinghouseState: {
    marginSummary: { accountValue: "5000.5", totalNtlPos: "12000", totalRawUsd: "5000.5", totalMarginUsed: "1200" },
    withdrawable: "3800.5",
    assetPositions: [
      { type: "oneWay", position: { coin: "ETH", szi: "2.5", entryPx: "1700", unrealizedPnl: "176", leverage: { type: "cross", value: 10 } } },
    ],
    time: 1783339058257,
  },
  spotClearinghouseState: {
    balances: [
      { coin: "HYPE", token: 2, total: "100", hold: "0", entryNtl: "4000" },
      { coin: "USDC", token: 0, total: "251.31635", hold: "128.541356", entryNtl: "0.0" },
    ],
  },
  userAbstraction: "default",
  portfolio: [
    ["day", { accountValueHistory: [[1, "4900"], [2, "5000.5"]], pnlHistory: [[1, "-10"], [2, "90.5"]], vlm: "25000" }],
    ["perpDay", { accountValueHistory: [[2, "5000.5"]], pnlHistory: [[2, "90.5"]], vlm: "25000" }],
    ["allTime", { accountValueHistory: [[2, "5000.5"]], pnlHistory: [[2, "1500"]], vlm: "900000" }],
  ],
  frontendOpenOrders: [
    { coin: "ETH", side: "B", limitPx: "1700", sz: "1", oid: 111, timestamp: 1, orderType: "Limit", reduceOnly: false },
  ],
  userFills: Array.from({ length: 30 }, (_, i) => ({ coin: "ETH", px: "1770", sz: "0.1", side: "B", oid: 200 + i, time: 1000 + i })),
  fundingHistory: [{ coin: "ETH", fundingRate: "-0.00001", premium: "0", time: 1 }],
  predictedFundings: [
    ["ETH", [["HlPerp", { fundingRate: "-0.00001", nextFundingTime: 99 }], ["BinPerp", { fundingRate: "0.00001", nextFundingTime: 99 }]]],
    ["BTC", [["HlPerp", { fundingRate: "0.0000125", nextFundingTime: 99 }]]],
  ],
};

const requests: Record<string, unknown>[] = [];
const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { type: string };
  requests.push(body);
  const fixture = FIXTURES[body.type];
  if (fixture === undefined) return new Response(JSON.stringify({ error: "no fixture" }), { status: 500 });
  return new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const opts = { fetchImpl: mockFetch };

beforeEach(() => {
  clearMetaCaches();
  requests.length = 0;
});

describe("perpMarkets", () => {
  it("merges universe + ctxs, sorts by volume, drops delisted, derives USD OI + APR", async () => {
    const r = await queries.perpMarkets({}, opts);
    expect(r.ok).toBe(true);
    const { markets } = r.data as { markets: Record<string, unknown>[] };
    expect(markets.map((m) => m.coin)).toEqual(["BTC", "ETH"]); // volume-sorted, MATIC delisted
    const btc = markets[0]!;
    expect(btc.openInterestUsd).toBe(10000 * 100000);
    expect(btc.fundingAnnualizedPct).toBeCloseTo(0.0000125 * 24 * 365 * 100, 2);
    expect(btc.change24hPct).toBeCloseTo(((100000 - 95000) / 95000) * 100, 1);
  });

  it("filters by coins case-insensitively and flags unknowns", async () => {
    const r = await queries.perpMarkets({ coins: ["eth", "DOGE"] }, opts);
    const data = r.data as { markets: { coin: string }[]; note?: string };
    expect(data.markets.map((m) => m.coin)).toEqual(["ETH"]);
    expect(data.note).toContain("DOGE");
  });
});

describe("spotMarkets + coin resolution", () => {
  it("resolves '@N' pairs to token names and exposes nativeName", async () => {
    const r = await queries.spotMarkets({}, opts);
    const { markets } = r.data as { markets: { pair: string; nativeName: string }[] };
    expect(markets[0]).toMatchObject({ pair: "HYPE/USDC", nativeName: "@1" }); // top volume
    expect(markets[1]).toMatchObject({ pair: "PURR/USDC", nativeName: "PURR/USDC" });
  });

  it("resolveCoin handles perps, bare spot tokens, pairs, and native names", async () => {
    expect(await resolveCoin("eth", opts)).toMatchObject({ coin: "ETH", kind: "perp" });
    expect(await resolveCoin("HYPE", opts)).toMatchObject({ coin: "@1", display: "HYPE/USDC", kind: "spot" });
    expect(await resolveCoin("hype/usdc", opts)).toMatchObject({ coin: "@1", kind: "spot" });
    expect(await resolveCoin("@1", opts)).toMatchObject({ coin: "@1", kind: "spot" });
    expect(await resolveCoin("PURR", opts)).toMatchObject({ coin: "PURR/USDC", kind: "spot" });
    expect(await resolveCoin("NOPE", opts)).toBeNull();
  });

  it("buildSpotMaps prefers the first pair for bare-token aliases", () => {
    const maps = buildSpotMaps(SPOT_META.universe, SPOT_META.tokens);
    expect(maps.pairByAlias.get("HYPE")).toBe("@1");
    expect(maps.displayByPair.get("@1")).toBe("HYPE/USDC");
  });
});

describe("prices", () => {
  it("returns perp-only mids when unfiltered", async () => {
    const r = await queries.prices({}, opts);
    const { mids } = r.data as { mids: Record<string, string> };
    expect(mids.BTC).toBe("100050");
    expect(Object.keys(mids).some((k) => k.startsWith("@"))).toBe(false);
  });

  it("resolves mixed perp + spot aliases when filtered", async () => {
    const r = await queries.prices({ coins: ["eth", "hype", "NOPE"] }, opts);
    const { mids } = r.data as { mids: Record<string, string | null> };
    expect(mids.ETH).toBe("1770.5");
    expect(mids["HYPE/USDC"]).toBe("44.6");
    expect(mids.NOPE).toBeNull();
  });
});

describe("orderbook", () => {
  it("summarizes best bid/ask + spread and trims depth", async () => {
    const r = await queries.orderbook({ coin: "ETH", depth: 5 }, opts);
    expect(r.ok).toBe(true);
    const book = r.data as { bestBid: string; bestAsk: string; spreadPct: number; bids: unknown[]; asks: unknown[] };
    expect(book.bestBid).toBe("1770");
    expect(book.bestAsk).toBe("1771");
    expect(book.bids).toHaveLength(5);
    expect(book.asks).toHaveLength(5);
    expect(book.spreadPct).toBeGreaterThan(0);
  });

  it("404s an unknown coin instead of hitting the API", async () => {
    const r = await queries.orderbook({ coin: "NOPE" }, opts);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });
});

describe("candles", () => {
  it("sends the nested `req` body the API requires and shapes OHLCV", async () => {
    const r = await queries.candles({ coin: "ETH", interval: "1h", hoursBack: 6 }, opts);
    expect(r.ok).toBe(true);
    const sent = requests.find((q) => q.type === "candleSnapshot") as { req?: { coin: string; interval: string; startTime: number; endTime: number } };
    expect(sent?.req?.coin).toBe("ETH");
    expect(sent?.req?.interval).toBe("1h");
    expect(sent!.req!.endTime - sent!.req!.startTime).toBe(6 * 3_600_000);
    const { candles } = r.data as { candles: { o: string; trades: number }[] };
    expect(candles[0]).toMatchObject({ o: "1700", trades: 42 });
  });
});

describe("funding", () => {
  it("pairs history with the coin's predicted cross-venue rates", async () => {
    const r = await queries.funding({ coin: "eth" }, opts);
    const data = r.data as { coin: string; predictedByVenue: [string, unknown][] };
    expect(data.coin).toBe("ETH");
    expect(data.predictedByVenue.map(([v]) => v)).toEqual(["HlPerp", "BinPerp"]);
  });
});

describe("portfolio", () => {
  it("combines perp state + spot balances + summarized PnL (perp* periods dropped)", async () => {
    const r = await queries.portfolio({ user: "0x" + "a".repeat(40) }, opts);
    expect(r.ok).toBe(true);
    const data = r.data as {
      perp: { accountValueUsd: string; positions: unknown[] };
      spot: { balances: unknown[] };
      pnl: Record<string, { accountValue: string; pnl: string }>;
    };
    expect(data.perp.accountValueUsd).toBe("5000.5");
    expect(data.perp.positions).toHaveLength(1);
    expect(data.spot.balances).toHaveLength(2);
    expect(data.pnl.day).toMatchObject({ accountValue: "5000.5", pnl: "90.5" });
    expect(data.pnl.allTime.pnl).toBe("1500");
    expect(data.pnl.perpDay).toBeUndefined();
  });

  it("a classic account trades against its perp withdrawable, and says so", async () => {
    const r = await queries.portfolio({ user: "0x" + "a".repeat(40) }, opts);
    const d = r.data as {
      accountMode: string | null;
      perp: { withdrawableUsd: string; availableToTradeUsd: string; collateralNote?: string };
    };
    expect(d.accountMode).toBe("default");
    // Spot USDC is free here ($122.77) but must NOT count: a classic account's
    // spot wallet does not back perp margin.
    expect(d.perp.withdrawableUsd).toBe("3800.5");
    expect(d.perp.availableToTradeUsd).toBe("3800.5");
    expect(d.perp.collateralNote).toBeUndefined();
  });

  it("a unified account reads free spot USDC, not the swept-to-zero withdrawable", async () => {
    // Live shape of the 2026-09-21 wallet: perps fully funded, withdrawable 0.
    const savedMode = FIXTURES.userAbstraction;
    const savedPerp = FIXTURES.clearinghouseState;
    FIXTURES.userAbstraction = "unifiedAccount";
    FIXTURES.clearinghouseState = { ...(savedPerp as object), withdrawable: "0.0" };
    try {
      const r = await queries.portfolio({ user: "0x" + "a".repeat(40) }, opts);
      const d = r.data as {
        accountMode: string;
        perp: { withdrawableUsd: string; availableToTradeUsd: string; collateralNote?: string };
      };
      expect(d.accountMode).toBe("unifiedAccount");
      expect(d.perp.withdrawableUsd).toBe("0.0"); // kept verbatim for compatibility
      expect(d.perp.availableToTradeUsd).toBe("122.774994"); // 251.31635 − 128.541356
      expect(d.perp.collateralNote).toContain("availableToTradeUsd");
    } finally {
      FIXTURES.userAbstraction = savedMode;
      FIXTURES.clearinghouseState = savedPerp;
    }
  });

  it("falls back to withdrawable when the account mode can't be read", async () => {
    const saved = FIXTURES.userAbstraction;
    delete FIXTURES.userAbstraction; // the mock answers 500 → accountMode null
    try {
      const r = await queries.portfolio({ user: "0x" + "a".repeat(40) }, opts);
      const d = r.data as { accountMode: string | null; perp: { availableToTradeUsd: string } };
      expect(d.accountMode).toBeNull();
      expect(d.perp.availableToTradeUsd).toBe("3800.5");
    } finally {
      FIXTURES.userAbstraction = saved;
    }
  });
});

describe("availableToTradeUsd", () => {
  it("only lets spot USDC back perps in unified / portfolio-margin modes", () => {
    for (const mode of ["unifiedAccount", "portfolioMargin"]) {
      expect(spotBacksPerps(mode)).toBe(true);
      expect(availableToTradeUsd({ perpWithdrawable: "0.0", accountMode: mode, spotUsdcFree: 124 })).toBe(124);
    }
    expect(spotBacksPerps("default")).toBe(false);
    expect(availableToTradeUsd({ perpWithdrawable: "0.0", accountMode: "default", spotUsdcFree: 124 })).toBe(0);
  });

  it("never reads below withdrawable, and never goes negative", () => {
    expect(availableToTradeUsd({ perpWithdrawable: "500", accountMode: "unifiedAccount", spotUsdcFree: 10 })).toBe(500);
    expect(availableToTradeUsd({ perpWithdrawable: "-3", accountMode: "unifiedAccount", spotUsdcFree: null })).toBe(0);
    expect(availableToTradeUsd({ perpWithdrawable: null })).toBe(0);
  });

  it("reads free spot USDC as total − hold, and ignores other tokens", () => {
    expect(freeSpotUsdc({ balances: [{ coin: "USDC", total: "251.31635", hold: "128.541356" }] })).toBeCloseTo(122.774994, 6);
    expect(freeSpotUsdc({ balances: [{ coin: "HYPE", total: "100", hold: "0" }] })).toBeNull();
    expect(freeSpotUsdc(null)).toBeNull();
  });
});

describe("fills", () => {
  it("trims to `first` and notes the trim", async () => {
    const r = await queries.fills({ user: "0x" + "a".repeat(40), first: 10 }, opts);
    const data = r.data as { fills: unknown[]; totalReturned: number; note?: string };
    expect(data.fills).toHaveLength(10);
    expect(data.totalReturned).toBe(30);
    expect(data.note).toContain("10 of 30");
  });

  it("switches to userFillsByTime when a startTime is given", async () => {
    FIXTURES.userFillsByTime = FIXTURES.userFills;
    await queries.fills({ user: "0x" + "a".repeat(40), startTime: 123 }, opts);
    expect(requests.at(-1)).toMatchObject({ type: "userFillsByTime", startTime: 123 });
  });
});

describe("plumbing", () => {
  it("clip truncates oversized payloads with a preview", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, pad: "x".repeat(10) })) };
    const clipped = clip(big) as { note?: string; preview?: string };
    expect(clipped.note).toContain("truncated");
    expect(clipped.preview!.length).toBeLessThanOrEqual(24_000);
    expect(clip({ small: true })).toEqual({ small: true });
  });

  it("surfaces upstream HTTP errors as ok:false", async () => {
    const r = await queries.ledger({ user: "0x" + "a".repeat(40), kind: "funding" }, opts);
    expect(r.ok).toBe(false); // no userFunding fixture → mock 500
    expect(r.status).toBe(500);
  });
});
