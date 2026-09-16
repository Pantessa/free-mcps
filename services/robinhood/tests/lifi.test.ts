// The LiFi settlement fallback: venue-gated pools fall through to a guarded
// LiFi build (fee + pinning + independent price check + simulation); healthy
// pools never touch LiFi; the honest refusal survives only when LiFi can't
// route either. All network edges are faked — no live calls.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { setRpcForTests } from "@/lib/chain";
import { PERMIT2, UNIVERSAL_ROUTER, resolveToken } from "@/lib/registry";
import {
  DEFAULT_LIFI_ROUTERS,
  DEFAULT_TREASURY,
  buildLifiSwap,
  feeSplit,
  guardLifiBuild,
  setLifiFetchForTests,
  type LifiQuote,
} from "@/lib/lifi";
import { swap } from "@/lib/swap";
import { readSwapTape, setTapeFetchForTests } from "@/lib/tape";
import type { SendTransactionAction } from "@/lib/tx";
import { fakeClient, feedRound, type FakeCall, type FakeChainState } from "./fake-rpc";
import { fakeTape } from "./fake-tape";
import { humanToAtoms, formatAtoms } from "@/lib/util";

const USER = "0x1111111111111111111111111111111111111111" as const;
const USDG = resolveToken("USDG")!;
const AAPL = resolveToken("AAPL")!;
const ROUTER = DEFAULT_LIFI_ROUTERS[0];

// quoter answers 2 AAPL out at the 0.30% pool (same fixture swap.test.ts uses)
const QUOTER_OUT = 2n * 10n ** 18n;
const quoterSim = (c: FakeCall) => {
  const params = (c.args as [{ poolKey: { fee: number } }])[0];
  if (params.poolKey.fee === 3000) return [QUOTER_OUT, 100_000n];
  throw new Error("no pool");
};

/** A gated chain: the probe's eth_call bare-reverts with EMPTY data. */
function gatedFake(opts: { erc20Allowance?: bigint; estimateGas?: FakeChainState["estimateGas"] } = {}) {
  return fakeClient({
    reads: {
      balanceOf: 1_000_000_000n, // 1000 USDG
      allowance: (c: FakeCall) =>
        c.address.toLowerCase() === PERMIT2.toLowerCase() ? [0n, 0n, 0n] : (opts.erc20Allowance ?? 0n),
      latestRoundData: (c: FakeCall) => (c.address.toLowerCase() === USDG.feed!.toLowerCase() ? feedRound(1) : feedRound(250)),
    },
    simulations: { quoteExactInputSingle: quoterSim },
    ethCall: () => {
      throw new Error("execution reverted"); // bare revert = venue-gated
    },
    estimateGas: opts.estimateGas,
  });
}

// 500 USDG in @ 20 bps → 1 USDG fee, 499 USDG swapped
const SWAP_ATOMS = 499_000_000n;
const FEE_ATOMS = 1_000_000n;
// LiFi answers within 2% of the quoter's scaled read (1.996e18 · 0.98 floor)
const GOOD_TO_AMOUNT = 199n * 10n ** 16n; // 1.99 AAPL

function lifiQuote(over: Partial<LifiQuote> = {}): LifiQuote {
  return {
    tool: "fly",
    toolDetails: { name: "Fly" },
    action: { fromToken: { address: USDG.address }, toToken: { address: AAPL.address }, fromAmount: SWAP_ATOMS.toString() },
    estimate: { toAmount: GOOD_TO_AMOUNT.toString(), toAmountMin: (198n * 10n ** 16n).toString(), approvalAddress: ROUTER },
    transactionRequest: { to: ROUTER, data: `0x${"ab".repeat(400)}`, value: "0x0", chainId: 4663 },
    ...over,
  };
}

/** Install a fake LiFi API; returns the list of URLs it was asked for. */
function fakeLifi(response: LifiQuote | { status: number; body: unknown } | Error): string[] {
  const urls: string[] = [];
  setLifiFetchForTests(async (url) => {
    urls.push(url);
    if (response instanceof Error) throw response;
    if ("status" in response && typeof response.status === "number" && "body" in response) {
      return { ok: false, status: response.status, json: async () => response.body };
    }
    return { ok: true, status: 200, json: async () => response };
  });
  return urls;
}

// The quoter fixture fills 500 USDG → 2 AAPL = $250 a share; the tape agrees.
beforeEach(() => {
  fakeTape({ robinhood: { AAPL: 250 } });
});

afterEach(() => {
  setRpcForTests(null);
  setLifiFetchForTests(null);
  setTapeFetchForTests(null);
  delete process.env.YEETFUL_SWAP_FEE_BPS;
  delete process.env.YEETFUL_TREASURY;
  delete process.env.LIFI_ROUTERS;
});

describe("fee math (feeSplit)", () => {
  it("takes 20 bps of a 6-decimal input, leaving the rest to swap", () => {
    const { feeAtoms, swapAtoms, bps } = feeSplit(humanToAtoms("500", 6)!);
    expect(bps).toBe(20);
    expect(feeAtoms).toBe(FEE_ATOMS);
    expect(swapAtoms).toBe(SWAP_ATOMS);
    expect(formatAtoms(feeAtoms, 6)).toBe("1"); // 1 USDG on 500
  });

  it("takes 20 bps of an 18-decimal input", () => {
    const { feeAtoms, swapAtoms } = feeSplit(humanToAtoms("5", 18)!);
    expect(feeAtoms).toBe(10n ** 16n); // 0.01 AAPL on 5
    expect(formatAtoms(feeAtoms, 18)).toBe("0.01");
    expect(swapAtoms + feeAtoms).toBe(5n * 10n ** 18n); // spends exactly what was asked
  });

  it("honors YEETFUL_SWAP_FEE_BPS and rejects fat-fingered values above 1%", () => {
    process.env.YEETFUL_SWAP_FEE_BPS = "50";
    expect(feeSplit(1_000_000n).feeAtoms).toBe(5_000n);
    process.env.YEETFUL_SWAP_FEE_BPS = "5000"; // 50%?! → fall back to the default
    expect(feeSplit(1_000_000n).bps).toBe(20);
  });
});

describe("gated → LiFi fallthrough (via build_swap)", () => {
  it("builds approve→LiFi swap→fee with the fee explicit in the artifact", async () => {
    setRpcForTests(gatedFake());
    const urls = fakeLifi(lifiQuote());
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    const data = res.data as {
      venue: string;
      steps: SendTransactionAction[];
      fee: { bps: number; amount: string; recipient: string };
      guard: string;
      simulation: string;
      validUntil: string;
    };
    expect(data.venue).toContain("LiFi");
    expect(data.steps).toHaveLength(3);
    expect(data.guard).toContain("passed");
    // gated (not off tape): the v4 quote still referees LiFi, and the tape checks both
    expect(res.data).toMatchObject({
      priceCheck: { v4Quoter: "1.996 AAPL for the same input" },
      tapeCheck: { status: "ok", venue: "Robinhood Chain's own settlement venue (via LiFi)", fillPerShare: "$250.75", minimum: "$252.02 a share (+0.81% vs the tape)" },
    });
    expect(data.guard).toContain("the v4 Quoter and the stock's tape");
    expect(new Date(data.validUntil).getTime()).toBeGreaterThan(Date.now());
    // quote went out for the swap leg (input minus fee), keylessly, tagged yeetful
    expect(urls[0]).toContain(`fromAmount=${SWAP_ATOMS}`);
    expect(urls[0]).toContain("integrator=yeetful");

    // fee is explicit AND decodable: exactly 1 USDG to the treasury
    expect(data.fee).toEqual(expect.objectContaining({ bps: 20, amount: "1 USDG", recipient: DEFAULT_TREASURY }));
    const feeStep = data.steps[2];
    expect(feeStep.tx.to.toLowerCase()).toBe(USDG.address.toLowerCase());
    const dec = decodeFunctionData({
      abi: [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }] as const,
      data: feeStep.tx.data as `0x${string}`,
    });
    expect((dec.args as [string, bigint])[0].toLowerCase()).toBe(DEFAULT_TREASURY.toLowerCase());
    expect((dec.args as [string, bigint])[1]).toBe(FEE_ATOMS);

    // the swap step is pinned to the allowlisted router, zero native value
    expect(data.steps[1].tx.to.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(data.steps[1].tx.value).toBe("0");
    // the approval grants EXACTLY the swap leg to the router
    const app = decodeFunctionData({
      abi: [{ name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }] as const,
      data: data.steps[0].tx.data as `0x${string}`,
    });
    expect((app.args as [string, bigint])[0].toLowerCase()).toBe(ROUTER.toLowerCase());
    expect((app.args as [string, bigint])[1]).toBe(SWAP_ATOMS);
  });

  it("a healthy pool still builds direct v4 and never calls LiFi", async () => {
    // healthy = probe revert WITH data (same as swap.test.ts's default)
    const fake = fakeClient({
      reads: {
        balanceOf: 1_000_000_000n,
        allowance: (c: FakeCall) => (c.address.toLowerCase() === PERMIT2.toLowerCase() ? [0n, 0n, 0n] : 0n),
        latestRoundData: () => feedRound(1),
      },
      simulations: { quoteExactInputSingle: quoterSim },
      ethCall: () => {
        throw Object.assign(new Error("execution reverted"), { data: "0x5212cba1" });
      },
    });
    setRpcForTests(fake);
    const urls = fakeLifi(lifiQuote());
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    expect((res.data as { venue: string }).venue).toContain("Uniswap v4");
    expect(urls).toHaveLength(0); // #14's direct-path behavior untouched
  });

  it("keeps the honest 409 when LiFi has no route either", async () => {
    setRpcForTests(gatedFake());
    fakeLifi({ status: 404, body: { message: "No available quotes for the requested transfer" } });
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.data).toContain("DexAggregator");
    expect(res.data).toContain("No available quotes");
    expect(JSON.stringify(res.data)).not.toContain("steps"); // nothing signable escaped
  });

  it("502s (not 409) when the LiFi API is unreachable", async () => {
    setRpcForTests(gatedFake());
    fakeLifi(new Error("socket hang up"));
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
  });

  it("skips the fee step when YEETFUL_SWAP_FEE_BPS=0", async () => {
    process.env.YEETFUL_SWAP_FEE_BPS = "0";
    setRpcForTests(gatedFake());
    fakeLifi(lifiQuote({ action: { fromToken: { address: USDG.address }, toToken: { address: AAPL.address }, fromAmount: "500000000" } }));
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    expect((res.data as { steps: unknown[] }).steps).toHaveLength(2); // approve + swap, no fee
  });
});

describe("the LiFi guard (fail-closed)", () => {
  const build = async () =>
    buildLifiSwap({ user: USER, sell: USDG, buy: AAPL, amount: "500", amountIn: 500_000_000n, quoterOut: QUOTER_OUT, tape: await readSwapTape(USDG, AAPL) });

  it("refuses a transaction addressed to a non-allowlisted router", async () => {
    setRpcForTests(gatedFake());
    fakeLifi(lifiQuote({ transactionRequest: { to: "0x000000000000000000000000000000000000dEaD", data: `0x${"ab".repeat(400)}`, value: "0x0", chainId: 4663 } }));
    const res = await build();
    expect(res.ok).toBe(false);
    expect(res.data).toContain("not an allowlisted LiFi router");
  });

  it("refuses an approvalAddress off the allowlist", async () => {
    setRpcForTests(gatedFake());
    fakeLifi(lifiQuote({ estimate: { toAmount: GOOD_TO_AMOUNT.toString(), toAmountMin: GOOD_TO_AMOUNT.toString(), approvalAddress: "0x000000000000000000000000000000000000dEaD" } }));
    const res = await build();
    expect(res.ok).toBe(false);
    expect(res.data).toContain("approvalAddress");
  });

  it("refuses a toAmount more than 2% below the service's own v4 Quoter read", async () => {
    setRpcForTests(gatedFake());
    // 1.94 AAPL vs 1.996 scaled quoter ≈ 2.8% worse — still inside the tape's bound
    // ($257.22 a share, +2.9%), so it's the quoter that refuses it
    const bad = (194n * 10n ** 16n).toString();
    fakeLifi(lifiQuote({ estimate: { toAmount: bad, toAmountMin: bad, approvalAddress: ROUTER } }));
    const res = await build();
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.data).toContain("below this service's own Uniswap v4 Quoter");
  });

  it("refuses when LiFi echoes different tokens or a different amount", async () => {
    setRpcForTests(gatedFake());
    fakeLifi(lifiQuote({ action: { fromToken: { address: AAPL.address }, toToken: { address: AAPL.address }, fromAmount: SWAP_ATOMS.toString() } }));
    expect(((await build()) as { ok: boolean; data: unknown }).data).toContain("different fromToken");

    fakeLifi(lifiQuote({ action: { fromToken: { address: USDG.address }, toToken: { address: AAPL.address }, fromAmount: "123" } }));
    expect(((await build()) as { ok: boolean; data: unknown }).data).toContain("different fromAmount");
  });

  it("refuses native value on the LiFi transaction", async () => {
    setRpcForTests(gatedFake());
    fakeLifi(lifiQuote({ transactionRequest: { to: ROUTER, data: `0x${"ab".repeat(400)}`, value: "0x1", chainId: 4663 } }));
    const res = await build();
    expect(res.ok).toBe(false);
    expect(res.data).toContain("native value");
  });

  it("guardLifiBuild refuses tampered fee steps", async () => {
    setRpcForTests(gatedFake());
    fakeLifi(lifiQuote());
    const res = await build();
    const steps = (res.data as { steps: SendTransactionAction[] }).steps;
    const exp = { sellToken: USDG.address, swapAtoms: SWAP_ATOMS, feeAtoms: FEE_ATOMS, treasury: DEFAULT_TREASURY, routers: DEFAULT_LIFI_ROUTERS, hasApproval: true };
    expect(guardLifiBuild(steps, exp).ok).toBe(true);

    // fee re-routed to an attacker → refuse
    const rerouted = steps.map((s, i) => (i === 2 ? { ...s, tx: { ...s.tx, data: s.tx.data.replace(DEFAULT_TREASURY.slice(2).toLowerCase(), "dead".repeat(10)) } } : s));
    expect(guardLifiBuild(rerouted, exp).ok).toBe(false);

    // fee amount inflated → refuse
    expect(guardLifiBuild(steps, { ...exp, feeAtoms: FEE_ATOMS * 2n }).ok).toBe(false);

    // wrong step count → refuse
    expect(guardLifiBuild(steps.slice(0, 2), exp).ok).toBe(false);
  });
});

describe("pre-sign simulation", () => {
  it("is skipped (flagged) when an approval is still needed", async () => {
    setRpcForTests(gatedFake({ erc20Allowance: 0n }));
    fakeLifi(lifiQuote());
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    const d = res.data as { simulation: string; warning?: string };
    expect(d.simulation).toContain("skipped");
    expect(d.warning).toBeDefined();
  });

  it("fails CLOSED when the allowance is live and the swap simulates to a revert", async () => {
    setRpcForTests(
      gatedFake({
        erc20Allowance: 10n ** 12n,
        estimateGas: () => {
          throw new Error("execution reverted");
        },
      }),
    );
    fakeLifi(lifiQuote());
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.data).toContain("REVERT");
  });

  it("fails OPEN with a warning on simulation transport trouble", async () => {
    setRpcForTests(
      gatedFake({
        erc20Allowance: 10n ** 12n,
        estimateGas: () => {
          throw new Error("socket hang up");
        },
      }),
    );
    fakeLifi(lifiQuote());
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    const d = res.data as { simulation: string; warning?: string; steps: unknown[] };
    expect(d.simulation).toContain("unavailable");
    expect(d.warning).toBeDefined();
    expect(d.steps).toHaveLength(2); // allowance already live → swap + fee, no approve
  });

  it("passes silently when the allowance is live and estimateGas succeeds", async () => {
    setRpcForTests(gatedFake({ erc20Allowance: 10n ** 12n }));
    fakeLifi(lifiQuote());
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    const d = res.data as { simulation: string; warning?: string };
    expect(d.simulation).toContain("passed");
    expect(d.warning).toBeUndefined();
  });
});

describe("tape parity: an off-tape pool falls through to LiFi", () => {
  /** A near-empty pool, AMAT-style: 500 USDG buys 0.0151 AAPL ($33,112.58 a share) — and it executes directly. */
  function brokenPoolFake(opts: { quoterOut?: bigint } = {}) {
    return fakeClient({
      reads: {
        balanceOf: 1_000_000_000n,
        allowance: (c: FakeCall) => (c.address.toLowerCase() === PERMIT2.toLowerCase() ? [0n, 0n, 0n] : 0n),
        latestRoundData: () => feedRound(1),
      },
      simulations: {
        quoteExactInputSingle: (c: FakeCall) => {
          if ((c.args as [{ poolKey: { fee: number } }])[0].poolKey.fee === 10_000) return [opts.quoterOut ?? 151n * 10n ** 14n, 100_000n];
          throw new Error("no pool");
        },
      },
      // healthy probe: this pool WOULD fill a direct Universal Router swap
      ethCall: () => {
        throw Object.assign(new Error("execution reverted"), { data: "0x5212cba1" });
      },
    });
  }
  const POOL_SENTENCE =
    "Robinhood Chain's Uniswap v4 pool fills this AAPL buy at $33,112.58 a share — 132× Robinhood's tape ($250.00), outside the 10% bound.";

  it("skips an executable pool that's off the tape and builds through LiFi, refereed by the tape", async () => {
    const fake = brokenPoolFake();
    setRpcForTests(fake);
    const urls = fakeLifi(lifiQuote());
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    const data = res.data as { venue: string; note: string; steps: SendTransactionAction[]; guard: string };
    expect(data.venue).toContain("LiFi");
    expect(urls).toHaveLength(1);
    expect(data.note).toContain(POOL_SENTENCE);
    expect(res.data).toMatchObject({
      priceCheck: {
        v4Quoter: "not used — the Uniswap v4 pool's quote is 13,145% off the tape, so it can't referee LiFi's price",
        verdict: "the stock's tape is the independent price reference (see tapeCheck)",
      },
      tapeCheck: { status: "ok", fillPerShare: "$250.75", deviation: "+0.30%" },
    });
    expect(data.guard).toContain("price cross-checked against the stock's tape");
    // the broken pool was never probed, and nothing signable targets it
    expect(fake.calls.some((c) => c.functionName === "eth_call")).toBe(false);
    expect(data.steps.some((s) => s.tx.to.toLowerCase() === UNIVERSAL_ROUTER.toLowerCase())).toBe(false);
  });

  it("refuses by name when LiFi's fill is off the tape too — nothing built", async () => {
    setRpcForTests(brokenPoolFake());
    fakeLifi(lifiQuote({ estimate: { toAmount: (5n * 10n ** 17n).toString(), toAmountMin: (49n * 10n ** 16n).toString(), approvalAddress: ROUTER } }));
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.data).toBe(
      `${POOL_SENTENCE} Robinhood Chain's own settlement venue (via LiFi) fills this AAPL buy at $998.00 a share — 4.0× Robinhood's tape ($250.00), outside the 10% bound. Nothing was built.`,
    );
    expect(JSON.stringify(res.data)).not.toContain("steps");
  });

  it("refuses naming the off-tape pool when LiFi has no route", async () => {
    setRpcForTests(brokenPoolFake());
    fakeLifi({ status: 404, body: { message: "No available quotes for the requested transfer" } });
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.data).toBe(`${POOL_SENTENCE} LiFi, the chain's own settlement venue, found no route either (No available quotes for the requested transfer). Nothing was built.`);
  });

  it("refuses when LiFi's minimum out sits off the tape, though its quote doesn't", async () => {
    setRpcForTests(gatedFake());
    fakeLifi(lifiQuote({ estimate: { toAmount: GOOD_TO_AMOUNT.toString(), toAmountMin: (10n ** 18n + 1n).toString(), approvalAddress: ROUTER } }));
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.data).toContain("the minimum the transaction accepts works out to $499.00 a share");
    expect(res.data).toContain("LiFi's own slippage sets that minimum.");
  });

  it("skips a pool whose minimum (the caller's slippage) would sign away a fill off the tape", async () => {
    // healthy 2-AAPL quote, but slippageBps 1500 lets the minimum sit at $294.12 a share (+17.6%)
    const fake = fakeClient({
      reads: {
        balanceOf: 1_000_000_000n,
        allowance: (c: FakeCall) => (c.address.toLowerCase() === PERMIT2.toLowerCase() ? [0n, 0n, 0n] : 0n),
        latestRoundData: () => feedRound(1),
      },
      simulations: { quoteExactInputSingle: quoterSim },
      ethCall: () => {
        throw Object.assign(new Error("execution reverted"), { data: "0x5212cba1" });
      },
    });
    setRpcForTests(fake);
    const urls = fakeLifi(lifiQuote());
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500", slippageBps: 1500 });
    expect(res.ok).toBe(true);
    const data = res.data as { venue: string; note: string };
    expect(urls).toHaveLength(1);
    expect(data.venue).toContain("LiFi");
    expect(data.note).toContain("the minimum the transaction accepts works out to $294.12 a share");
    expect(data.note).toContain("slippageBps 1500");
    // the quote itself was on the tape, so it still referees LiFi
    expect(res.data).toMatchObject({ priceCheck: { v4Quoter: "1.996 AAPL for the same input" } });
  });

  it("refuses a LiFi stock build handed no tape, and a build with no price reference at all", async () => {
    setRpcForTests(gatedFake());
    const urls = fakeLifi(lifiQuote());
    const noTape = await buildLifiSwap({ user: USER, sell: USDG, buy: AAPL, amount: "500", amountIn: 500_000_000n, quoterOut: QUOTER_OUT, tape: null });
    expect(noTape.ok).toBe(false);
    expect(noTape.data).toContain("wasn't checked against the tape");

    const weth = resolveToken("WETH")!;
    const noRef = await buildLifiSwap({ user: USER, sell: USDG, buy: weth, amount: "500", amountIn: 500_000_000n, quoterOut: null, tape: null });
    expect(noRef.ok).toBe(false);
    expect(noRef.data).toContain("no independent price reference");
    expect(urls).toHaveLength(0);
  });
});
