// ─────────────────────────────────────────────────────────────────────────
//  Morpho (Blue) on Ethereum + Base — market discovery, position views, and
//  the exact share/interest math the builders reuse. Ported from
//  services/robinhood/lib/morpho.ts with chainId threaded everywhere (the
//  4663 sibling stays where it is — different core deployment). Discovery
//  is API-first (blue-api.morpho.org knows every market + curated `listed`
//  flags + USD figures) and falls back to the pinned per-chain market scan
//  when the API is down, so `position` never dies with the API. Position
//  numbers are ALWAYS computed from on-chain state (position/market/oracle
//  reads), never trusted from the API.
//
//  Math mirrors morpho-blue's libraries:
//    · SharesMathLib — virtual shares/assets (1e6 / 1) on both sides
//    · wTaylorCompounded — 3-term Taylor e^(rate·t)-1 for pending interest
//    · health: collateral × oraclePrice / 1e36 × lltv ≥ borrowed
// ─────────────────────────────────────────────────────────────────────────

import { IRM_ABI, MORPHO_ABI, MORPHO_ORACLE_ABI, TOKEN_ABI, readRetry, rpcFor } from "./chain";
import { MORPHO_API, MORPHO_BY_CHAIN, type Address, type SupportedChainId } from "./registry";
import { fail, formatAtoms, ok, type MorphoResult } from "./util";

export interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface MarketState {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
}

const WAD = 10n ** 18n;
/** Morpho oracle price scale: collateralAtoms × price / 1e36 = loanAtoms. */
export const ORACLE_PRICE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;
const SECONDS_PER_YEAR = 31_536_000;

// ── SharesMathLib ──────────────────────────────────────────────────────────

export const toAssetsDown = (shares: bigint, totalAssets: bigint, totalShares: bigint): bigint =>
  (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);

export const toAssetsUp = (shares: bigint, totalAssets: bigint, totalShares: bigint): bigint => {
  const denom = totalShares + VIRTUAL_SHARES;
  return (shares * (totalAssets + VIRTUAL_ASSETS) + denom - 1n) / denom;
};

// ── Interest accrual (wTaylorCompounded) ───────────────────────────────────

/**
 * Roll a market's totals forward from lastUpdate to `nowSec` at the IRM's
 * per-second rate — the same 3-term Taylor morpho-blue accrues with, so
 * debts read here match what a transaction would settle.
 */
export function accrueMarket(market: MarketState, borrowRatePerSecWad: bigint, nowSec: number): MarketState {
  const elapsed = BigInt(Math.max(0, Math.floor(nowSec) - Number(market.lastUpdate)));
  if (elapsed === 0n || market.totalBorrowAssets === 0n || borrowRatePerSecWad === 0n) return market;
  const x = borrowRatePerSecWad * elapsed;
  const second = (x * x) / WAD / 2n;
  const third = (second * x) / WAD / 3n;
  const interest = (market.totalBorrowAssets * (x + second + third)) / WAD;
  const feeAmount = (interest * market.fee) / WAD;
  return {
    ...market,
    totalBorrowAssets: market.totalBorrowAssets + interest,
    totalSupplyAssets: market.totalSupplyAssets + interest - feeAmount,
  };
}

export const borrowApyFromRate = (ratePerSecWad: bigint): number =>
  Math.expm1((Number(ratePerSecWad) / 1e18) * SECONDS_PER_YEAR);

// ── On-chain reads ─────────────────────────────────────────────────────────

/** Symbol + decimals read live per asset — 6-dec stables, 8-dec WBTC, never assume 18. */
export async function assetMeta(chainId: SupportedChainId, address: Address): Promise<{ symbol: string; decimals: number }> {
  const client = rpcFor(chainId);
  const [symbol, decimals] = await Promise.all([
    readRetry(() => client.readContract({ address, abi: TOKEN_ABI, functionName: "symbol" })).catch(() => "?"),
    readRetry(() => client.readContract({ address, abi: TOKEN_ABI, functionName: "decimals" })).catch(() => 18),
  ]);
  return { symbol, decimals: Number(decimals) };
}

export async function marketParamsOf(chainId: SupportedChainId, marketId: `0x${string}`): Promise<MarketParams> {
  const p = await readRetry(() =>
    rpcFor(chainId).readContract({ address: MORPHO_BY_CHAIN[chainId].morpho, abi: MORPHO_ABI, functionName: "idToMarketParams", args: [marketId] }),
  );
  return { loanToken: p.loanToken, collateralToken: p.collateralToken, oracle: p.oracle, irm: p.irm, lltv: p.lltv };
}

export async function marketStateOf(chainId: SupportedChainId, marketId: `0x${string}`): Promise<MarketState> {
  const m = await readRetry(() =>
    rpcFor(chainId).readContract({ address: MORPHO_BY_CHAIN[chainId].morpho, abi: MORPHO_ABI, functionName: "market", args: [marketId] }),
  );
  return {
    totalSupplyAssets: m.totalSupplyAssets,
    totalSupplyShares: m.totalSupplyShares,
    totalBorrowAssets: m.totalBorrowAssets,
    totalBorrowShares: m.totalBorrowShares,
    lastUpdate: m.lastUpdate,
    fee: m.fee,
  };
}

export async function borrowRateOf(chainId: SupportedChainId, params: MarketParams, market: MarketState): Promise<bigint> {
  if (params.irm === "0x0000000000000000000000000000000000000000") return 0n;
  return readRetry(() =>
    rpcFor(chainId).readContract({
      address: params.irm,
      abi: IRM_ABI,
      functionName: "borrowRateView",
      args: [params, market],
    }),
  );
}

export async function oraclePriceOf(chainId: SupportedChainId, params: MarketParams): Promise<bigint | null> {
  if (params.oracle === "0x0000000000000000000000000000000000000000") return null;
  try {
    return await readRetry(() =>
      rpcFor(chainId).readContract({ address: params.oracle, abi: MORPHO_ORACLE_ABI, functionName: "price" }),
    );
  } catch {
    return null;
  }
}

// ── Morpho API (discovery only — fail-soft) ────────────────────────────────

export interface ApiMarket {
  marketId: `0x${string}`;
  listed: boolean;
  lltv: string;
  loanAsset: { symbol: string; address: Address; decimals: number } | null;
  collateralAsset: { symbol: string; address: Address; decimals: number } | null;
  state: { supplyApy: number; borrowApy: number; utilization: number; supplyAssetsUsd: number | null; borrowAssetsUsd: number | null } | null;
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);
/** Test seam. */
export function setFetchForTests(fake: FetchLike | null) {
  fetchImpl = fake ?? ((...args) => fetch(...args));
}

// Ordered by TVL desc — unlike 4663, Base/Ethereum carry THOUSANDS of
// permissionless markets, so an unordered first-100 page would bury the
// curated ones (live-observed: 3 listed markets on Base unordered vs 20+
// ordered). The 100 biggest are also what position() scans by default.
const marketsQuery = (chainId: SupportedChainId) =>
  `query { markets(where: {chainId_in: [${chainId}]}, orderBy: SupplyAssetsUsd, orderDirection: Desc, first: 100) { items { marketId listed lltv loanAsset { symbol address decimals } collateralAsset { symbol address decimals } state { supplyApy borrowApy utilization supplyAssetsUsd borrowAssetsUsd } } } }`;

export async function fetchApiMarkets(chainId: SupportedChainId): Promise<ApiMarket[]> {
  const res = await fetchImpl(MORPHO_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: marketsQuery(chainId) }),
  });
  if (!res.ok) throw new Error(`Morpho API HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { markets?: { items?: ApiMarket[] } }; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(`Morpho API: ${body.errors[0].message}`);
  return body.data?.markets?.items ?? [];
}

/** A real market has assets and an oracle — Morpho's index also carries junk/test ids. */
const isRealMarket = (m: ApiMarket) => !!m.loanAsset && !!m.collateralAsset && m.loanAsset.symbol !== "UNKNOWN";

// ── The read surface ───────────────────────────────────────────────────────

export const morphoReads = {
  /**
   * Lending markets on one chain. Curated (`listed`) markets by default;
   * includeUnlisted widens to every real market the API indexes.
   */
  async markets(args: { chainId: SupportedChainId; includeUnlisted?: boolean }): Promise<MorphoResult> {
    const chain = MORPHO_BY_CHAIN[args.chainId];
    try {
      const all = (await fetchApiMarkets(args.chainId)).filter(isRealMarket);
      const chosen = args.includeUnlisted ? all : all.filter((m) => m.listed);
      const shaped = chosen
        .map((m) => ({
          marketId: m.marketId,
          curated: m.listed,
          loan: m.loanAsset!.symbol,
          collateral: m.collateralAsset!.symbol,
          lltv: `${(Number(m.lltv) / 1e16).toFixed(1)}%`,
          supplyApy: m.state ? `${(m.state.supplyApy * 100).toFixed(2)}%` : null,
          borrowApy: m.state ? `${(m.state.borrowApy * 100).toFixed(2)}%` : null,
          utilization: m.state ? `${(m.state.utilization * 100).toFixed(1)}%` : null,
          totalSupplyUsd: m.state?.supplyAssetsUsd != null ? Number(m.state.supplyAssetsUsd.toFixed(2)) : null,
          totalBorrowUsd: m.state?.borrowAssetsUsd != null ? Number(m.state.borrowAssetsUsd.toFixed(2)) : null,
        }))
        .sort((a, b) => (b.totalSupplyUsd ?? 0) - (a.totalSupplyUsd ?? 0));
      return ok({
        venue: "Morpho",
        chainId: args.chainId,
        chain: chain.name,
        markets: shaped,
        note:
          "Supply the LOAN asset with build_lend to earn the supply APY; post the COLLATERAL asset with build_supply_collateral, then build_borrow the loan asset. lltv is the liquidation threshold." +
          (args.includeUnlisted ? " Unlisted (curated:false) markets are permissionless and unvetted — check them before using." : " Pass includeUnlisted:true to also see permissionless (unvetted) markets."),
      });
    } catch {
      // API down → pinned on-chain fallback (live params + IRM-derived APYs).
      try {
        const nowSec = Date.now() / 1000;
        const markets = await Promise.all(
          chain.defaultMarketIds.map(async (id) => {
            const params = await marketParamsOf(args.chainId, id);
            const state = await marketStateOf(args.chainId, id);
            const rate = await borrowRateOf(args.chainId, params, state);
            const accrued = accrueMarket(state, rate, nowSec);
            const [loan, coll] = await Promise.all([
              assetMeta(args.chainId, params.loanToken),
              assetMeta(args.chainId, params.collateralToken),
            ]);
            const borrowApy = borrowApyFromRate(rate);
            const util = accrued.totalSupplyAssets > 0n ? Number((accrued.totalBorrowAssets * 10_000n) / accrued.totalSupplyAssets) / 10_000 : 0;
            return {
              marketId: id,
              loan: loan.symbol,
              collateral: coll.symbol,
              lltv: `${(Number(params.lltv) / 1e16).toFixed(1)}%`,
              supplyApy: `${(borrowApy * util * (1 - Number(state.fee) / 1e18) * 100).toFixed(2)}%`,
              borrowApy: `${(borrowApy * 100).toFixed(2)}%`,
              utilization: `${(util * 100).toFixed(1)}%`,
              totalSupply: formatAtoms(accrued.totalSupplyAssets, loan.decimals),
            };
          }),
        );
        return ok({
          venue: "Morpho",
          chainId: args.chainId,
          chain: chain.name,
          markets,
          note: "Morpho's API is unreachable — this is the pinned fallback set read directly on-chain; newer markets may be missing.",
        });
      } catch (e) {
        return fail(502, `Morpho markets unavailable on ${chain.name} (API and on-chain fallback both failed): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  },

  /**
   * One market in depth, straight from the chain: live params, accrued
   * totals, APYs, utilization, available liquidity, and the oracle's answer.
   */
  async marketInfo(args: { chainId: SupportedChainId; marketId: string }): Promise<MorphoResult> {
    const chain = MORPHO_BY_CHAIN[args.chainId];
    if (!/^0x[0-9a-fA-F]{64}$/.test(args.marketId)) {
      return fail(400, `Invalid marketId "${args.marketId}" — pass the 32-byte market id from \`markets\`.`);
    }
    const id = args.marketId as `0x${string}`;
    try {
      const params = await marketParamsOf(args.chainId, id);
      if (params.loanToken === "0x0000000000000000000000000000000000000000") {
        return fail(404, `No Morpho market with id ${args.marketId} on ${chain.name} — call \`markets\` for live ids.`);
      }
      const rawState = await marketStateOf(args.chainId, id);
      const rate = await borrowRateOf(args.chainId, params, rawState);
      const state = accrueMarket(rawState, rate, Date.now() / 1000);
      const [loan, coll] = await Promise.all([
        assetMeta(args.chainId, params.loanToken),
        assetMeta(args.chainId, params.collateralToken),
      ]);
      const price = await oraclePriceOf(args.chainId, params);
      const borrowApy = borrowApyFromRate(rate);
      const util = state.totalSupplyAssets > 0n ? Number((state.totalBorrowAssets * 10_000n) / state.totalSupplyAssets) / 10_000 : 0;
      const liquidity = state.totalSupplyAssets - state.totalBorrowAssets;
      return ok({
        venue: "Morpho",
        chainId: args.chainId,
        chain: chain.name,
        marketId: id,
        market: `${loan.symbol} / ${coll.symbol}`,
        loanAsset: { symbol: loan.symbol, address: params.loanToken, decimals: loan.decimals },
        collateralAsset: { symbol: coll.symbol, address: params.collateralToken, decimals: coll.decimals },
        lltv: `${(Number(params.lltv) / 1e16).toFixed(1)}%`,
        supplyApy: `${(borrowApy * util * (1 - Number(rawState.fee) / 1e18) * 100).toFixed(2)}%`,
        borrowApy: `${(borrowApy * 100).toFixed(2)}%`,
        utilization: `${(util * 100).toFixed(1)}%`,
        totalSupply: `${formatAtoms(state.totalSupplyAssets, loan.decimals)} ${loan.symbol}`,
        totalBorrow: `${formatAtoms(state.totalBorrowAssets, loan.decimals)} ${loan.symbol}`,
        availableLiquidity: `${formatAtoms(liquidity, loan.decimals)} ${loan.symbol}`,
        fee: `${(Number(rawState.fee) / 1e16).toFixed(1)}%`,
        oracle:
          price != null
            ? { address: params.oracle, collateralPriceInLoan: formatAtoms((price * 10n ** BigInt(coll.decimals)) / ORACLE_PRICE_SCALE, loan.decimals) }
            : { address: params.oracle, collateralPriceInLoan: null, warning: "Oracle returned no price — builds against this market will refuse rather than guess." },
        note: "Numbers are computed from on-chain state with interest accrued to now. Use build_lend / build_supply_collateral / build_borrow with this marketId.",
      });
    } catch (e) {
      return fail(502, `Morpho market read failed on ${chain.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /**
   * A user's Morpho position across markets on one chain: supplied
   * (earning), collateral posted, borrowed (owing, interest-accrued),
   * health factor. All numbers from on-chain state.
   */
  async position(args: { chainId: SupportedChainId; user: Address; marketIds?: `0x${string}`[] }): Promise<MorphoResult> {
    const chain = MORPHO_BY_CHAIN[args.chainId];
    // Which markets to scan: caller's list > API discovery > pinned fallback.
    let ids: `0x${string}`[];
    let discovery = "explicit";
    if (args.marketIds?.length) {
      ids = args.marketIds;
    } else {
      try {
        ids = (await fetchApiMarkets(args.chainId)).filter(isRealMarket).map((m) => m.marketId);
        discovery = "morpho-api";
      } catch {
        ids = chain.defaultMarketIds;
        discovery = "pinned-fallback (Morpho API unreachable — newer markets may be missing)";
      }
    }

    try {
      const client = rpcFor(args.chainId);
      const nowSec = Date.now() / 1000;
      const positions = await Promise.all(
        ids.map(async (id) => {
          const pos = await readRetry(() =>
            client.readContract({ address: chain.morpho, abi: MORPHO_ABI, functionName: "position", args: [id, args.user] }),
          );
          if (pos.supplyShares === 0n && pos.borrowShares === 0n && pos.collateral === 0n) return null;

          const params = await marketParamsOf(args.chainId, id);
          const rawState = await marketStateOf(args.chainId, id);
          const rate = await borrowRateOf(args.chainId, params, rawState);
          const state = accrueMarket(rawState, rate, nowSec);
          const [loan, coll] = await Promise.all([
            assetMeta(args.chainId, params.loanToken),
            assetMeta(args.chainId, params.collateralToken),
          ]);

          const supplied = toAssetsDown(pos.supplyShares, state.totalSupplyAssets, state.totalSupplyShares);
          const debt = toAssetsUp(BigInt(pos.borrowShares), state.totalBorrowAssets, state.totalBorrowShares);
          const price = pos.collateral > 0n ? await oraclePriceOf(args.chainId, params) : null;
          const collateralInLoan = price != null ? (BigInt(pos.collateral) * price) / ORACLE_PRICE_SCALE : null;
          const maxBorrow = collateralInLoan != null ? (collateralInLoan * params.lltv) / WAD : null;
          const healthFactor = debt > 0n && maxBorrow != null ? Number((maxBorrow * 1000n) / debt) / 1000 : null;
          const borrowApy = borrowApyFromRate(rate);
          const util = state.totalSupplyAssets > 0n ? Number((state.totalBorrowAssets * 10_000n) / state.totalSupplyAssets) / 10_000 : 0;

          return {
            marketId: id,
            market: `${loan.symbol} / ${coll.symbol} (lltv ${(Number(params.lltv) / 1e16).toFixed(1)}%)`,
            supplied: supplied > 0n ? { amount: formatAtoms(supplied, loan.decimals), asset: loan.symbol, apy: `${(borrowApy * util * (1 - Number(rawState.fee) / 1e18) * 100).toFixed(2)}%` } : null,
            collateral: pos.collateral > 0n ? { amount: formatAtoms(BigInt(pos.collateral), coll.decimals), asset: coll.symbol } : null,
            borrowed: debt > 0n ? { amount: formatAtoms(debt, loan.decimals), asset: loan.symbol, apy: `${(borrowApy * 100).toFixed(2)}%` } : null,
            ...(maxBorrow != null
              ? {
                  borrowingPower: {
                    maxBorrow: formatAtoms(maxBorrow, loan.decimals),
                    remaining: formatAtoms(maxBorrow > debt ? maxBorrow - debt : 0n, loan.decimals),
                    asset: loan.symbol,
                  },
                }
              : {}),
            healthFactor,
            ...(healthFactor != null && healthFactor < 1.05 ? { warning: "Health factor is close to 1 — liquidation risk." } : {}),
          };
        }),
      );

      const active = positions.filter(Boolean);
      return ok({
        venue: "Morpho",
        chainId: args.chainId,
        chain: chain.name,
        user: args.user,
        marketDiscovery: discovery,
        positions: active,
        summary: active.length === 0 ? `No Morpho lending positions on ${chain.name}.` : `${active.length} active Morpho market position(s) on ${chain.name}.`,
      });
    } catch (e) {
      return fail(502, `Morpho position read failed on ${chain.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
