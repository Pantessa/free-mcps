import { afterEach, describe, expect, it } from "vitest";
import { setRpcForTests } from "@/lib/chain";
import { accrueMarket, borrowApyFromRate, morphoReads, setFetchForTests, toAssetsDown, toAssetsUp } from "@/lib/morpho";
import { fakeClient, type FakeCall } from "./fake-rpc";

const USER = "0x1111111111111111111111111111111111111111" as const;
const MARKET_ID = `0x${"ab".repeat(32)}` as const;
// Real Base USDC (6 decimals) + WETH (18) — decimals/symbol are still READ
// from the fake, never assumed; the addresses just make the fixture honest.
const USDC = { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const, symbol: "USDC", decimals: 6 };
const WETH = { address: "0x4200000000000000000000000000000000000006" as const, symbol: "WETH", decimals: 18 };

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

const isUsdc = (c: FakeCall) => c.address.toLowerCase() === USDC.address.toLowerCase();

/** USDC/WETH market: 1000 USDC supplied, 600 borrowed, lltv 77%, WETH at $300. */
const marketReads = () => ({
  idToMarketParams: {
    loanToken: USDC.address,
    collateralToken: WETH.address,
    oracle: "0x00000000000000000000000000000000000000A1",
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    lltv: 770_000_000_000_000_000n,
  },
  market: {
    totalSupplyAssets: 1_000_000_000n, // 1000 USDC (6 dec)
    totalSupplyShares: 1_000_000_000n * 10n ** 6n,
    totalBorrowAssets: 600_000_000n,
    totalBorrowShares: 600_000_000n * 10n ** 6n,
    lastUpdate: nowSec(),
    fee: 0n,
  },
  borrowRateView: 1_585_489_599n, // ≈5% APR per-second WAD
  price: 300n * 10n ** 6n * 10n ** 18n, // $300/WETH → 300e6 loan atoms per 1e18 coll atoms, ×1e36/1e18
  symbol: (c: FakeCall) => (isUsdc(c) ? USDC.symbol : WETH.symbol),
  decimals: (c: FakeCall) => (isUsdc(c) ? USDC.decimals : WETH.decimals),
});

afterEach(() => {
  setRpcForTests(null);
  setFetchForTests(null);
});

describe("share/interest math (mirrors morpho-blue libs)", () => {
  it("converts shares↔assets with virtual offsets and rounds debt UP", () => {
    const shares = 100_000_000n * 10n ** 6n;
    const down = toAssetsDown(shares, 600_000_000n, 600_000_000n * 10n ** 6n);
    const up = toAssetsUp(shares, 600_000_000n, 600_000_000n * 10n ** 6n);
    expect(down).toBeLessThanOrEqual(up);
    expect(Number(up)).toBeCloseTo(100_000_000, -2);
  });

  it("accrues Taylor-compounded interest onto both totals", () => {
    const rate = 3_170_979_198n; // ≈10%/yr per-second WAD
    const market = {
      totalSupplyAssets: 1_000_000_000n,
      totalSupplyShares: 1n,
      totalBorrowAssets: 1_000_000_000n,
      totalBorrowShares: 1n,
      lastUpdate: 0n,
      fee: 0n,
    };
    const after = accrueMarket(market, rate, 31_536_000); // one year
    const growth = Number(after.totalBorrowAssets) / 1e9;
    expect(growth).toBeGreaterThan(1.10); // e^0.1 ≈ 1.1052
    expect(growth).toBeLessThan(1.106);
    expect(after.totalSupplyAssets).toBe(after.totalBorrowAssets - 1_000_000_000n + 1_000_000_000n);
  });

  it("turns a per-second rate into a compounded APY", () => {
    expect(borrowApyFromRate(1_585_489_599n)).toBeCloseTo(Math.expm1(0.05), 3);
  });
});

describe("position (on-chain, explicit market ids)", () => {
  it("computes supplied/debt/health from raw position state, chainId in the payload", async () => {
    const m = marketReads();
    setRpcForTests(
      fakeClient({
        reads: {
          ...m,
          position: { supplyShares: 0n, borrowShares: 100_000_000n * 10n ** 6n, collateral: 10n ** 18n },
        },
      }),
    );
    const res = await morphoReads.position({ chainId: 8453, user: USER, marketIds: [MARKET_ID] });
    expect(res.ok).toBe(true);
    const data = res.data as { chainId: number; chain: string; positions: Array<{ market: string; borrowed: { amount: string }; collateral: { amount: string; asset: string }; borrowingPower: { maxBorrow: string }; healthFactor: number }> };
    expect(data.chainId).toBe(8453);
    expect(data.chain).toBe("Base");
    expect(data.positions).toHaveLength(1);
    const p = data.positions[0];
    expect(p.market).toContain("USDC / WETH");
    expect(p.collateral).toMatchObject({ amount: "1", asset: "WETH" });
    expect(Number(p.borrowed.amount)).toBeCloseTo(100, 0);
    // maxBorrow = 1 WETH × $300 × 0.77 = 231 USDC → HF ≈ 2.31
    expect(Number(p.borrowingPower.maxBorrow)).toBeCloseTo(231, 0);
    expect(p.healthFactor).toBeGreaterThan(2.2);
    expect(p.healthFactor).toBeLessThan(2.4);
  });

  it("skips empty positions", async () => {
    setRpcForTests(
      fakeClient({
        reads: { position: { supplyShares: 0n, borrowShares: 0n, collateral: 0n } },
      }),
    );
    const res = await morphoReads.position({ chainId: 1, user: USER, marketIds: [MARKET_ID] });
    expect(res.ok).toBe(true);
    expect((res.data as { positions: unknown[]; chain: string }).positions).toHaveLength(0);
    expect((res.data as { summary: string }).summary).toContain("Ethereum");
  });
});

describe("markets", () => {
  const apiMarket = (marketId: string, listed: boolean) => ({
    marketId,
    listed,
    lltv: "770000000000000000",
    loanAsset: { symbol: "USDC", address: USDC.address, decimals: 6 },
    collateralAsset: { symbol: "WETH", address: WETH.address, decimals: 18 },
    state: { supplyApy: 0.013, borrowApy: 0.021, utilization: 0.62, supplyAssetsUsd: 15.01, borrowAssetsUsd: 9.38 },
  });

  it("filters to curated markets by default, widens with includeUnlisted, threads chainId into the query", async () => {
    const items = [apiMarket(`0x${"01".repeat(32)}`, true), apiMarket(`0x${"02".repeat(32)}`, false)];
    const queries: string[] = [];
    setFetchForTests(async (_url, init) => {
      queries.push(JSON.parse(String(init?.body)).query as string);
      return new Response(JSON.stringify({ data: { markets: { items } } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const curated = await morphoReads.markets({ chainId: 1 });
    expect(curated.ok).toBe(true);
    expect((curated.data as { markets: unknown[] }).markets).toHaveLength(1);
    expect(queries[0]).toContain("chainId_in: [1]");

    const all = await morphoReads.markets({ chainId: 8453, includeUnlisted: true });
    expect((all.data as { markets: unknown[] }).markets).toHaveLength(2);
    expect(queries[1]).toContain("chainId_in: [8453]");
  });

  it("falls back to the pinned per-chain on-chain set when the API is down", async () => {
    setFetchForTests(async () => {
      throw new Error("api down");
    });
    const m = marketReads();
    setRpcForTests(fakeClient({ reads: m }));
    const res = await morphoReads.markets({ chainId: 8453 });
    expect(res.ok).toBe(true);
    const data = res.data as { note: string; markets: Array<{ loan: string; borrowApy: string }> };
    expect(data.note).toContain("unreachable");
    expect(data.markets).toHaveLength(4); // Base pins 4 fallback ids
    expect(data.markets[0].loan).toBe("USDC");
    expect(Number.parseFloat(data.markets[0].borrowApy)).toBeGreaterThan(4);
  });
});

describe("market_info", () => {
  it("reads one market in depth with live liquidity and the oracle answer", async () => {
    setRpcForTests(fakeClient({ reads: marketReads() }));
    const res = await morphoReads.marketInfo({ chainId: 8453, marketId: MARKET_ID });
    expect(res.ok).toBe(true);
    const data = res.data as {
      market: string;
      lltv: string;
      availableLiquidity: string;
      utilization: string;
      oracle: { collateralPriceInLoan: string };
      loanAsset: { decimals: number };
    };
    expect(data.market).toBe("USDC / WETH");
    expect(data.lltv).toBe("77.0%");
    expect(data.availableLiquidity).toContain("400");
    expect(data.utilization).toBe("60.0%");
    expect(data.oracle.collateralPriceInLoan).toBe("300"); // $300 in USDC per 1 WETH
    expect(data.loanAsset.decimals).toBe(6);
  });

  it("404s honestly on a nonexistent market id", async () => {
    setRpcForTests(
      fakeClient({
        reads: {
          idToMarketParams: {
            loanToken: "0x0000000000000000000000000000000000000000",
            collateralToken: "0x0000000000000000000000000000000000000000",
            oracle: "0x0000000000000000000000000000000000000000",
            irm: "0x0000000000000000000000000000000000000000",
            lltv: 0n,
          },
        },
      }),
    );
    const res = await morphoReads.marketInfo({ chainId: 1, marketId: MARKET_ID });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.data).toContain("Ethereum");
  });

  it("rejects malformed market ids without touching the chain", async () => {
    const res = await morphoReads.marketInfo({ chainId: 1, marketId: "0x1234" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });
});
