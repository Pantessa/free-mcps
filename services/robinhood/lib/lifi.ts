// ─────────────────────────────────────────────────────────────────────────
//  LiFi settlement fallback — makes venue-gated stock pools TRADABLE.
//
//  Robinhood Chain's tokenized-stock v4 pools quote on the public Quoter but
//  a direct Universal Router fill bare-reverts: every real fill settles
//  through Robinhood's backend-signed DexAggregator, whose callers are
//  whitelisted. LiFi's router IS whitelisted (tool "fly" wraps the
//  aggregator) and quotes keylessly, so when swap.ts's executability probe
//  says "gated" we build through LiFi instead of refusing.
//
//  Trust model — we CANNOT byte-verify LiFi's inner calldata (it drives a
//  closed aggregator), so the guard is built from what we can verify
//  independently, all fail-closed:
//    1. ADDRESS PINNING — transactionRequest.to AND estimate.approvalAddress
//       must both be on the LiFi router allowlist for chain 4663 (default the
//       live diamond; env LIFI_ROUTERS to extend). Zero native value, chain
//       4663 only.
//    2. ECHO CHECK — the quote must echo back exactly our fromToken/toToken/
//       fromAmount; any drift refuses.
//    3. INDEPENDENT PRICE CHECK — LiFi's toAmount is compared against the
//       service's OWN v4 Quoter read for the same pair; more than ~2% worse
//       (after LiFi's included fees) refuses. LiFi can't misprice us quietly.
//       A stock's fill (and LiFi's minimum) is also checked against the tape
//       (lib/tape.ts): more than 10% off refuses by name, and a v4 quote that
//       is itself off the tape stops being the referee — the tape is.
//    4. SIMULATION — the swap tx is eth_estimateGas-simulated before it's
//       returned. A real revert fails CLOSED (no artifact); missing-approval
//       or transport trouble fails OPEN with an explicit warning flag.
//    5. EXACT-AMOUNT APPROVAL — the approval step (when the live allowance
//       is short) grants exactly the swap amount to the pinned router, never
//       unlimited.
//
//  FEE — 0.20% of the input (env YEETFUL_SWAP_FEE_BPS, default 20 bps —
//  deliberately below Uniswap's 25 bps) goes to the Yeetful treasury
//  (env YEETFUL_TREASURY). LiFi's native integrator-fee params are NOT
//  honored keylessly (400 "integrator not configured for collecting fees",
//  verified live 2026-07-15), so the fee is a deterministic ERC-20 transfer
//  step appended to the chain — explicit in the artifact, decoded and
//  re-verified by the guard like every other step.
//
//  Construction-only, like everything in this service: nothing here signs
//  or submits.
// ─────────────────────────────────────────────────────────────────────────

import { decodeFunctionData, encodeFunctionData } from "viem";
import { TOKEN_ABI, readRetry, rpc } from "./chain";
import { CHAIN_ID, type Address, type RegistryToken } from "./registry";
import {
  LIFI_VENUE,
  OffTapeError,
  OffTapeMinimumError,
  TAPE_BOUND_PCT,
  checkFillAgainstTape,
  checkMinimumAgainstTape,
  fillDeviationPct,
  fmtTapeGap,
  isStockToken,
  type SwapTape,
  type TapeCheck,
} from "./tape";
import { step, type SendTransactionAction } from "./tx";
import { fail, formatAtoms, ok, type RhResult } from "./util";

export const LIFI_QUOTE_API = "https://li.quest/v1/quote";

/** LiFi router/diamond on Robinhood Chain (4663) — verified live 2026-07-15
 *  (both transactionRequest.to and estimate.approvalAddress). */
export const DEFAULT_LIFI_ROUTERS: Address[] = ["0xB477751B76CF82d00a686A1232f5fCD772414Af3"];

/** Yeetful treasury — receives the swap fee. */
export const DEFAULT_TREASURY: Address = "0x9Cc0B7A0DdB091E17647d689206e730131E9892A";

/** 0.20% — deliberately below Uniswap's 25 bps interface fee. */
export const DEFAULT_FEE_BPS = 20;

/** Refuse LiFi quotes pricing >2% below our own v4 Quoter read. */
const PRICE_TOLERANCE_BPS = 200n;

/** LiFi quotes go stale fast — artifacts carry an explicit expiry. */
const QUOTE_TTL_SEC = 60;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const eqAddr = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// ── Env-overridable config (read per call so ops can rotate without deploys) ─

export function lifiRouters(): Address[] {
  const raw = process.env.LIFI_ROUTERS;
  if (!raw) return DEFAULT_LIFI_ROUTERS;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => ADDR_RE.test(s)) as Address[];
  return parsed.length > 0 ? parsed : DEFAULT_LIFI_ROUTERS;
}

export function yeetfulTreasury(): Address {
  const raw = process.env.YEETFUL_TREASURY;
  return raw && ADDR_RE.test(raw) ? (raw as Address) : DEFAULT_TREASURY;
}

export function swapFeeBps(): number {
  const raw = Number(process.env.YEETFUL_SWAP_FEE_BPS);
  // Sanity-cap at 1% — a fat-fingered env var must not become a rug.
  return Number.isInteger(raw) && raw >= 0 && raw <= 100 ? raw : DEFAULT_FEE_BPS;
}

/** Deterministic fee split: fee comes OUT of the asked amount, so "swap 500
 *  USDG" spends exactly 500 — feeAtoms to the treasury, swapAtoms to LiFi. */
export function feeSplit(amountIn: bigint): { feeAtoms: bigint; swapAtoms: bigint; bps: number } {
  const bps = swapFeeBps();
  const feeAtoms = (amountIn * BigInt(bps)) / 10_000n;
  return { feeAtoms, swapAtoms: amountIn - feeAtoms, bps };
}

// ── LiFi quote fetch (with a test seam, morpho.ts-style) ───────────────────

export interface LifiQuote {
  tool?: string;
  toolDetails?: { name?: string };
  action?: { fromToken?: { address?: string }; toToken?: { address?: string }; fromAmount?: string };
  estimate?: {
    toAmount?: string;
    toAmountMin?: string;
    approvalAddress?: string;
    feeCosts?: Array<{ name?: string; amount?: string; percentage?: string; included?: boolean }>;
  };
  transactionRequest?: { to?: string; data?: string; value?: string; chainId?: number };
}

type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

let fetchImpl: FetchLike = (...args) => fetch(...args);

export function setLifiFetchForTests(fake: FetchLike | null) {
  fetchImpl = fake ?? ((...args) => fetch(...args));
}

type QuoteResult = { kind: "quote"; quote: LifiQuote } | { kind: "no-route"; message: string } | { kind: "transport"; message: string };

async function fetchLifiQuote(sell: Address, buy: Address, atoms: bigint, from: Address): Promise<QuoteResult> {
  const params = new URLSearchParams({
    fromChain: String(CHAIN_ID),
    toChain: String(CHAIN_ID),
    fromToken: sell,
    toToken: buy,
    fromAmount: atoms.toString(),
    fromAddress: from,
    integrator: "yeetful", // attribution only — fee collection is our own transfer step
  });
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.LIFI_API_KEY) headers["x-lifi-api-key"] = process.env.LIFI_API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchImpl(`${LIFI_QUOTE_API}?${params}`, { headers, signal: controller.signal });
    const body = (await res.json().catch(() => null)) as (LifiQuote & { message?: string }) | null;
    if (!res.ok || !body?.transactionRequest || !body?.estimate) {
      // 404/1002 "No available quotes" and any quote-shaped failure = no route.
      return { kind: "no-route", message: body?.message ?? `LiFi answered HTTP ${res.status} with no route.` };
    }
    return { kind: "quote", quote: body };
  } catch (e) {
    return { kind: "transport", message: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ── The guard (pure, fail-closed) ──────────────────────────────────────────

/** transfer() isn't in the read-oriented TOKEN_ABI — the fee step needs it. */
const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface LifiGuardExpectations {
  sellToken: Address;
  swapAtoms: bigint;
  feeAtoms: bigint;
  treasury: Address;
  routers: Address[];
  hasApproval: boolean;
}

/**
 * Verify a built LiFi step chain before it can be offered for signing. We
 * cannot decode LiFi's inner aggregator calldata, so the guard pins what IS
 * verifiable: step count/order, chain, zero native value, an exact-amount
 * approval to an allowlisted router, the swap addressed to an allowlisted
 * router, and the fee transfer decoded field-by-field (treasury + exact
 * atoms). Any mismatch refuses the whole chain.
 */
export function guardLifiBuild(steps: SendTransactionAction[], exp: LifiGuardExpectations): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const expected = 1 + (exp.hasApproval ? 1 : 0) + (exp.feeAtoms > 0n ? 1 : 0);
  if (steps.length !== expected) {
    return { ok: false, reasons: [`Expected ${expected} steps (approval? + swap + fee?), got ${steps.length}.`] };
  }
  for (const s of steps) {
    if (s.tx.chainId !== CHAIN_ID) reasons.push(`A step targets chain ${s.tx.chainId}, not ${CHAIN_ID}.`);
    if (BigInt(s.tx.value || "0") !== 0n) reasons.push("Every step must carry zero native value (ERC-20 in, ERC-20 out).");
  }

  let i = 0;
  if (exp.hasApproval) {
    const approve = steps[i++];
    if (!eqAddr(approve.tx.to, exp.sellToken)) reasons.push("The approval step is not addressed to the sell token.");
    try {
      const dec = decodeFunctionData({ abi: TOKEN_ABI, data: approve.tx.data as `0x${string}` });
      if (dec.functionName !== "approve") {
        reasons.push(`The approval step calls "${dec.functionName}", not approve — refusing.`);
      } else {
        const [spender, amount] = dec.args as [string, bigint];
        if (!exp.routers.some((r) => eqAddr(r, spender))) reasons.push("The approval spender is not an allowlisted LiFi router.");
        if (amount !== exp.swapAtoms) reasons.push("The approval amount is not exactly the swap amount.");
      }
    } catch {
      reasons.push("Could not decode the approval calldata — refusing.");
    }
  }

  const swap = steps[i++];
  if (!exp.routers.some((r) => eqAddr(r, swap.tx.to))) {
    reasons.push(`The swap is addressed to ${swap.tx.to}, which is not an allowlisted LiFi router for chain ${CHAIN_ID}.`);
  }
  if (!/^0x[0-9a-fA-F]{10,}$/.test(swap.tx.data)) reasons.push("The swap calldata is empty or malformed — refusing.");

  if (exp.feeAtoms > 0n) {
    const feeStep = steps[i++];
    if (!eqAddr(feeStep.tx.to, exp.sellToken)) reasons.push("The fee step is not addressed to the sell token.");
    try {
      const dec = decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data: feeStep.tx.data as `0x${string}` });
      if (dec.functionName !== "transfer") {
        reasons.push("The fee step is not a plain ERC-20 transfer — refusing.");
      } else {
        const [to, amount] = dec.args as [string, bigint];
        if (!eqAddr(to, exp.treasury)) reasons.push("The fee transfer does not go to the Yeetful treasury.");
        if (amount !== exp.feeAtoms) reasons.push("The fee transfer amount is not exactly the computed fee.");
      }
    } catch {
      reasons.push("Could not decode the fee transfer calldata — refusing.");
    }
  }

  return { ok: reasons.length === 0, reasons };
}

// ── The builder ────────────────────────────────────────────────────────────

export interface LifiBuildArgs {
  user: Address;
  sell: RegistryToken;
  buy: RegistryToken;
  /** Human amount as asked ("500") — fee + swap together spend exactly this. */
  amount: string;
  /** The asked amount in sell-token atoms. */
  amountIn: bigint;
  /** Our OWN v4 Quoter amountOut for amountIn — the independent price anchor.
   *  Null when the v4 pool can't referee (its quote is off the stock's tape). */
  quoterOut: bigint | null;
  /** Both legs priced for the tape check (lib/tape.ts readSwapTape) — null
   *  only for a pair with no stock on either side. */
  tape: SwapTape | null;
  /** Why build_swap skipped the Uniswap v4 pool when that pool was off the
   *  tape — it leads any refusal from here. */
  skippedPool?: OffTapeError | OffTapeMinimumError | null;
}

const pct = (n: bigint, d: bigint) => (d === 0n ? "0" : (Number((n * 10_000n) / d) / 100).toFixed(2));

/**
 * Build a guarded swap through LiFi's router (which settles via Robinhood's
 * backend-signed DexAggregator — the only public path that fills gated stock
 * pools). Called by swap.build when the direct-v4 executability probe says
 * "gated". Returns the artifact, or an honest refusal when LiFi can't route,
 * misprices, or simulates to a revert.
 */
export async function buildLifiSwap(args: LifiBuildArgs): Promise<RhResult> {
  const { user, sell, buy } = args;
  const skipped = args.skippedPool ?? null;
  // Fail closed on a caller that skipped the tape for a stock pair.
  if (!args.tape && (isStockToken(sell) || isStockToken(buy))) {
    return fail(500, `Refusing to build a ${sell.symbol}→${buy.symbol} stock swap that wasn't checked against the tape. Nothing was built.`);
  }
  if (args.quoterOut === null && !args.tape) {
    return fail(500, "LiFi guard refused (artifact withheld): no independent price reference — neither this service's v4 Quoter nor a tape.");
  }
  const routers = lifiRouters();
  const treasury = yeetfulTreasury();
  const { feeAtoms, swapAtoms, bps } = feeSplit(args.amountIn);
  if (swapAtoms <= 0n) return fail(400, `Amount too small — nothing left to swap after the ${bps / 100}% Yeetful fee.`);

  const quoted = await fetchLifiQuote(sell.address, buy.address, swapAtoms, user);
  if (quoted.kind === "no-route") {
    if (skipped) {
      return fail(409, `${skipped.message} LiFi, the chain's own settlement venue, found no route either (${quoted.message}). Nothing was built.`);
    }
    return fail(
      409,
      `${sell.symbol}→${buy.symbol} quotes on Uniswap v4, but the pool is venue-gated (it only executes through Robinhood Chain's backend-signed DexAggregator) and LiFi — the one public settlement path — found no route either: ${quoted.message} No artifact was built; trade this pair in Robinhood's own app instead. The quote tool stays accurate for pricing.`,
    );
  }
  if (quoted.kind === "transport") {
    if (skipped) {
      return fail(502, `${skipped.message} The LiFi settlement API was unreachable (${quoted.message}) — try again shortly. Nothing was built.`);
    }
    return fail(502, `The pool is venue-gated and the LiFi settlement API was unreachable (${quoted.message}) — try again shortly. Nothing was built.`);
  }
  const q = quoted.quote;
  const est = q.estimate!;
  const txReq = q.transactionRequest!;

  // ── Fail-closed verification of the quote itself ─────────────────────────
  const refusals: string[] = [];
  if (!eqAddr(q.action?.fromToken?.address, sell.address)) refusals.push("LiFi echoed a different fromToken than requested.");
  if (!eqAddr(q.action?.toToken?.address, buy.address)) refusals.push("LiFi echoed a different toToken than requested.");
  if (q.action?.fromAmount !== swapAtoms.toString()) refusals.push("LiFi echoed a different fromAmount than requested.");
  if (!txReq.to || !routers.some((r) => eqAddr(r, txReq.to))) {
    refusals.push(`LiFi's transaction targets ${txReq.to ?? "nothing"}, which is not an allowlisted LiFi router for chain ${CHAIN_ID}.`);
  }
  if (!est.approvalAddress || !routers.some((r) => eqAddr(r, est.approvalAddress))) {
    refusals.push(`LiFi's approvalAddress ${est.approvalAddress ?? "(missing)"} is not an allowlisted LiFi router — refusing to point an approval at it.`);
  }
  if ((txReq.chainId ?? CHAIN_ID) !== CHAIN_ID) refusals.push(`LiFi's transaction targets chain ${txReq.chainId}, not ${CHAIN_ID}.`);
  if (BigInt(txReq.value ?? "0") !== 0n) refusals.push("LiFi's transaction carries native value — these swaps are ERC-20 only.");
  if (!/^0x[0-9a-fA-F]{10,}$/.test(txReq.data ?? "")) refusals.push("LiFi returned empty or malformed calldata.");

  let toAmount = 0n;
  let toAmountMin = 0n;
  try {
    toAmount = BigInt(est.toAmount ?? "");
    toAmountMin = BigInt(est.toAmountMin ?? "");
    if (toAmount <= 0n || toAmountMin <= 0n || toAmountMin > toAmount) refusals.push("LiFi's output amounts are implausible.");
  } catch {
    refusals.push("LiFi's output amounts failed to parse.");
  }
  if (refusals.length > 0) return fail(500, `LiFi guard refused the quote (artifact withheld): ${refusals.join(" ")}`);

  // ── The tape: this is the last venue build_swap reaches, so a stock's fill
  //   must sit inside the bound here too — the quote AND the minimum LiFi's
  //   transaction accepts. Measured on the swap leg (the fee moves separately).
  let tapeCheck: TapeCheck | null;
  let minimumVsTape: string | null;
  try {
    tapeCheck = checkFillAgainstTape(args.tape, LIFI_VENUE, swapAtoms, toAmount);
    minimumVsTape = checkMinimumAgainstTape(args.tape, LIFI_VENUE, swapAtoms, toAmountMin, "LiFi's own slippage sets that minimum.");
  } catch (e) {
    if (!(e instanceof OffTapeError || e instanceof OffTapeMinimumError)) throw e;
    return fail(409, `${skipped ? `${skipped.message} ` : ""}${e.message} Nothing was built.`);
  }

  // ── Independent price check: our own v4 Quoter is the anchor ─────────────
  // A v4 quote that is itself off the stock's tape (a broken pool) can't
  // referee LiFi's fill — the tape check above already did.
  const refDevPct = args.quoterOut === null ? null : fillDeviationPct(args.tape, args.amountIn, args.quoterOut);
  const referee = args.quoterOut !== null && (refDevPct === null || Math.abs(refDevPct) <= TAPE_BOUND_PCT) ? args.quoterOut : null;
  // quoterOut priced the FULL asked amount; scale it to the swap leg.
  const scaledQuoterOut = referee === null ? null : (referee * swapAtoms) / args.amountIn;
  if (scaledQuoterOut !== null) {
    const floor = (scaledQuoterOut * (10_000n - PRICE_TOLERANCE_BPS)) / 10_000n;
    if (toAmount < floor) {
      return fail(
        409,
        `LiFi priced ${sell.symbol}→${buy.symbol} at ${formatAtoms(toAmount, buy.decimals)} ${buy.symbol} — ${pct(scaledQuoterOut - toAmount, scaledQuoterOut)}% below this service's own Uniswap v4 Quoter read (${formatAtoms(scaledQuoterOut, buy.decimals)} ${buy.symbol}). More than ${Number(PRICE_TOLERANCE_BPS) / 100}% worse is refused — no artifact was built. Try again; routes and prices move.`,
      );
    }
  }
  const v4Gap =
    skipped instanceof OffTapeError
      ? skipped.fill.devPct
      : refDevPct !== null && Math.abs(refDevPct) > TAPE_BOUND_PCT
        ? refDevPct
        : null;
  const priceCheck =
    scaledQuoterOut !== null
      ? {
          v4Quoter: `${formatAtoms(scaledQuoterOut, buy.decimals)} ${buy.symbol} for the same input`,
          verdict: `LiFi within the ${Number(PRICE_TOLERANCE_BPS) / 100}% tolerance of this service's own quoter read`,
        }
      : {
          v4Quoter:
            v4Gap !== null && Number.isFinite(v4Gap)
              ? `not used — the Uniswap v4 pool's quote is ${fmtTapeGap(v4Gap)}% off the tape, so it can't referee LiFi's price`
              : "not used — the Uniswap v4 pool's quote is off the tape, so it can't referee LiFi's price",
          verdict: "the stock's tape is the independent price reference (see tapeCheck)",
        };

  try {
    const client = rpc();
    const approvalAddress = est.approvalAddress as Address;
    const allowance = await readRetry(() =>
      client.readContract({ address: sell.address, abi: TOKEN_ABI, functionName: "allowance", args: [user, approvalAddress] }),
    );
    const hasApproval = allowance < swapAtoms;

    // ── Simulate the swap before offering it (fail closed on a real revert) ─
    let simulation: string;
    let simulationWarning = false;
    if (hasApproval) {
      simulation = "skipped — the router cannot pull funds until the approval step confirms; the transaction cannot be meaningfully simulated yet.";
      simulationWarning = true;
    } else {
      try {
        await client.estimateGas({ account: user, to: txReq.to as Address, data: txReq.data as `0x${string}`, value: 0n });
        simulation = "passed — eth_estimateGas succeeded against live chain state";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/execution reverted|revert/i.test(msg)) {
          return fail(
            409,
            `LiFi's swap transaction simulates to a REVERT on live chain state — refusing to offer it for signing (the quote may be stale or the route broken). Nothing was built; try again.`,
          );
        }
        simulation = `unavailable — the RPC could not simulate (${msg.slice(0, 120)}); the transaction may still succeed, but sign with that in mind.`;
        simulationWarning = true;
      }
    }

    // ── Build the steps: [approve?] → swap → [fee] ───────────────────────────
    const swapHuman = formatAtoms(swapAtoms, sell.decimals);
    const feeHuman = formatAtoms(feeAtoms, sell.decimals);
    const outHuman = formatAtoms(toAmount, buy.decimals);
    const minHuman = formatAtoms(toAmountMin, buy.decimals);
    const routeName = q.toolDetails?.name ?? q.tool ?? "LiFi";

    const steps: SendTransactionAction[] = [];
    if (hasApproval) {
      steps.push(
        step(`Approve ${sell.symbol} → LiFi router`, `Allow the LiFi router to pull exactly ${swapHuman} ${sell.symbol} (the swap leg; the ${bps / 100}% Yeetful fee moves separately).`, {
          to: sell.address,
          data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [approvalAddress, swapAtoms] }),
        }),
      );
    }
    steps.push(
      step(
        `Swap ${sell.symbol} → ${buy.symbol} via LiFi`,
        `Swap ${swapHuman} ${sell.symbol} for ≈${outHuman} ${buy.symbol} (minimum ${minHuman}) through LiFi's ${routeName} route — the settlement path that clears Robinhood Chain's backend-signed stock venue.`,
        { to: txReq.to as Address, data: txReq.data as `0x${string}` },
      ),
    );
    if (feeAtoms > 0n) {
      steps.push(
        step(`Yeetful fee (${bps / 100}%)`, `Send ${feeHuman} ${sell.symbol} (${bps} bps of the input) to the Yeetful treasury.`, {
          to: sell.address,
          data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [treasury, feeAtoms] }),
        }),
      );
    }

    // ── Fail-closed: re-decode what was just built ───────────────────────────
    const verdict = guardLifiBuild(steps, { sellToken: sell.address, swapAtoms, feeAtoms, treasury, routers, hasApproval });
    if (!verdict.ok) {
      return fail(500, `Guard refused the built LiFi swap (artifact withheld): ${verdict.reasons.join(" ")}`);
    }

    const validUntil = new Date(Date.now() + QUOTE_TTL_SEC * 1000).toISOString();
    const warnings = [
      ...(tapeCheck?.status === "warn" ? [tapeCheck.note] : []),
      ...(simulationWarning ? [`Simulation ${hasApproval ? "was skipped" : "was unavailable"} — see the simulation field.`] : []),
    ];
    return ok({
      operation: "swap",
      venue: `LiFi → Robinhood DexAggregator (Robinhood Chain)`,
      route: routeName,
      note: skipped
        ? `${skipped.message} build_swap skipped that pool; this build settles through LiFi's whitelisted router into Robinhood's backend-signed DexAggregator instead.`
        : "This pool is venue-gated for direct Uniswap v4 calls — only Robinhood's backend-signed DexAggregator settles it. LiFi's whitelisted router is the public path in; this build routes through it.",
      sell: `${args.amount} ${sell.symbol} total (${swapHuman} swapped + ${feeHuman} fee)`,
      buyEstimate: `≈${outHuman} ${buy.symbol}`,
      minimumOut: `${minHuman} ${buy.symbol}`,
      fee: {
        bps,
        amount: `${feeHuman} ${sell.symbol}`,
        recipient: treasury,
        collection: "explicit ERC-20 transfer step (LiFi integrator fees are not available keylessly)",
      },
      priceCheck,
      ...(tapeCheck ? { tapeCheck: { ...tapeCheck, ...(minimumVsTape ? { minimum: minimumVsTape } : {}) } } : {}),
      simulation,
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      validUntil,
      guard: `passed — router + approval target pinned to the LiFi allowlist, amounts exact, fee transfer decoded and verified, price cross-checked against ${
        scaledQuoterOut !== null && tapeCheck ? "the v4 Quoter and the stock's tape" : tapeCheck ? "the stock's tape" : "the v4 Quoter"
      }`,
      steps,
      submit_with: `Each step is an UNSIGNED transaction for the USER's wallet (eth_sendTransaction), in order — this service never signs. The LiFi quote goes stale at validUntil (${validUntil}); past that, call build_swap again for a fresh route. After the final step confirms, the ${buy.symbol} is in the wallet — check with portfolio.`,
    });
  } catch (e) {
    return fail(502, `LiFi build failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
