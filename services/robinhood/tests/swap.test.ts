import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { UNIVERSAL_ROUTER_ABI, setRpcForTests } from "@/lib/chain";
import { PERMIT2, UNIVERSAL_ROUTER, resolveToken } from "@/lib/registry";
import { setLifiFetchForTests } from "@/lib/lifi";
import { guardV4Build, probeV4Executability, swap, type V4SwapPlan } from "@/lib/swap";
import { setTapeFetchForTests } from "@/lib/tape";
import type { SendTransactionAction } from "@/lib/tx";
import { fakeClient, feedRound, revertWithData, type FakeCall, type FakeChainState } from "./fake-rpc";
import { fakeTape } from "./fake-tape";

const USER = "0x1111111111111111111111111111111111111111" as const;
const USDG = resolveToken("USDG")!;
const AAPL = resolveToken("AAPL")!;

/** Quoter fake: the 0.30% pool answers best, the 1% pool worse, others empty. */
const quoterSim = (c: FakeCall) => {
  const params = (c.args as [{ poolKey: { fee: number } }])[0];
  if (params.poolKey.fee === 3000) return [2n * 10n ** 18n, 100_000n]; // 2 AAPL
  if (params.poolKey.fee === 10_000) return [19n * 10n ** 17n, 100_000n]; // 1.9 AAPL
  throw new Error("no pool");
};

/** A near-empty pool, AMAT-style: 500 USDG buys 0.0151 AAPL ($33,112.58 a share). */
const brokenQuoterSim = (c: FakeCall) => {
  const params = (c.args as [{ poolKey: { fee: number } }])[0];
  if (params.poolKey.fee === 10_000) return [151n * 10n ** 14n, 100_000n];
  throw new Error("no pool");
};

function swapFake(
  opts: {
    balance?: bigint;
    erc20Allowance?: bigint;
    permit2Allowance?: [bigint, bigint, bigint];
    ethCall?: FakeChainState["ethCall"];
    quoter?: (c: FakeCall) => unknown;
  } = {},
) {
  return fakeClient({
    reads: {
      balanceOf: opts.balance ?? 1_000_000_000n, // 1000 USDG
      allowance: (c: FakeCall) =>
        c.address.toLowerCase() === PERMIT2.toLowerCase()
          ? (opts.permit2Allowance ?? [0n, 0n, 0n])
          : (opts.erc20Allowance ?? 0n),
      latestRoundData: (c: FakeCall) =>
        c.address.toLowerCase() === USDG.feed!.toLowerCase() ? feedRound(1) : feedRound(250),
    },
    simulations: { quoteExactInputSingle: opts.quoter ?? quoterSim },
    // Default probe answer: a HEALTHY pool — the SWAP action reverts WITH
    // data (CurrencyNotSettled-style), which means executable.
    ethCall:
      opts.ethCall ??
      (() => {
        throw revertWithData("0x5212cba1");
      }),
  });
}

// The quoter fixture fills 500 USDG → 2 AAPL = $250 a share; the tape agrees.
beforeEach(() => {
  fakeTape({ robinhood: { AAPL: 250 } });
});

afterEach(() => {
  setRpcForTests(null);
  setLifiFetchForTests(null);
  setTapeFetchForTests(null);
});

describe("quote", () => {
  it("scans the no-hook keys, picks the best pool, and checks a stock fill against the tape", async () => {
    setRpcForTests(swapFake());
    const res = await swap.quote({ sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    const data = res.data as { buy: string; pool: { fee: string }; tapeCheck: { status: string; fillPerShare: string; deviation: string }; feedCheck?: unknown; warning?: string };
    expect(data.buy).toContain("2 AAPL");
    expect(data.pool.fee).toBe("0.3%"); // best amountOut won, not first-hit
    // 500 USDG for 2 AAPL = $250 a share vs a $250 tape
    expect(data.tapeCheck).toMatchObject({ status: "ok", fillPerShare: "$250.00", deviation: "+0.00%" });
    expect(data.feedCheck).toBeUndefined(); // the tape is the reference for a stock pair
    expect(data.warning).toBeUndefined();
  });

  it("keeps the Chainlink cross-check for a pair with no stock, and never reads the tape", async () => {
    const urls = fakeTape({});
    setRpcForTests(
      fakeClient({
        reads: { latestRoundData: (c: FakeCall) => (c.address.toLowerCase() === USDG.feed!.toLowerCase() ? feedRound(1) : feedRound(2500)) },
        simulations: { quoteExactInputSingle: () => [2_500_000_000n, 100_000n] }, // 1 WETH → 2,500 USDG
      }),
    );
    const res = await swap.quote({ sellToken: "WETH", buyToken: "USDG", amount: "1" });
    expect(res.ok).toBe(true);
    const data = res.data as { feedCheck: { divergence: string }; tapeCheck?: unknown };
    expect(Number.parseFloat(data.feedCheck.divergence)).toBeLessThan(0.1);
    expect(data.tapeCheck).toBeUndefined();
    expect(urls).toHaveLength(0);
  });

  it("never advertises an off-tape pool's number as the stock's price", async () => {
    setRpcForTests(swapFake({ quoter: brokenQuoterSim }));
    const res = await swap.quote({ sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown> & { tapeCheck: { status: string; note: string }; warning: string; poolQuote: string };
    expect(data.offTape).toBe(true);
    expect(data.buy).toBeUndefined();
    expect(data.price).toBeUndefined();
    expect(data.poolQuote).toContain("NOT a price you can trade at");
    expect(data.tapeCheck.status).toBe("off");
    expect(data.tapeCheck.note).toBe(
      "Robinhood Chain's Uniswap v4 pool fills this AAPL buy at $33,112.58 a share — 132× Robinhood's tape ($250.00), outside the 10% bound.",
    );
    expect(data.warning).toContain("build_swap won't fill this pool");
  });

  it("marks a stock quote unchecked when the tape doesn't answer", async () => {
    fakeTape({ robinhoodStatus: 503 });
    setRpcForTests(swapFake());
    const res = await swap.quote({ sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    const data = res.data as { buy: string; tapeCheck: { status: string; note: string }; warning: string };
    expect(data.buy).toContain("(unchecked)");
    expect(data.tapeCheck).toEqual({ status: "unavailable", note: "Not checked against the tape: no AAPL quote from Robinhood's tape or Yahoo Finance." });
    expect(data.warning).toContain("UNCHECKED");
  });

  it("404s a pair no pool quotes", async () => {
    setRpcForTests(fakeClient({ simulations: { quoteExactInputSingle: () => { throw new Error("no pool"); } }, reads: {} }));
    const res = await swap.quote({ sellToken: "AAPL", buyToken: "TSLA", amount: "1" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("USDG");
  });
});

describe("build_swap", () => {
  it("builds approve→Permit2→swap with exact amounts and passes its own guard", async () => {
    setRpcForTests(swapFake());
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    const data = res.data as { steps: SendTransactionAction[]; minimumOut: string; guard: string };
    expect(data.steps).toHaveLength(3);
    expect(data.guard).toContain("passed");
    expect(data.minimumOut).toContain("1.98 AAPL"); // 2 AAPL − 1% default slippage

    // the fill and the minimum it accepts are both checked against the tape
    expect((res.data as { tapeCheck: unknown }).tapeCheck).toMatchObject({
      status: "ok",
      venue: "Robinhood Chain's Uniswap v4 pool",
      fillPerShare: "$250.00",
      minimum: "$252.53 a share (+1.01% vs the tape)",
    });

    const swapStep = data.steps[2];
    expect(swapStep.tx.to.toLowerCase()).toBe(UNIVERSAL_ROUTER.toLowerCase());
    expect(swapStep.tx.value).toBe("0");
    const dec = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: swapStep.tx.data as `0x${string}` });
    expect(dec.functionName).toBe("execute");
    expect(dec.args[0]).toBe("0x10"); // the single V4_SWAP command
  });

  it("skips approvals the live allowances already cover", async () => {
    const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
    setRpcForTests(swapFake({ erc20Allowance: 10n ** 12n, permit2Allowance: [10n ** 12n, future, 0n] }));
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect((res.data as { steps: unknown[] }).steps).toHaveLength(1);
  });

  it("builds nothing without a tape — no probe, no LiFi, no artifact", async () => {
    fakeTape({ robinhoodStatus: 503 });
    const fake = swapFake();
    setRpcForTests(fake);
    const lifiUrls: string[] = [];
    setLifiFetchForTests(async (url) => {
      lifiUrls.push(url);
      throw new Error("LiFi must not be asked");
    });
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.data).toContain("try again in a moment");
    expect(res.data).toContain("Nothing was built.");
    expect(lifiUrls).toHaveLength(0);
    expect(fake.calls.some((c) => c.functionName === "eth_call")).toBe(false);
  });

  it("builds a fill inside the warn band, with the gap named", async () => {
    // only the 1% pool quotes: 500 USDG → 1.9 AAPL = $263.16 a share, +5.26%
    setRpcForTests(
      swapFake({
        quoter: (c: FakeCall) => {
          if ((c.args as [{ poolKey: { fee: number } }])[0].poolKey.fee === 10_000) return [19n * 10n ** 17n, 100_000n];
          throw new Error("no pool");
        },
      }),
    );
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    const data = res.data as { venue: string; warning: string; tapeCheck: { status: string } };
    expect(data.venue).toContain("Uniswap v4");
    expect(data.tapeCheck.status).toBe("warn");
    expect(data.warning).toBe("This AAPL buy fills at $263.16 a share, 5.26% above Robinhood's tape ($250.00) — inside the 10% bound, but a real gap.");
  });

  it("refuses over-balance honestly", async () => {
    setRpcForTests(swapFake({ balance: 100_000_000n }));
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("Insufficient USDG");
  });
});

describe("the executability probe (venue-gated stock pools)", () => {
  const plan = (): V4SwapPlan => ({
    poolKey: {
      currency0: (USDG.address.toLowerCase() < AAPL.address.toLowerCase() ? USDG.address : AAPL.address) as `0x${string}`,
      currency1: (USDG.address.toLowerCase() < AAPL.address.toLowerCase() ? AAPL.address : USDG.address) as `0x${string}`,
      fee: 3000,
      tickSpacing: 60,
      hooks: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    },
    zeroForOne: USDG.address.toLowerCase() < AAPL.address.toLowerCase(),
    amountIn: 500_000_000n,
    minOut: 1n,
    deadline: Math.floor(Date.now() / 1000) + 600,
  });

  it("reads a data-carrying revert as executable (viem walk chain included)", async () => {
    setRpcForTests(swapFake());
    expect(await probeV4Executability(plan(), USER)).toBe("ok");

    // viem wraps the revert — the data sits on a cause reachable via walk().
    const walkErr = Object.assign(new Error("execution reverted"), {
      walk: (fn: (e: unknown) => boolean) => [{ data: "0x5212cba1" }].find(fn) ?? null,
    });
    setRpcForTests(swapFake({ ethCall: () => { throw walkErr; } }));
    expect(await probeV4Executability(plan(), USER)).toBe("ok");
  });

  it("reads a bare empty revert as gated and a transport error as unknown", async () => {
    setRpcForTests(swapFake({ ethCall: () => { throw new Error("execution reverted"); } }));
    expect(await probeV4Executability(plan(), USER)).toBe("gated");

    setRpcForTests(swapFake({ ethCall: () => { throw new Error("request timeout"); } }));
    expect(await probeV4Executability(plan(), USER)).toBe("unknown");
  });

  it("build refuses a venue-gated pool with NO artifact when LiFi can't fill either", async () => {
    // Gated pools now fall through to the LiFi settlement build
    // (tests/lifi.test.ts covers the successful fallthrough); the honest
    // refusal survives only when LiFi has no route.
    setRpcForTests(swapFake({ ethCall: () => { throw new Error("execution reverted"); } }));
    setLifiFetchForTests(async () => ({ ok: false, status: 404, json: async () => ({ message: "No available quotes for the requested transfer" }) }));
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.data).toContain("backend-signed DexAggregator");
    expect(JSON.stringify(res.data)).not.toContain("steps"); // nothing signable escaped
  });

  it("build fails OPEN when the probe hits transport trouble", async () => {
    setRpcForTests(swapFake({ ethCall: () => { throw new Error("rate limit exceeded"); } }));
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    expect((res.data as { steps: unknown[] }).steps).toHaveLength(3);
  });

  it("build probes BEFORE emitting anything — the eth_call precedes the artifact", async () => {
    const fake = swapFake();
    setRpcForTests(fake);
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    expect(fake.calls.some((c) => c.functionName === "eth_call" && c.address.toLowerCase() === UNIVERSAL_ROUTER.toLowerCase())).toBe(true);
  });
});

describe("the guard (fail-closed)", () => {
  async function builtSteps(): Promise<{ steps: SendTransactionAction[] }> {
    setRpcForTests(swapFake());
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    return res.data as { steps: SendTransactionAction[] };
  }

  const exp = (over: Partial<Parameters<typeof guardV4Build>[1]> = {}) => ({
    sellToken: USDG.address,
    buyToken: AAPL.address,
    amountIn: 500_000_000n,
    minOut: (2n * 10n ** 18n * 9900n) / 10_000n,
    poolKey: {
      currency0: (USDG.address.toLowerCase() < AAPL.address.toLowerCase() ? USDG.address : AAPL.address) as `0x${string}`,
      currency1: (USDG.address.toLowerCase() < AAPL.address.toLowerCase() ? AAPL.address : USDG.address) as `0x${string}`,
      fee: 3000,
      tickSpacing: 60,
      hooks: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    },
    permit2Expiration: 0, // overridden per test
    ...over,
  });

  it("refuses a swap addressed to a different router", async () => {
    const { steps } = await builtSteps();
    const tampered = steps.map((s, i) =>
      i === steps.length - 1 ? { ...s, tx: { ...s.tx, to: "0x000000000000000000000000000000000000dEaD" } } : s,
    );
    const verdict = guardV4Build(tampered, exp());
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("pinned Universal Router");
  });

  it("refuses when the amounts don't match the quote", async () => {
    const { steps } = await builtSteps();
    const verdict = guardV4Build(steps, exp({ amountIn: 999_000_000n }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("amount");
  });

  it("refuses native value on the swap", async () => {
    const { steps } = await builtSteps();
    const tampered = steps.map((s, i) => (i === steps.length - 1 ? { ...s, tx: { ...s.tx, value: "1" } } : s));
    const verdict = guardV4Build(tampered, exp({ amountIn: 500_000_000n }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("zero native value");
  });
});
