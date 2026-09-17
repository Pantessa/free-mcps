/* Live smoke against real Robinhood Chain contracts + the Morpho API —
 * ZERO-SPEND by construction: reads and transaction *preparation* only,
 * calldata is never sent anywhere. Run before calling a deploy done:
 *
 *   pnpm smoke [address]
 *
 * The optional address is the probe wallet (default: vitalik.eth — expected
 * to be EMPTY on this chain, which also exercises the honest-refusal paths).
 * Verifies every registry pin: each token's decimals() on-chain, each
 * Chainlink feed's description() + freshness, Morpho market params, a live
 * tape print for every stock/ETF, a live v4 quote checked against that tape,
 * and every build path (artifact or honest refusal).
 */

import { FEED_ABI, TOKEN_ABI, readRetry, rpc } from "../lib/chain";
import { DEFAULT_LIFI_ROUTERS, buildLifiSwap, feeSplit } from "../lib/lifi";
import { morphoReads, marketParamsOf } from "../lib/morpho";
import { reads } from "../lib/reads";
import { FALLBACK_MARKET_IDS, TOKENS, USDG, resolveToken } from "../lib/registry";
import { probeV4Executability, quoteBest, swap } from "../lib/swap";
import { TAPE_MAX_AGE_MS, readStockTape, readSwapTape, swapLegOf } from "../lib/tape";
import { builds, type SendTransactionAction } from "../lib/tx";
import { humanToAtoms } from "../lib/util";

const PROBE = (process.argv[2] ?? "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045") as `0x${string}`;

let failures = 0;
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    console.log(`  ✅ ${name}${note ? ` — ${note}` : ""}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

type Result = { ok: boolean; status: number; data: unknown };
const assertRefusal = (res: Result, needle: string) => {
  assert(!res.ok, `expected an honest refusal, got ok:true`);
  assert(typeof res.data === "string" && res.data.includes(needle), `refusal text missing "${needle}": ${res.data}`);
};

async function main() {
  console.log(`\nRobinhood Chain MCP smoke — probe ${PROBE}\n`);
  const client = rpc();

  console.log("chain + registry pins");
  await check("chain_info reads a live block", async () => {
    const res = (await reads.chainInfo()) as Result;
    assert(res.ok, "chain_info failed");
    const block = (res.data as { latestBlock: string | null }).latestBlock;
    assert(block && BigInt(block) > 0n, "no live block number");
    return `block ${block}`;
  });

  for (const t of TOKENS) {
    await check(`${t.symbol} pins verify (decimals${t.feed ? " + feed" : ""})`, async () => {
      const dec = await readRetry(() => client.readContract({ address: t.address, abi: TOKEN_ABI, functionName: "decimals" }));
      assert(Number(dec) === t.decimals, `registry says ${t.decimals} decimals, chain says ${dec}`);
      if (!t.feed) return "no feed listed";
      const [description, round] = await Promise.all([
        readRetry(() => client.readContract({ address: t.feed!, abi: FEED_ABI, functionName: "description" })),
        readRetry(() => client.readContract({ address: t.feed!, abi: FEED_ABI, functionName: "latestRoundData" })),
      ]);
      // Feed branding: "Robinhood AAPL / USD", "ETH / USD", "Robinhood SGOV-USD",
      // and the one ticker mismatch CUSO → "Robinhood USO / USD".
      const expect = t.symbol === "CUSO" ? "USO" : t.symbol === "WETH" ? "ETH" : t.symbol;
      assert(description.toUpperCase().includes(expect.toUpperCase()), `feed description "${description}" doesn't mention ${expect}`);
      const [, answer, , updatedAt] = round;
      assert(answer > 0n, `feed answered ${answer}`);
      const ageH = (Date.now() / 1000 - Number(updatedAt)) / 3600;
      assert(ageH < 25, `feed is ${ageH.toFixed(1)}h old (heartbeat 24h)`);
      return `$${(Number(answer) / 1e8).toFixed(2)} (${description}, ${ageH.toFixed(1)}h old)`;
    });
  }

  console.log("\nreads");
  await check("prices board", async () => {
    const res = (await reads.prices({})) as Result;
    assert(res.ok, String(res.data));
    const priced = (res.data as { prices: Array<{ usd: number | null }> }).prices.filter((p) => p.usd != null);
    assert(priced.length >= 20, `only ${priced.length} tokens priced`);
    return `${priced.length} tokens priced`;
  });

  await check("portfolio (probe wallet)", async () => {
    const res = (await reads.portfolio({ user: PROBE })) as Result;
    assert(res.ok, String(res.data));
    const d = res.data as { kind: string; totalUsd: number; holdings: unknown[] };
    assert(d.kind === "portfolio", "missing rich-card kind");
    return `${d.holdings.length} holding(s), $${d.totalUsd}`;
  });

  await check("token_info TSLA (multiplier state)", async () => {
    const res = (await reads.tokenInfo({ token: "TSLA" })) as Result;
    assert(res.ok, String(res.data));
    const d = res.data as { price: { usd: number | null }; corporateActions?: { uiMultiplier: string } };
    assert(d.price.usd != null || d.corporateActions != null, "no price and no multiplier state");
    return `$${d.price.usd} · uiMultiplier ${d.corporateActions?.uiMultiplier ?? "n/a"}`;
  });

  console.log("\ntape parity (every stock/ETF must have a live price to check its pools against)");
  await check("Robinhood 24/7 tape prices every registry stock/ETF (Yahoo fallback)", async () => {
    const stocks = TOKENS.filter((t) => t.kind !== "money").map(swapLegOf);
    const tape = await readStockTape(stocks.map((l) => l.priceSymbol!).filter(Boolean));
    const missing = stocks.filter((l) => !l.priceSymbol || !tape.get(l.priceSymbol));
    assert(missing.length === 0, `no tape for ${missing.map((l) => l.symbol).join(", ")}`);
    const stale = stocks.filter((l) => Date.now() - tape.get(l.priceSymbol!)!.asOf > TAPE_MAX_AGE_MS);
    assert(stale.length === 0, `stale tape for ${stale.map((l) => l.symbol).join(", ")}`);
    const yahoo = stocks.filter((l) => tape.get(l.priceSymbol!)!.feed === "yahoo").map((l) => l.symbol);
    return `${stocks.length} priced${yahoo.length ? ` (Yahoo fallback: ${yahoo.join(", ")})` : ", all from Robinhood"}`;
  });

  console.log("\nMorpho");
  for (const id of FALLBACK_MARKET_IDS) {
    await check(`pinned market ${id.slice(0, 10)}… exists on-chain`, async () => {
      const params = await marketParamsOf(id);
      assert(params.loanToken !== "0x0000000000000000000000000000000000000000", "market params empty");
      return `loan ${params.loanToken.slice(0, 8)}… lltv ${(Number(params.lltv) / 1e16).toFixed(1)}%`;
    });
  }

  await check("lending_markets (API path)", async () => {
    const res = (await morphoReads.markets({ includeUnlisted: true })) as Result;
    assert(res.ok, String(res.data));
    const markets = (res.data as { markets: Array<{ loan: string }> }).markets;
    assert(markets.length >= 3, `only ${markets.length} markets`);
    return `${markets.length} markets, top loan asset ${markets[0].loan}`;
  });

  await check("lending_position (probe wallet)", async () => {
    const res = (await morphoReads.position({ user: PROBE })) as Result;
    assert(res.ok, String(res.data));
    return (res.data as { summary: string }).summary;
  });

  console.log("\ntrading (Uniswap v4)");
  await check("quote 100 USDG → AAPL (checked against the tape)", async () => {
    const res = (await swap.quote({ sellToken: "USDG", buyToken: "AAPL", amount: "100" })) as Result;
    assert(res.ok, String(res.data));
    const d = res.data as { buy?: string; poolQuote?: string; pool: { fee: string }; tapeCheck?: { status: string; deviation?: string; tape?: string; tapeFeed?: string } };
    assert(d.tapeCheck && d.tapeCheck.status !== "unavailable", `no tape check on a stock quote: ${JSON.stringify(d.tapeCheck)}`);
    return `${d.buy ?? d.poolQuote} @ pool ${d.pool.fee}, ${d.tapeCheck!.status} ${d.tapeCheck!.deviation} vs ${d.tapeCheck!.tape} (${d.tapeCheck!.tapeFeed})`;
  });

  await check("quote TSLA → USDG (sell side)", async () => {
    const res = (await swap.quote({ sellToken: "TSLA", buyToken: "USDG", amount: "1" })) as Result;
    assert(res.ok, String(res.data));
    return (res.data as { buy: string }).buy;
  });

  await check("build_swap refuses the empty probe wallet honestly", async () => {
    const res = (await swap.build({ user: PROBE, sellToken: "USDG", buyToken: "AAPL", amount: "100" })) as Result;
    assertRefusal(res, "Insufficient");
  });

  // ── LiFi settlement fallback (venue-gated stock pools) ───────────────────
  // build_swap's balance gate correctly refuses the empty probe wallet before
  // the venue logic runs, so the LiFi path is exercised through its own
  // builder here — the exact code build_swap falls through to on "gated".
  // Read-only + construction-only: nothing is signed, sent, or spent.
  for (const symbol of ["AAPL", "NVDA"] as const) {
    await check(`LiFi builds 100 USDG → ${symbol} (gated-pool settlement, fee + guard)`, async () => {
      const buy = resolveToken(symbol);
      assert(buy, `${symbol} missing from the registry`);
      const amountIn = humanToAtoms("100", 6)!;
      const best = await quoteBest(USDG, buy!.address, amountIn);
      assert(best, `no v4 quote for USDG→${symbol}`);
      const gate = await probeV4Executability(
        { poolKey: best!.poolKey, zeroForOne: best!.zeroForOne, amountIn, minOut: 1n, deadline: Math.floor(Date.now() / 1000) + 600 },
        PROBE,
      );
      const res = (await buildLifiSwap({
        user: PROBE,
        sell: resolveToken("USDG")!,
        buy: buy!,
        amount: "100",
        amountIn,
        quoterOut: best!.amountOut,
        tape: await readSwapTape(resolveToken("USDG")!, buy!),
      })) as Result;
      assert(res.ok, String(res.data));
      const d = res.data as {
        steps: SendTransactionAction[];
        fee: { bps: number; amount: string };
        guard: string;
        simulation: string;
        validUntil: string;
        buyEstimate: string;
        tapeCheck?: { status: string; deviation: string; minimum?: string };
      };
      assert(d.guard.includes("passed"), `guard did not pass: ${d.guard}`);
      assert(d.tapeCheck && d.tapeCheck.minimum, `LiFi stock build carries no tape check: ${JSON.stringify(d.tapeCheck)}`);
      const { feeAtoms } = feeSplit(amountIn);
      assert(d.fee.amount === "0.2 USDG" && feeAtoms === 200_000n, `fee should be 0.2 USDG (20 bps of 100), got ${d.fee.amount}`);
      assert(d.steps.every((s) => s.action === "send_transaction" && s.tx.chainId === 4663 && s.tx.value === "0"), "bad step shape");
      const swapStep = d.steps.find((s) => s.label.includes("via LiFi"))!;
      assert(DEFAULT_LIFI_ROUTERS.some((r) => r.toLowerCase() === swapStep.tx.to.toLowerCase()), `swap step targets non-allowlisted ${swapStep.tx.to}`);
      assert(new Date(d.validUntil).getTime() > Date.now(), "validUntil already passed");
      // the balance-less probe holds no allowance → simulation must be skipped, flagged
      assert(d.simulation.includes("skipped"), `expected skipped simulation for the empty probe, got: ${d.simulation}`);
      return `direct v4 probes ${gate}; ${d.steps.length} steps → ${d.buyEstimate}, fee ${d.fee.amount}, tape ${d.tapeCheck!.status} ${d.tapeCheck!.deviation} (min ${d.tapeCheck!.minimum}), sim ${d.simulation.split(" — ")[0]}`;
    });
  }

  console.log("\nlending builds (honest refusals on the empty probe)");
  const marketId = FALLBACK_MARKET_IDS[3]; // USDG / TSLA
  await check("build_lend refuses over-balance", async () => {
    assertRefusal((await builds.lend({ user: PROBE, marketId, amount: "1000000" })) as Result, "Insufficient");
  });
  await check("build_borrow refuses with no collateral", async () => {
    assertRefusal((await builds.borrow({ user: PROBE, marketId, amount: "10" })) as Result, "No collateral");
  });
  await check("build_repay refuses with no debt", async () => {
    assertRefusal((await builds.repay({ user: PROBE, marketId, amount: "max" })) as Result, "Nothing to repay");
  });

  console.log("\nbridge");
  await check("bridge_info", async () => {
    const res = (await builds.bridgeInfo()) as Result;
    assert(res.ok, "bridge_info failed");
  });
  await check("build_bridge_deposit builds an L1 (chainId 1) artifact", async () => {
    const res = (await builds.bridgeDeposit({ user: PROBE, amount: "0.01" })) as Result;
    assert(res.ok, String(res.data));
    const steps = (res.data as { steps: SendTransactionAction[] }).steps;
    assert(steps.length === 1 && steps[0].tx.chainId === 1, "expected one chainId-1 step");
    assert(steps.every((s) => s.action === "send_transaction"), "bad action type");
  });
  await check("build_bridge_withdraw refuses the empty probe honestly", async () => {
    assertRefusal((await builds.bridgeWithdraw({ user: PROBE, amount: "1" })) as Result, "Insufficient ETH on Robinhood Chain");
  });

  console.log(`\n${failures === 0 ? "✅ smoke clean" : `❌ ${failures} failure(s)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
