/* Live smoke against the real Morpho singleton on Ethereum + Base and the
 * Blue API — ZERO-SPEND by construction: reads and transaction
 * *preparation* only, calldata is never sent anywhere. Run before calling
 * a deploy done:
 *
 *   pnpm smoke [address]
 *
 * The optional address is the probe wallet (default: vitalik.eth — its
 * position is reported as found; the refusal probes use amounts no wallet
 * holds, so they stay deterministic). Verifies every registry pin: the
 * singleton + each pinned default market id resolves live on BOTH chains,
 * market_info numbers make sense, and every build path answers with an
 * artifact or an honest refusal.
 */

import { MORPHO_ABI, TOKEN_ABI, readRetry, rpcFor } from "../lib/chain";
import { morphoReads } from "../lib/morpho";
import { MORPHO_BY_CHAIN, SUPPORTED_CHAIN_IDS, type SupportedChainId } from "../lib/registry";
import { builds, preview } from "../lib/tx";

const PROBE = (process.argv[2] ?? "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045") as `0x${string}`;
const EMPTY = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const ABSURD = "500000000000"; // an amount no wallet holds → deterministic refusals

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
  assert(!res.ok, "expected an honest refusal, got ok:true");
  assert(typeof res.data === "string" && res.data.includes(needle), `refusal text missing "${needle}": ${res.data}`);
};

async function chainChecks(chainId: SupportedChainId) {
  const chain = MORPHO_BY_CHAIN[chainId];
  console.log(`\n${chain.name} (${chainId})`);
  const client = rpcFor(chainId);

  await check("chain reads a live block", async () => {
    const block = await readRetry(() => client.getBlockNumber());
    assert(block > 0n, "no live block number");
    return `block ${block}`;
  });

  for (const id of chain.defaultMarketIds) {
    await check(`pinned market ${id.slice(0, 10)}… resolves on-chain`, async () => {
      const p = await readRetry(() =>
        client.readContract({ address: chain.morpho, abi: MORPHO_ABI, functionName: "idToMarketParams", args: [id] }),
      );
      assert(p.loanToken !== "0x0000000000000000000000000000000000000000", "loanToken is zero — id not live on this chain");
      const [loanSym, loanDec] = await Promise.all([
        readRetry(() => client.readContract({ address: p.loanToken, abi: TOKEN_ABI, functionName: "symbol" })),
        readRetry(() => client.readContract({ address: p.loanToken, abi: TOKEN_ABI, functionName: "decimals" })),
      ]);
      return `${loanSym} loan (${loanDec} dec), lltv ${(Number(p.lltv) / 1e16).toFixed(0)}%`;
    });
  }

  await check("markets (Blue API, curated)", async () => {
    const res = (await morphoReads.markets({ chainId })) as Result;
    assert(res.ok, `markets failed: ${JSON.stringify(res.data)}`);
    const d = res.data as { markets: Array<{ loan: string; collateral: string; supplyApy: string | null }>; note: string };
    assert(d.markets.length >= 1, "no curated markets returned");
    return `${d.markets.length} markets, top: ${d.markets[0].loan}/${d.markets[0].collateral} @ ${d.markets[0].supplyApy}`;
  });

  await check("market_info on the top pinned market", async () => {
    const res = (await morphoReads.marketInfo({ chainId, marketId: chain.defaultMarketIds[0] })) as Result;
    assert(res.ok, `market_info failed: ${JSON.stringify(res.data)}`);
    const d = res.data as { market: string; availableLiquidity: string; borrowApy: string; loanAsset: { decimals: number } };
    assert(d.loanAsset.decimals > 0 && d.loanAsset.decimals <= 18, `weird loan decimals ${d.loanAsset.decimals}`);
    return `${d.market}, ${d.availableLiquidity} free, borrow ${d.borrowApy}`;
  });

  await check("market_info 404s honestly on a junk id", async () => {
    const res = (await morphoReads.marketInfo({ chainId, marketId: `0x${"ab".repeat(32)}` })) as Result;
    assertRefusal(res, "No Morpho market");
  });

  await check(`position for probe ${PROBE.slice(0, 8)}…`, async () => {
    const res = (await morphoReads.position({ chainId, user: PROBE })) as Result;
    assert(res.ok, `position failed: ${JSON.stringify(res.data)}`);
    const d = res.data as { positions: unknown[]; marketDiscovery: string };
    return `${d.positions.length} position(s), discovery: ${d.marketDiscovery.split(" ")[0]}`;
  });

  await check("build_lend refuses an absurd amount honestly", async () => {
    const res = (await builds.lend({ chainId, user: PROBE, marketId: chain.defaultMarketIds[0], amount: ABSURD })) as Result;
    assertRefusal(res, "Nothing was built");
  });

  await check("build_borrow refuses with no collateral posted", async () => {
    const res = (await builds.borrow({ chainId, user: EMPTY, marketId: chain.defaultMarketIds[0], amount: "50" })) as Result;
    assertRefusal(res, "No collateral");
  });

  await check("build_repay refuses with no debt", async () => {
    const res = (await builds.repay({ chainId, user: EMPTY, marketId: chain.defaultMarketIds[0], amount: "max" })) as Result;
    assertRefusal(res, "Nothing to repay");
  });

  await check("preview borrow simulates without building", async () => {
    const res = (await preview({ chainId, user: EMPTY, marketId: chain.defaultMarketIds[0], action: "borrow", amount: "50" })) as Result;
    assert(res.ok, `preview failed: ${JSON.stringify(res.data)}`);
    const d = res.data as { position: { after: { healthFactor: string } }; warnings?: string[]; note: string };
    assert(d.note.includes("nothing was built") || d.note.includes("Nothing was built") || d.note.includes("Simulation only"), "preview note missing");
    assert((d.warnings ?? []).length >= 1, "borrow-with-no-collateral preview should warn"); // HF < 1
    return `HF after: ${d.position.after.healthFactor}, ${d.warnings!.length} warning(s)`;
  });
}

async function main() {
  console.log(`\nMorpho MCP smoke — probe ${PROBE}`);
  for (const chainId of SUPPORTED_CHAIN_IDS) await chainChecks(chainId);
  console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll smoke checks passed — nothing signed, nothing spent.\n");
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
