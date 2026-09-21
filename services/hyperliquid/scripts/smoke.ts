// Live smoke against the real Hyperliquid API (read-only, zero spend).
// Usage: pnpm smoke [address]
// Verifies: markets, spot resolution, prices, orderbook, candles, funding,
// portfolio/open_orders/fills for an address, and a short await_settlement
// (times out unless the address trades within the window — that's expected).
import { queries, resolveCoin } from "../lib/hyperliquid";
import { awaitSettlement } from "../lib/watch";

// Default probe address: the HLP vault (public, always exists).
const USER = process.argv[2] ?? "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
// A wallet running in unified-account mode (perp collateral held in spot USDC)
// — the shape `withdrawableUsd` alone gets wrong. Override with argv[3].
const UNIFIED_USER = process.argv[3] ?? "0x66268791b55e1f5fa585d990326519f101407257";

let failures = 0;

async function check(name: string, fn: () => Promise<{ pass: boolean; detail: string }>) {
  try {
    const { pass, detail } = await fn();
    console.log(`${pass ? "✅" : "❌"} ${name} — ${detail}`);
    if (!pass) failures++;
  } catch (e) {
    console.log(`❌ ${name} — threw: ${e instanceof Error ? e.message : String(e)}`);
    failures++;
  }
}

const dig = <T,>(r: { ok: boolean; data: unknown }): T => r.data as T;

async function main() {
  await check("markets (top by volume)", async () => {
    const r = await queries.perpMarkets({ first: 5 });
    const m = dig<{ markets: { coin: string; markPx: string }[] }>(r).markets;
    return { pass: r.ok && m.length === 5 && !!m[0]!.markPx, detail: m.map((x) => `${x.coin}@${x.markPx}`).join(" ") };
  });

  await check("coin resolution (HYPE)", async () => {
    const resolved = await resolveCoin("HYPE");
    return { pass: resolved !== null, detail: JSON.stringify(resolved) };
  });

  await check("prices (BTC,ETH,PURR)", async () => {
    const r = await queries.prices({ coins: ["BTC", "ETH", "PURR"] });
    const mids = dig<{ mids: Record<string, string | null> }>(r).mids;
    return { pass: r.ok && Object.values(mids).filter(Boolean).length >= 2, detail: JSON.stringify(mids) };
  });

  await check("orderbook (ETH)", async () => {
    const r = await queries.orderbook({ coin: "ETH", depth: 3 });
    const b = dig<{ bestBid: string; bestAsk: string; spreadPct: number }>(r);
    return { pass: r.ok && Number(b.bestAsk) > Number(b.bestBid), detail: `bid ${b.bestBid} / ask ${b.bestAsk} (spread ${b.spreadPct}%)` };
  });

  await check("candles (BTC 1h × 6h)", async () => {
    const r = await queries.candles({ coin: "BTC", interval: "1h", hoursBack: 6 });
    const c = dig<{ candles: unknown[] }>(r).candles;
    return { pass: r.ok && c.length >= 5, detail: `${c.length} candles` };
  });

  await check("funding (ETH + predicted venues)", async () => {
    const r = await queries.funding({ coin: "ETH", hoursBack: 12 });
    const d = dig<{ history: unknown[]; predictedByVenue: unknown[] | null }>(r);
    return { pass: r.ok && d.history.length > 0, detail: `${d.history.length} hourly points, predicted: ${d.predictedByVenue ? "yes" : "no"}` };
  });

  await check(`portfolio (${USER.slice(0, 10)}…)`, async () => {
    const r = await queries.portfolio({ user: USER });
    const d = dig<{
      accountMode: string | null;
      perp: { accountValueUsd: string | null; withdrawableUsd: string | null; availableToTradeUsd: string; positions: unknown[] };
    }>(r);
    // availableToTradeUsd is the honest collateral figure — on a unified
    // account withdrawableUsd reads ~0 while the account is fully funded.
    const available = Number(d.perp.availableToTradeUsd);
    return {
      pass: r.ok && d.perp.accountValueUsd !== null && Number.isFinite(available) && available >= Number(d.perp.withdrawableUsd ?? 0),
      detail: `accountValue $${d.perp.accountValueUsd}, ${d.perp.positions.length} positions, mode=${d.accountMode}, withdrawable $${d.perp.withdrawableUsd} → available $${d.perp.availableToTradeUsd}`,
    };
  });

  await check(`unified-account collateral (${UNIFIED_USER.slice(0, 10)}…)`, async () => {
    // A wallet observed in unified mode on 2026-09-21. If it ever leaves that
    // mode the check still passes (the invariant holds in every mode) — the
    // printed detail is what tells you which path was exercised.
    const r = await queries.portfolio({ user: UNIFIED_USER });
    const d = dig<{ accountMode: string | null; perp: { withdrawableUsd: string | null; availableToTradeUsd: string; collateralNote?: string } }>(r);
    const available = Number(d.perp.availableToTradeUsd);
    const withdrawable = Number(d.perp.withdrawableUsd ?? 0);
    // Invariant in every mode: available ≥ withdrawable, and whenever spot is
    // doing the backing the payload must say so.
    const noteWhenNeeded = available <= withdrawable || !!d.perp.collateralNote;
    return {
      pass: r.ok && Number.isFinite(available) && available >= withdrawable && noteWhenNeeded,
      detail: `mode=${d.accountMode}, withdrawable $${d.perp.withdrawableUsd} → available $${d.perp.availableToTradeUsd}${d.perp.collateralNote ? " (+note)" : ""}`,
    };
  });

  await check("open_orders + fills", async () => {
    const [o, f] = await Promise.all([queries.openOrders({ user: USER }), queries.fills({ user: USER, first: 3 })]);
    const oc = dig<{ count: number }>(o).count;
    const fc = dig<{ totalReturned: number }>(f).totalReturned;
    return { pass: o.ok && f.ok, detail: `${oc} open orders, ${fc} recent fills` };
  });

  await check("await_settlement (5s watch — timeout is the expected pass)", async () => {
    const r = await awaitSettlement({ user: USER, timeoutSeconds: 5 });
    return {
      pass: r.outcome === "timeout" || r.outcome === "fill",
      detail: `outcome=${r.outcome} after ${r.elapsedMs}ms (WS subscribe + wait worked)`,
    };
  });

  console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
