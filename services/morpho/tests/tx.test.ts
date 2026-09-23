import { afterEach, describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { MORPHO_ABI, TOKEN_ABI, setRpcForTests } from "@/lib/chain";
import { MORPHO_SINGLETON } from "@/lib/registry";
import { approveNeedsReset, builds, type SendTransactionAction } from "@/lib/tx";
import { fakeClient, type FakeCall } from "./fake-rpc";

const USER = "0x1111111111111111111111111111111111111111" as const;
const MARKET_ID = `0x${"ab".repeat(32)}`;
const USDC = { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const, symbol: "USDC", decimals: 6 };
const WETH = { address: "0x4200000000000000000000000000000000000006" as const, symbol: "WETH", decimals: 18 };

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

const USDT_MAINNET = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const;

interface MarketFakeOpts {
  /** The market's loan token (default Base USDC). Its balance/allowance ride the `usdc*` knobs. */
  loanToken?: `0x${string}`;
  usdcBalance?: bigint;
  usdcAllowance?: bigint;
  wethBalance?: bigint;
  position?: { supplyShares: bigint; borrowShares: bigint; collateral: bigint };
}

/** USDC/WETH market (1000 supplied / 600 borrowed, lltv 77%, WETH at $300). */
function marketFake(opts: MarketFakeOpts = {}) {
  const loan = (opts.loanToken ?? USDC.address).toLowerCase();
  const isUsdc = (c: FakeCall) => c.address.toLowerCase() === loan;
  return fakeClient({
    reads: {
      idToMarketParams: {
        loanToken: opts.loanToken ?? USDC.address,
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
      borrowRateView: 0n, // no drift → assertions are exact
      price: 300n * 10n ** 6n * 10n ** 18n,
      position: opts.position ?? { supplyShares: 0n, borrowShares: 0n, collateral: 0n },
      balanceOf: (c: FakeCall) => (isUsdc(c) ? (opts.usdcBalance ?? 0n) : (opts.wethBalance ?? 0n)),
      allowance: () => opts.usdcAllowance ?? 0n,
      symbol: (c: FakeCall) => (isUsdc(c) ? USDC.symbol : WETH.symbol),
      decimals: (c: FakeCall) => (isUsdc(c) ? USDC.decimals : WETH.decimals),
    },
  });
}

afterEach(() => {
  setRpcForTests(null);
});

const stepsOf = (data: unknown) => (data as { steps: SendTransactionAction[] }).steps;

describe("build_lend", () => {
  it("builds approve (exact) + supply when the allowance is short", async () => {
    setRpcForTests(marketFake({ usdcBalance: 200_000_000n, usdcAllowance: 0n }));
    const res = await builds.lend({ chainId: 8453, user: USER, marketId: MARKET_ID, amount: "100" });
    expect(res.ok).toBe(true);
    const steps = stepsOf(res.data);
    expect(steps).toHaveLength(2);

    const approve = decodeFunctionData({ abi: TOKEN_ABI, data: steps[0].tx.data as `0x${string}` });
    expect(approve.functionName).toBe("approve");
    expect(approve.args).toEqual([MORPHO_SINGLETON, 100_000_000n]); // exactly 100 USDC at 6 decimals
    expect(steps[0].tx.to.toLowerCase()).toBe(USDC.address.toLowerCase());
    expect(steps[0].tx.chainId).toBe(8453);

    const supply = decodeFunctionData({ abi: MORPHO_ABI, data: steps[1].tx.data as `0x${string}` });
    expect(supply.functionName).toBe("supply");
    expect(supply.args![1]).toBe(100_000_000n);
    expect(supply.args![3]).toBe(USER);
    expect(steps[1].tx).toMatchObject({ to: MORPHO_SINGLETON, value: "0", chainId: 8453 });
  });

  it("stamps chainId 1 on Ethereum builds (chain threading, not a constant)", async () => {
    setRpcForTests(marketFake({ usdcBalance: 200_000_000n, usdcAllowance: 500_000_000n }));
    const res = await builds.lend({ chainId: 1, user: USER, marketId: MARKET_ID, amount: "100" });
    expect(res.ok).toBe(true);
    expect((res.data as { chain: string }).chain).toBe("Ethereum");
    expect(stepsOf(res.data)[0].tx.chainId).toBe(1);
  });

  it("skips the approve step when the live allowance covers it", async () => {
    setRpcForTests(marketFake({ usdcBalance: 200_000_000n, usdcAllowance: 500_000_000n }));
    const res = await builds.lend({ chainId: 8453, user: USER, marketId: MARKET_ID, amount: "100" });
    expect(stepsOf(res.data)).toHaveLength(1);
  });

  // Ethereum USDT's approve() reverts on a non-zero → non-zero change. A
  // repay-max approve leaves dust behind, so a partial allowance is ordinary.
  const approveArgs = (s: SendTransactionAction) => decodeFunctionData({ abi: TOKEN_ABI, data: s.tx.data as `0x${string}` }).args;
  it("USDT on Ethereum, partial allowance: reset to zero, then the exact approve, then the supply", async () => {
    setRpcForTests(marketFake({ loanToken: USDT_MAINNET, usdcBalance: 200_000_000n, usdcAllowance: 10_000_000n }));
    const res = await builds.lend({ chainId: 1, user: USER, marketId: MARKET_ID, amount: "100" });
    expect(res.ok).toBe(true);
    const steps = stepsOf(res.data);
    expect(steps).toHaveLength(3);
    expect(approveArgs(steps[0])).toEqual([MORPHO_SINGLETON, 0n]);
    expect(approveArgs(steps[1])).toEqual([MORPHO_SINGLETON, 100_000_000n]);
    for (const s of steps.slice(0, 2)) expect(s.tx).toMatchObject({ to: USDT_MAINNET, value: "0", chainId: 1 });
    expect(decodeFunctionData({ abi: MORPHO_ABI, data: steps[2].tx.data as `0x${string}` }).functionName).toBe("supply");
  });

  it("USDT on Ethereum, no allowance: one exact approve; enough allowance: none", async () => {
    setRpcForTests(marketFake({ loanToken: USDT_MAINNET, usdcBalance: 200_000_000n, usdcAllowance: 0n }));
    const none = stepsOf((await builds.lend({ chainId: 1, user: USER, marketId: MARKET_ID, amount: "100" })).data);
    expect(none).toHaveLength(2);
    expect(approveArgs(none[0])).toEqual([MORPHO_SINGLETON, 100_000_000n]);
    setRpcForTests(marketFake({ loanToken: USDT_MAINNET, usdcBalance: 200_000_000n, usdcAllowance: 100_000_000n }));
    expect(stepsOf((await builds.lend({ chainId: 1, user: USER, marketId: MARKET_ID, amount: "100" })).data)).toHaveLength(1);
  });

  it("an ordinary token with a partial allowance still gets ONE approve (no reset)", async () => {
    setRpcForTests(marketFake({ usdcBalance: 200_000_000n, usdcAllowance: 10_000_000n }));
    const steps = stepsOf((await builds.lend({ chainId: 8453, user: USER, marketId: MARKET_ID, amount: "100" })).data);
    expect(steps).toHaveLength(2);
    expect(approveArgs(steps[0])).toEqual([MORPHO_SINGLETON, 100_000_000n]);
    // The reset set is keyed by chain: the mainnet USDT address on Base is just another token.
    expect(approveNeedsReset(8453, USDT_MAINNET)).toBe(false);
    expect(approveNeedsReset(1, USDT_MAINNET.toLowerCase())).toBe(true);
  });

  it("refuses over-balance honestly", async () => {
    setRpcForTests(marketFake({ usdcBalance: 50_000_000n }));
    const res = await builds.lend({ chainId: 8453, user: USER, marketId: MARKET_ID, amount: "100" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("Insufficient USDC");
    expect(res.data).toContain("Nothing was built");
  });

  it("404s on a market that doesn't exist on the requested chain", async () => {
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
    const res = await builds.lend({ chainId: 1, user: USER, marketId: MARKET_ID, amount: "100" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.data).toContain("Ethereum");
  });
});

describe("build_borrow (fails closed on health)", () => {
  const withCollateral = { supplyShares: 0n, borrowShares: 0n, collateral: 10n ** 18n }; // 1 WETH = $300

  it("refuses with no collateral posted", async () => {
    setRpcForTests(marketFake({}));
    const res = await builds.borrow({ chainId: 8453, user: USER, marketId: MARKET_ID, amount: "50" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("No collateral");
  });

  it("refuses a borrow beyond the collateral's power", async () => {
    setRpcForTests(marketFake({ position: withCollateral }));
    // max borrow = 300 × 0.77 = 231 USDC
    const res = await builds.borrow({ chainId: 8453, user: USER, marketId: MARKET_ID, amount: "250" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("borrowing power");
  });

  it("builds a safe borrow with the health factor stated", async () => {
    setRpcForTests(marketFake({ position: withCollateral }));
    const res = await builds.borrow({ chainId: 8453, user: USER, marketId: MARKET_ID, amount: "50" });
    expect(res.ok).toBe(true);
    const data = res.data as { healthFactorAfter: number; steps: SendTransactionAction[] };
    expect(data.healthFactorAfter).toBeCloseTo(4.62, 1); // 231 / 50
    const borrow = decodeFunctionData({ abi: MORPHO_ABI, data: data.steps[0].tx.data as `0x${string}` });
    expect(borrow.functionName).toBe("borrow");
    expect(borrow.args![1]).toBe(50_000_000n);
    expect(borrow.args![4]).toBe(USER); // receiver is the user, always
  });
});

describe("build_repay / build_withdraw ('max' = shares mode)", () => {
  const withDebt = { supplyShares: 0n, borrowShares: 100_000_000n * 10n ** 6n, collateral: 10n ** 18n };

  it("repays 'max' by shares so the debt clears exactly", async () => {
    setRpcForTests(marketFake({ position: withDebt, usdcBalance: 200_000_000n }));
    const res = await builds.repay({ chainId: 8453, user: USER, marketId: MARKET_ID, amount: "max" });
    expect(res.ok).toBe(true);
    const steps = stepsOf(res.data);
    const repay = decodeFunctionData({ abi: MORPHO_ABI, data: steps[steps.length - 1].tx.data as `0x${string}` });
    expect(repay.functionName).toBe("repay");
    expect(repay.args![1]).toBe(0n); // assets 0…
    expect(repay.args![2]).toBe(withDebt.borrowShares); // …shares exact
  });

  it("refuses a partial repay above the live debt", async () => {
    setRpcForTests(marketFake({ position: withDebt, usdcBalance: 500_000_000n }));
    const res = await builds.repay({ chainId: 8453, user: USER, marketId: MARKET_ID, amount: "150" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("exceeds the current debt");
  });

  it("withdraws 'max' supplied assets by shares", async () => {
    setRpcForTests(marketFake({ position: { supplyShares: 100_000_000n * 10n ** 6n, borrowShares: 0n, collateral: 0n } }));
    const res = await builds.withdraw({ chainId: 8453, user: USER, marketId: MARKET_ID, amount: "max" });
    expect(res.ok).toBe(true);
    const withdraw = decodeFunctionData({ abi: MORPHO_ABI, data: stepsOf(res.data)[0].tx.data as `0x${string}` });
    expect(withdraw.functionName).toBe("withdraw");
    expect(withdraw.args![1]).toBe(0n);
    expect(withdraw.args![2]).toBe(100_000_000n * 10n ** 6n);
  });

  it("refuses withdrawing collateral out from under a debt", async () => {
    setRpcForTests(marketFake({ position: withDebt }));
    const res = await builds.withdrawCollateral({ chainId: 8453, user: USER, marketId: MARKET_ID, amount: "max" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("under-collateralized");
  });
});
