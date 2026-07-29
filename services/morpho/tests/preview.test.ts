import { afterEach, describe, expect, it } from "vitest";
import { setRpcForTests } from "@/lib/chain";
import { preview } from "@/lib/tx";
import { fakeClient, type FakeCall } from "./fake-rpc";

const USER = "0x1111111111111111111111111111111111111111" as const;
const MARKET_ID = `0x${"ab".repeat(32)}`;
const USDC = { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const, symbol: "USDC", decimals: 6 };
const WETH = { address: "0x4200000000000000000000000000000000000006" as const, symbol: "WETH", decimals: 18 };

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const isUsdc = (c: FakeCall) => c.address.toLowerCase() === USDC.address.toLowerCase();

/** USDC/WETH market (lltv 77%, WETH at $300, zero-rate so numbers are exact). */
function marketFake(position: { supplyShares: bigint; borrowShares: bigint; collateral: bigint }) {
  return fakeClient({
    reads: {
      idToMarketParams: {
        loanToken: USDC.address,
        collateralToken: WETH.address,
        oracle: "0x00000000000000000000000000000000000000A1",
        irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
        lltv: 770_000_000_000_000_000n,
      },
      market: {
        totalSupplyAssets: 1_000_000_000n,
        totalSupplyShares: 1_000_000_000n * 10n ** 6n,
        totalBorrowAssets: 600_000_000n,
        totalBorrowShares: 600_000_000n * 10n ** 6n,
        lastUpdate: nowSec(),
        fee: 0n,
      },
      borrowRateView: 0n,
      price: 300n * 10n ** 6n * 10n ** 18n,
      position,
      symbol: (c: FakeCall) => (isUsdc(c) ? USDC.symbol : WETH.symbol),
      decimals: (c: FakeCall) => (isUsdc(c) ? USDC.decimals : WETH.decimals),
    },
  });
}

afterEach(() => {
  setRpcForTests(null);
});

type PreviewData = {
  position: {
    before: { healthFactor: string; debt: string };
    after: { healthFactor: string; debt: string; collateral: string; borrowingPower?: { maxBorrow: string; remaining: string } };
  };
  warnings?: string[];
};

describe("preview (local HF simulation — nothing built)", () => {
  it("simulates a borrow: HF from ∞ to the exact ratio, borrowing power stated", async () => {
    // 1 WETH collateral, no debt → borrow 50 USDC → HF = 231/50 = 4.62
    setRpcForTests(marketFake({ supplyShares: 0n, borrowShares: 0n, collateral: 10n ** 18n }));
    const res = await preview({ chainId: 8453, user: USER, marketId: MARKET_ID, action: "borrow", amount: "50" });
    expect(res.ok).toBe(true);
    const d = res.data as PreviewData;
    expect(d.position.before.healthFactor).toBe("∞ (no debt)");
    expect(Number(d.position.after.healthFactor)).toBeCloseTo(4.62, 1);
    expect(Number(d.position.after.borrowingPower!.maxBorrow)).toBeCloseTo(231, 0);
    expect(Number(d.position.after.borrowingPower!.remaining)).toBeCloseTo(181, 0);
    expect(d.warnings).toBeUndefined();
  });

  it("warns when a collateral withdrawal would leave the debt liquidatable", async () => {
    // 1 WETH collateral, 100 USDC debt → withdrawing 0.9 WETH leaves maxBorrow 23.1 < 100
    setRpcForTests(marketFake({ supplyShares: 0n, borrowShares: 100_000_000n * 10n ** 6n, collateral: 10n ** 18n }));
    const res = await preview({ chainId: 8453, user: USER, marketId: MARKET_ID, action: "withdraw_collateral", amount: "0.9" });
    expect(res.ok).toBe(true);
    const d = res.data as PreviewData;
    expect(Number(d.position.after.healthFactor)).toBeLessThan(1);
    expect(d.warnings!.join(" ")).toContain("UNDER 1");
  });

  it("shows a full repay clearing the debt to ∞", async () => {
    setRpcForTests(marketFake({ supplyShares: 0n, borrowShares: 100_000_000n * 10n ** 6n, collateral: 10n ** 18n }));
    const res = await preview({ chainId: 8453, user: USER, marketId: MARKET_ID, action: "repay", amount: "max" });
    expect(res.ok).toBe(true);
    const d = res.data as PreviewData;
    expect(d.position.after.debt).toBe("0 USDC");
    expect(d.position.after.healthFactor).toBe("∞ (no debt)");
  });

  it("rejects 'max' for actions that add exposure", async () => {
    setRpcForTests(marketFake({ supplyShares: 0n, borrowShares: 0n, collateral: 10n ** 18n }));
    const res = await preview({ chainId: 8453, user: USER, marketId: MARKET_ID, action: "borrow", amount: "max" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain('"max" only applies');
  });

  it("refuses to simulate blind when the oracle answers nothing", async () => {
    // A throwing price handler → oraclePriceOf catches → null → refusal.
    setRpcForTests(
      fakeClient({
        reads: {
          idToMarketParams: {
            loanToken: USDC.address,
            collateralToken: WETH.address,
            oracle: "0x00000000000000000000000000000000000000A1",
            irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
            lltv: 770_000_000_000_000_000n,
          },
          market: {
            totalSupplyAssets: 1_000_000_000n,
            totalSupplyShares: 1_000_000_000n * 10n ** 6n,
            totalBorrowAssets: 600_000_000n,
            totalBorrowShares: 600_000_000n * 10n ** 6n,
            lastUpdate: nowSec(),
            fee: 0n,
          },
          borrowRateView: 0n,
          price: () => {
            throw new Error("oracle dead");
          },
          position: { supplyShares: 0n, borrowShares: 0n, collateral: 10n ** 18n },
          symbol: (c: FakeCall) => (isUsdc(c) ? USDC.symbol : WETH.symbol),
          decimals: (c: FakeCall) => (isUsdc(c) ? USDC.decimals : WETH.decimals),
        },
      }),
    );
    const res = await preview({ chainId: 8453, user: USER, marketId: MARKET_ID, action: "borrow", amount: "50" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("oracle returned no price");
  });
});
