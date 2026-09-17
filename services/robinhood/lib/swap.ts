// ─────────────────────────────────────────────────────────────────────────
//  Uniswap v4 on Robinhood Chain — the stock-token venue (AAPL/TSLA/… trade
//  in v4-ONLY pools quoted against USDG). Ported from the Yeetful website's
//  guarded v4 fallback layer, construction-only:
//    1. Quote via the pinned V4 Quoter across the standard no-hook pool
//       keys (fee/tickSpacing pairs) — best amountOut wins.
//    2. Encode ONE Universal Router `execute` with exactly the V4_SWAP
//       command: SWAP_EXACT_IN_SINGLE → SETTLE_ALL → TAKE_ALL. TAKE_ALL
//       credits the transaction SENDER, so the recipient is the signer by
//       construction — there is no recipient field to get wrong.
//    3. v4 pulls funds through Permit2, so a sell may need up to two
//       approvals (token→Permit2, then Permit2→Universal Router), both for
//       EXACTLY the asked amount.
//    4. EXECUTABILITY PROBE: quoting is NOT executing. Robinhood's tokenized-
//       stock pools price fine on the public Quoter but a direct Universal
//       Router swap bare-reverts (empty revert data) — every real stock swap
//       settles through Robinhood's backend-signed DexAggregator stack, not
//       public UR calls. Simulate the SWAP action alone before building;
//       venue-gated pools fall through to the guarded LiFi settlement build
//       (lib/lifi.ts — LiFi's router is whitelisted on the aggregator), and
//       only when LiFi can't route either do we refuse honestly. Direct v4
//       stays primary for any pool that probes healthy (fail OPEN on
//       transport trouble).
//    5. GUARD: decode the calldata we just built and refuse unless every
//       field verifies (pinned router, exact amounts, quoted pool key, no
//       hooks, zero native value). A guard failure withholds the artifact.
//    6. TAPE PARITY (lib/tape.ts): a stock swap's quoted fill is priced per
//       share against Robinhood's tape BEFORE any of the above is trusted —
//       every bound here is measured from the pool's own quote, so a broken
//       pool would otherwise build a guard-verified swap that loses the money.
//       More than 10% off (either side) skips the pool for LiFi, whose fill
//       must land inside the bound too; no tape, no build.
//  Only no-hook pools are scanned: a hooked pool's contract can reorder
//  economics mid-swap, so we refuse rather than route through code we
//  haven't verified.
// ─────────────────────────────────────────────────────────────────────────

import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData } from "viem";
import { PERMIT2_ABI, TOKEN_ABI, UNIVERSAL_ROUTER_ABI, V4_QUOTER_ABI, readRetry, rpc } from "./chain";
import { CHAIN_ID, PERMIT2, UNIVERSAL_ROUTER, USDG, V4_QUOTER, resolveToken, type Address, type RegistryToken } from "./registry";
import { buildLifiSwap } from "./lifi";
import { feedPrice } from "./reads";
import {
  LIFI_VENUE,
  OffTapeError,
  OffTapeMinimumError,
  TapeUnavailableError,
  V4_VENUE,
  checkFillAgainstTape,
  checkMinimumAgainstTape,
  isStockToken,
  startSwapTape,
  tapeCheckOf,
  tapeFillOf,
  type SwapTape,
  type TapeCheck,
} from "./tape";
import { step, type SendTransactionAction } from "./tx";
import { fail, formatAtoms, humanToAtoms, ok, type RhResult } from "./util";

// Standard v4 fee → tickSpacing pairs (v4 has no enumerable tier list; these
// are the factory-conventional no-hook keys — USDG↔stock fills at 3000/60
// and 10000/200, live-probed on Robinhood Chain).
const V4_POOL_KEYS = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
] as const;

const ZERO_HOOKS = "0x0000000000000000000000000000000000000000" as const;

// Universal Router command + v4-periphery action bytes (stable protocol constants).
const UR_COMMAND_V4_SWAP = 0x10;
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;
/** The exact action sequence we build AND the only one the guard accepts. */
const V4_ACTIONS = `0x${[ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("")}` as `0x${string}`;

const UINT128_MAX = (1n << 128n) - 1n;

const EXACT_IN_SINGLE_PARAM = {
  type: "tuple",
  components: [
    {
      name: "poolKey",
      type: "tuple",
      components: [
        { name: "currency0", type: "address" },
        { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
      ],
    },
    { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
    { name: "hookData", type: "bytes" },
  ],
} as const;
const CURRENCY_AMOUNT_PARAMS = [{ type: "address" }, { type: "uint256" }] as const;
const ACTIONS_ENVELOPE_PARAMS = [{ type: "bytes" }, { type: "bytes[]" }] as const;

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface V4SwapPlan {
  poolKey: V4PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  minOut: bigint;
  deadline: number;
}

/** Encode the ONE Universal Router call: V4_SWAP → swap, settle, take. */
export function encodeV4SwapCalldata(plan: V4SwapPlan): `0x${string}` {
  const currencyIn = plan.zeroForOne ? plan.poolKey.currency0 : plan.poolKey.currency1;
  const currencyOut = plan.zeroForOne ? plan.poolKey.currency1 : plan.poolKey.currency0;
  const swapParams = encodeAbiParameters(
    [EXACT_IN_SINGLE_PARAM],
    [{ poolKey: plan.poolKey, zeroForOne: plan.zeroForOne, amountIn: plan.amountIn, amountOutMinimum: plan.minOut, hookData: "0x" }],
  );
  const settleParams = encodeAbiParameters([...CURRENCY_AMOUNT_PARAMS], [currencyIn, plan.amountIn]);
  const takeParams = encodeAbiParameters([...CURRENCY_AMOUNT_PARAMS], [currencyOut, plan.minOut]);
  const v4Input = encodeAbiParameters([...ACTIONS_ENVELOPE_PARAMS], [V4_ACTIONS, [swapParams, settleParams, takeParams]]);
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [`0x${UR_COMMAND_V4_SWAP.toString(16).padStart(2, "0")}`, [v4Input], BigInt(plan.deadline)],
  });
}

// ── The guard (pure, fail-closed) ──────────────────────────────────────────

export interface V4GuardExpectations {
  sellToken: Address;
  buyToken: Address;
  amountIn: bigint;
  minOut: bigint;
  poolKey: V4PoolKey;
  permit2Expiration: number;
}

const eqAddr = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Verify a built v4 step chain before it can be offered for signing. Every
 * step is decoded independently of the code that built it: pinned addresses
 * only, exactly the asked atoms, the quoted no-hook pool key, the fixed
 * swap→settle→take action sequence, zero native value. Any mismatch — or
 * anything that fails to decode — REFUSES the whole chain.
 */
export function guardV4Build(steps: SendTransactionAction[], exp: V4GuardExpectations): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (steps.length < 1 || steps.length > 3) {
    return { ok: false, reasons: [`Expected 1–3 steps (approvals + swap), got ${steps.length}.`] };
  }
  const swap = steps[steps.length - 1];
  const approvals = steps.slice(0, -1);

  for (const s of approvals) {
    const tx = s.tx;
    if (tx.chainId !== CHAIN_ID) reasons.push(`Approval step targets chain ${tx.chainId}, not ${CHAIN_ID}.`);
    if (BigInt(tx.value || "0") !== 0n) reasons.push("An approval must carry zero native value.");
    if (eqAddr(tx.to, exp.sellToken)) {
      try {
        const dec = decodeFunctionData({ abi: TOKEN_ABI, data: tx.data as `0x${string}` });
        if (dec.functionName !== "approve") {
          reasons.push(`Token step calls "${dec.functionName}", not approve — refusing.`);
        } else {
          const [spender, amount] = dec.args as [string, bigint];
          if (!eqAddr(spender, PERMIT2)) reasons.push("The token approval spender is not the pinned Permit2.");
          if (amount !== exp.amountIn) reasons.push("The token approval amount is not exactly the swap amount.");
        }
      } catch {
        reasons.push("Could not decode the token approval calldata — refusing.");
      }
    } else if (eqAddr(tx.to, PERMIT2)) {
      try {
        const dec = decodeFunctionData({ abi: PERMIT2_ABI, data: tx.data as `0x${string}` });
        if (dec.functionName !== "approve") {
          reasons.push(`Permit2 step calls "${dec.functionName}", not approve — refusing.`);
        } else {
          const [token, spender, amount, expiration] = dec.args as [string, string, bigint, number];
          if (!eqAddr(token, exp.sellToken)) reasons.push("The Permit2 approval is for a different token.");
          if (!eqAddr(spender, UNIVERSAL_ROUTER)) reasons.push("The Permit2 approval spender is not the pinned Universal Router.");
          if (amount !== exp.amountIn) reasons.push("The Permit2 approval amount is not exactly the swap amount.");
          if (Number(expiration) !== exp.permit2Expiration) reasons.push("The Permit2 approval expiration is not the one we stamped.");
        }
      } catch {
        reasons.push("Could not decode the Permit2 approval calldata — refusing.");
      }
    } else {
      reasons.push("An approval step targets neither the sell token nor the pinned Permit2 — refusing.");
    }
  }

  const tx = swap.tx;
  if (!eqAddr(tx.to, UNIVERSAL_ROUTER)) reasons.push("The swap is not addressed to the pinned Universal Router.");
  if (tx.chainId !== CHAIN_ID) reasons.push(`The swap targets chain ${tx.chainId}, not ${CHAIN_ID}.`);
  if (BigInt(tx.value || "0") !== 0n) reasons.push("The swap must carry zero native value (ERC-20 in via Permit2).");
  try {
    const dec = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: tx.data as `0x${string}` });
    const [commands, inputs, deadline] = dec.args as [`0x${string}`, readonly `0x${string}`[], bigint];
    if (commands.toLowerCase() !== `0x${UR_COMMAND_V4_SWAP.toString(16).padStart(2, "0")}`) {
      reasons.push(`Router commands are ${commands}, not the single V4_SWAP — refusing.`);
    }
    if (inputs.length !== 1) reasons.push(`Expected exactly one router input, got ${inputs.length}.`);
    if (deadline <= BigInt(Math.floor(Date.now() / 1000))) reasons.push("The swap deadline is already in the past.");
    const input = inputs[0];
    if (input) {
      const [actions, params] = decodeAbiParameters([...ACTIONS_ENVELOPE_PARAMS], input) as [`0x${string}`, readonly `0x${string}`[]];
      if (actions.toLowerCase() !== V4_ACTIONS) {
        reasons.push(`v4 actions are ${actions}, not swap→settle-all→take-all — refusing.`);
      } else if (params.length !== 3) {
        reasons.push(`Expected 3 action params, got ${params.length}.`);
      } else {
        const [sp] = decodeAbiParameters([EXACT_IN_SINGLE_PARAM], params[0]) as [
          { poolKey: V4PoolKey; zeroForOne: boolean; amountIn: bigint; amountOutMinimum: bigint; hookData: `0x${string}` },
        ];
        const k = sp.poolKey;
        if (!eqAddr(k.currency0, exp.poolKey.currency0) || !eqAddr(k.currency1, exp.poolKey.currency1)) {
          reasons.push("The pool currencies do not match the quoted pair.");
        }
        if (k.fee !== exp.poolKey.fee || k.tickSpacing !== exp.poolKey.tickSpacing) {
          reasons.push("The pool fee/tickSpacing does not match the quoted pool.");
        }
        if (!eqAddr(k.hooks, ZERO_HOOKS)) reasons.push("The pool has a hook contract — only no-hook pools are allowed.");
        const currencyIn = sp.zeroForOne ? k.currency0 : k.currency1;
        const currencyOut = sp.zeroForOne ? k.currency1 : k.currency0;
        if (!eqAddr(currencyIn, exp.sellToken)) reasons.push("The swap direction does not sell the asked token.");
        if (!eqAddr(currencyOut, exp.buyToken)) reasons.push("The swap direction does not buy the asked token.");
        if (sp.amountIn !== exp.amountIn) reasons.push("The swap amountIn is not exactly the asked amount.");
        if (sp.amountOutMinimum !== exp.minOut) reasons.push("The swap minimum-out does not match the quoted bound.");
        if (sp.hookData !== "0x") reasons.push("Unexpected hookData on the swap — refusing.");
        const [settleCur, settleAmt] = decodeAbiParameters([...CURRENCY_AMOUNT_PARAMS], params[1]) as [string, bigint];
        if (!eqAddr(settleCur, exp.sellToken)) reasons.push("SETTLE_ALL is for a different currency than the sell token.");
        if (settleAmt !== exp.amountIn) reasons.push("SETTLE_ALL max does not match the swap amount.");
        const [takeCur, takeAmt] = decodeAbiParameters([...CURRENCY_AMOUNT_PARAMS], params[2]) as [string, bigint];
        if (!eqAddr(takeCur, exp.buyToken)) reasons.push("TAKE_ALL is for a different currency than the buy token.");
        if (takeAmt !== exp.minOut) reasons.push("TAKE_ALL minimum does not match the quoted bound.");
      }
    }
  } catch {
    reasons.push("Could not decode the Universal Router calldata — refusing to offer an opaque transaction.");
  }

  return { ok: reasons.length === 0, reasons };
}

// ── Quoting ────────────────────────────────────────────────────────────────

const sortCurrencies = (a: Address, b: Address): [Address, Address] =>
  a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];

export interface BestQuote {
  poolKey: V4PoolKey;
  zeroForOne: boolean;
  amountOut: bigint;
  gasEstimate: bigint;
}

/** Scan the standard no-hook pool keys; best amountOut wins. Null = no pool. */
export async function quoteBest(sell: Address, buy: Address, amountIn: bigint): Promise<BestQuote | null> {
  const client = rpc();
  const [currency0, currency1] = sortCurrencies(sell, buy);
  const zeroForOne = currency0.toLowerCase() === sell.toLowerCase();
  let best: BestQuote | null = null;
  for (const { fee, tickSpacing } of V4_POOL_KEYS) {
    const poolKey: V4PoolKey = { currency0, currency1, fee, tickSpacing, hooks: ZERO_HOOKS };
    try {
      const { result } = await readRetry(() =>
        client.simulateContract({
          address: V4_QUOTER,
          abi: V4_QUOTER_ABI,
          functionName: "quoteExactInputSingle",
          args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
        }),
      );
      const [amountOut, gasEstimate] = result as readonly [bigint, bigint];
      if (amountOut > 0n && (!best || amountOut > best.amountOut)) {
        best = { poolKey, zeroForOne, amountOut, gasEstimate };
      }
    } catch {
      // no pool at this key — keep scanning
    }
  }
  return best;
}

// ── Executability probe ────────────────────────────────────────────────────

const hasRevertData = (e: unknown): e is { data?: unknown } => !!e && typeof e === "object" && "data" in e;

/** Pull the revert data off a viem error chain (walk when available). */
function revertDataOf(err: unknown): string | undefined {
  const walked =
    err instanceof Error && "walk" in err && typeof (err as { walk?: unknown }).walk === "function"
      ? (err as { walk: (fn: (e: unknown) => boolean) => unknown }).walk(hasRevertData)
      : err;
  return hasRevertData(walked) && typeof walked.data === "string" ? walked.data : undefined;
}

/**
 * Can this pool actually EXECUTE a swap from a direct Universal Router call?
 * Simulates the SWAP action alone via eth_call (no settle/take — needs no
 * balances or allowances from `from`). A healthy pool always reverts WITH
 * data (`CurrencyNotSettled`/`V4TooLittleReceived` — deltas are left
 * unsettled by design); a venue-gated pool (Robinhood tokenized stocks)
 * bare-reverts with EMPTY data before the pool math runs. Returns:
 *   'ok'      — revert carried data (or the call somehow passed): executable
 *   'gated'   — positive execution revert with empty data: NOT executable
 *   'unknown' — transport trouble (timeout/rate-limit): fail OPEN rather
 *               than block good builds on RPC flakiness.
 */
export async function probeV4Executability(plan: V4SwapPlan, from: Address): Promise<"ok" | "gated" | "unknown"> {
  const swapParams = encodeAbiParameters(
    [EXACT_IN_SINGLE_PARAM],
    [{ poolKey: plan.poolKey, zeroForOne: plan.zeroForOne, amountIn: plan.amountIn, amountOutMinimum: plan.minOut, hookData: "0x" }],
  );
  const v4Input = encodeAbiParameters(
    [...ACTIONS_ENVELOPE_PARAMS],
    [`0x${ACTION_SWAP_EXACT_IN_SINGLE.toString(16).padStart(2, "0")}`, [swapParams]],
  );
  const data = encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [`0x${UR_COMMAND_V4_SWAP.toString(16).padStart(2, "0")}`, [v4Input], BigInt(plan.deadline)],
  });
  try {
    await rpc().call({ account: from, to: UNIVERSAL_ROUTER, data });
    return "ok";
  } catch (err) {
    const revertData = revertDataOf(err);
    if (typeof revertData === "string" && revertData.length > 2) return "ok";
    const msg = err instanceof Error ? err.message : "";
    // Only a positive "execution reverted" with no data means gated — RPC
    // flakiness must not block good builds.
    if (/execution reverted|revert/i.test(msg)) return "gated";
    return "unknown";
  }
}

// ── Tool surfaces ──────────────────────────────────────────────────────────

function resolvePair(sellToken: string, buyToken: string): { sell: RegistryToken; buy: RegistryToken } | RhResult {
  const sell = resolveToken(sellToken);
  const buy = resolveToken(buyToken);
  if (!sell) return fail(404, `Unknown sell token "${sellToken}" on Robinhood Chain — call stock_tokens for the directory. Native ETH isn't swappable here; wrap to WETH first.`);
  if (!buy) return fail(404, `Unknown buy token "${buyToken}" on Robinhood Chain — call stock_tokens for the directory.`);
  if (sell.address.toLowerCase() === buy.address.toLowerCase()) return fail(400, "sellToken and buyToken must differ.");
  return { sell, buy };
}

const isResult = (x: { sell: RegistryToken; buy: RegistryToken } | RhResult): x is RhResult => "ok" in x;

export const swap = {
  /** Live swap quote (no build): best no-hook v4 pool, checked against the
   *  stock's tape (stock pairs) or cross-checked against Chainlink (others). */
  async quote(args: { sellToken: string; buyToken: string; amount: string }): Promise<RhResult> {
    const pair = resolvePair(args.sellToken, args.buyToken);
    if (isResult(pair)) return pair;
    const { sell, buy } = pair;
    const amountIn = humanToAtoms(args.amount, sell.decimals);
    if (!amountIn || amountIn > UINT128_MAX) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal like "100".`);
    const stockPair = isStockToken(sell) || isStockToken(buy);
    try {
      const tapeRead = stockPair ? startSwapTape(sell, buy) : null;
      const best = await quoteBest(sell.address, buy.address, amountIn);
      if (!best) {
        return fail(
          404,
          `No Uniswap v4 pool quotes ${sell.symbol}→${buy.symbol} on Robinhood Chain. Stock tokens pool against USDG — try routing through USDG (${sell.symbol}→USDG, then USDG→${buy.symbol}).`,
        );
      }
      const outHuman = formatAtoms(best.amountOut, buy.decimals);
      const execPrice = Number(outHuman) / Number(args.amount);
      const venue = "Uniswap v4 (Robinhood Chain)";
      const pool = { fee: `${best.poolKey.fee / 10_000}%`, tickSpacing: best.poolKey.tickSpacing, hooks: "none" };
      const note = "Quote only — build_swap prepares the signable transaction chain.";

      if (tapeRead) {
        // Stock pairs: the tape is the reference — the same check build_swap
        // enforces, so a quote never advertises a price build_swap won't fill.
        let tape: SwapTape | null = null;
        try {
          tape = await tapeRead;
        } catch (e) {
          if (!(e instanceof TapeUnavailableError)) throw e;
          return ok({
            venue,
            sell: `${args.amount} ${sell.symbol}`,
            buy: `≈${outHuman} ${buy.symbol} (unchecked)`,
            pool,
            tapeCheck: { status: "unavailable", note: `Not checked against the tape: ${e.detail}.` },
            warning: e.permanent
              ? `This pool's price can't be checked against a tape for ${e.symbol}, so build_swap refuses to build it.`
              : "This pool's price is UNCHECKED — the tape didn't answer. Don't quote it as the stock's price; build_swap won't build until the tape answers.",
            note,
          });
        }
        const fill = tape ? tapeFillOf(V4_VENUE, tape.sell, tape.buy, amountIn, best.amountOut) : null;
        const tapeCheck = fill ? tapeCheckOf(fill) : null;
        if (tapeCheck?.status === "off") {
          // Never advertise a broken pool's number as the stock's price.
          return ok({
            venue,
            sell: `${args.amount} ${sell.symbol}`,
            offTape: true,
            poolQuote: `≈${outHuman} ${buy.symbol} — NOT a price you can trade at: this pool is off the tape`,
            pool,
            tapeCheck,
            warning: `${tapeCheck.note} build_swap won't fill this pool — it tries ${LIFI_VENUE} instead, whose fill must land inside the bound too.`,
            note,
          });
        }
        return ok({
          venue,
          sell: `${args.amount} ${sell.symbol}`,
          buy: `≈${outHuman} ${buy.symbol}`,
          price: `1 ${sell.symbol} ≈ ${execPrice.toFixed(6)} ${buy.symbol}`,
          pool,
          ...(tapeCheck ? { tapeCheck } : {}),
          ...(tapeCheck?.status === "warn" ? { warning: tapeCheck.note } : {}),
          note,
        });
      }

      // Non-stock pairs: cross-check the pool against Chainlink when both sides have feeds.
      let feedCheck: Record<string, unknown> | undefined;
      const [sellFeed, buyFeed] = await Promise.all([feedPrice(sell).catch(() => null), feedPrice(buy).catch(() => null)]);
      if (sellFeed && buyFeed) {
        const implied = sellFeed.usd / buyFeed.usd;
        const divergence = Math.abs(execPrice - implied) / implied;
        feedCheck = {
          chainlinkImpliedPrice: `1 ${sell.symbol} ≈ ${implied.toFixed(6)} ${buy.symbol}`,
          divergence: `${(divergence * 100).toFixed(2)}%`,
          ...(divergence > 0.02 ? { warning: "Pool price diverges >2% from Chainlink — thin liquidity or a stale feed; large orders will slip." } : {}),
        };
      }
      return ok({
        venue,
        sell: `${args.amount} ${sell.symbol}`,
        buy: `≈${outHuman} ${buy.symbol}`,
        price: `1 ${sell.symbol} ≈ ${execPrice.toFixed(6)} ${buy.symbol}`,
        pool,
        ...(feedCheck ? { feedCheck } : {}),
        note,
      });
    } catch (e) {
      return fail(502, `Quote failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Build a guarded v4 swap chain: [approve→Permit2?, Permit2→router?, swap]. */
  async build(args: { user: Address; sellToken: string; buyToken: string; amount: string; slippageBps?: number }): Promise<RhResult> {
    const pair = resolvePair(args.sellToken, args.buyToken);
    if (isResult(pair)) return pair;
    const { sell, buy } = pair;
    const slippageBps = args.slippageBps ?? 100;
    if (slippageBps < 1 || slippageBps > 5000) return fail(400, "slippageBps must be between 1 and 5000 (100 = 1%).");
    const amountIn = humanToAtoms(args.amount, sell.decimals);
    if (!amountIn || amountIn > UINT128_MAX) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal like "100".`);

    try {
      const client = rpc();
      const balance = await readRetry(() =>
        client.readContract({ address: sell.address, abi: TOKEN_ABI, functionName: "balanceOf", args: [args.user] }),
      );
      if (amountIn > balance) {
        return fail(400, `Insufficient ${sell.symbol}: swapping ${args.amount} but the wallet holds ${formatAtoms(balance, sell.decimals)}. Nothing was built.`);
      }

      // A stock swap is checked against the tape (lib/tape.ts); the read
      // rides alongside the quote.
      const tapeRead = startSwapTape(sell, buy);
      const best = await quoteBest(sell.address, buy.address, amountIn);
      if (!best) {
        return fail(404, `No Uniswap v4 pool quotes ${sell.symbol}→${buy.symbol} on Robinhood Chain — stock tokens pool against USDG; route through USDG in two swaps.`);
      }
      let tape: SwapTape | null;
      try {
        tape = await tapeRead;
      } catch (e) {
        // No tape, no build: a stock no feed prices refuses by name; a feed
        // that didn't answer (or a stale print) is worth a retry.
        if (e instanceof TapeUnavailableError) return fail(e.permanent ? 409 : 503, e.message);
        throw e;
      }
      // Every bound below is measured from this pool's own quote, so a pool far
      // from the stock's tape would still build a guard-verified swap that loses
      // the money. Off tape → skip the pool: LiFi (the chain's own settlement
      // venue) must fill inside the bound, refereed by the tape, not this pool.
      let tapeCheck: TapeCheck | null;
      try {
        tapeCheck = checkFillAgainstTape(tape, V4_VENUE, amountIn, best.amountOut);
      } catch (e) {
        if (!(e instanceof OffTapeError)) throw e;
        return buildLifiSwap({ user: args.user, sell, buy, amount: args.amount, amountIn, quoterOut: null, tape, skippedPool: e });
      }
      const minOut = (best.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
      if (minOut === 0n) return fail(400, "The quoted output rounds to zero — amount too small.");
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const permit2Expiration = deadline;

      // Quoting is NOT executing: Robinhood's tokenized-stock pools price on
      // the Quoter but a direct Universal Router swap bare-reverts (their
      // stock venue is the backend-signed DexAggregator, not public UR
      // calls). Probe BEFORE any signature is requested — never burn a
      // Permit2 grant on a swap that can never land. Gated pools fall
      // through to the guarded LiFi settlement build, whose router IS
      // whitelisted on the aggregator; the honest refusal only survives
      // when LiFi can't fill either.
      const executability = await probeV4Executability(
        { poolKey: best.poolKey, zeroForOne: best.zeroForOne, amountIn, minOut, deadline },
        args.user,
      );
      if (executability === "gated") {
        return buildLifiSwap({ user: args.user, sell, buy, amount: args.amount, amountIn, quoterOut: best.amountOut, tape, skippedPool: null });
      }

      // The signature authorizes minOut, not the quote: with a caller-chosen
      // slippage (up to 50%) a checked quote could still sign away a fill far
      // off the tape. A minimum past the bound skips the pool for LiFi too.
      let minimumVsTape: string | null;
      try {
        minimumVsTape = checkMinimumAgainstTape(
          tape,
          V4_VENUE,
          amountIn,
          minOut,
          `The ${slippageBps / 100}% slippage (slippageBps ${slippageBps}) sets that minimum.`,
        );
      } catch (e) {
        if (!(e instanceof OffTapeMinimumError)) throw e;
        return buildLifiSwap({ user: args.user, sell, buy, amount: args.amount, amountIn, quoterOut: best.amountOut, tape, skippedPool: e });
      }

      const steps: SendTransactionAction[] = [];
      const erc20Allowance = await readRetry(() =>
        client.readContract({ address: sell.address, abi: TOKEN_ABI, functionName: "allowance", args: [args.user, PERMIT2] }),
      );
      if (erc20Allowance < amountIn) {
        steps.push(
          step(`Approve ${sell.symbol} → Permit2`, `Allow Permit2 to pull exactly ${args.amount} ${sell.symbol}.`, {
            to: sell.address,
            data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [PERMIT2, amountIn] }),
          }),
        );
      }
      const [p2Amount, p2Expiration] = await readRetry(() =>
        client.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance", args: [args.user, sell.address, UNIVERSAL_ROUTER] }),
      );
      if (BigInt(p2Amount) < amountIn || Number(p2Expiration) <= Math.floor(Date.now() / 1000)) {
        steps.push(
          step(`Permit2 → Universal Router`, `Allow the Universal Router to spend exactly ${args.amount} ${sell.symbol} via Permit2 (expires with the swap deadline).`, {
            to: PERMIT2,
            data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: "approve", args: [sell.address, UNIVERSAL_ROUTER, amountIn, permit2Expiration] }),
          }),
        );
      }
      const outHuman = formatAtoms(best.amountOut, buy.decimals);
      const minHuman = formatAtoms(minOut, buy.decimals);
      steps.push(
        step(
          `Swap ${sell.symbol} → ${buy.symbol}`,
          `Swap ${args.amount} ${sell.symbol} for ≈${outHuman} ${buy.symbol} (minimum ${minHuman} after ${slippageBps / 100}% slippage) on Uniswap v4 — output credits the signer.`,
          { to: UNIVERSAL_ROUTER, data: encodeV4SwapCalldata({ poolKey: best.poolKey, zeroForOne: best.zeroForOne, amountIn, minOut, deadline }) },
        ),
      );

      // Fail-closed: decode what was just built; refuse on ANY mismatch.
      const verdict = guardV4Build(steps, {
        sellToken: sell.address,
        buyToken: buy.address,
        amountIn,
        minOut,
        poolKey: best.poolKey,
        permit2Expiration,
      });
      if (!verdict.ok) {
        return fail(500, `Guard refused the built swap (artifact withheld): ${verdict.reasons.join(" ")}`);
      }

      return ok({
        operation: "swap",
        venue: "Uniswap v4 (Robinhood Chain)",
        sell: `${args.amount} ${sell.symbol}`,
        buyEstimate: `≈${outHuman} ${buy.symbol}`,
        minimumOut: `${minHuman} ${buy.symbol}`,
        pool: { fee: `${best.poolKey.fee / 10_000}%`, tickSpacing: best.poolKey.tickSpacing, hooks: "none" },
        deadline: new Date(deadline * 1000).toISOString(),
        ...(tapeCheck ? { tapeCheck: { ...tapeCheck, ...(minimumVsTape ? { minimum: minimumVsTape } : {}) } } : {}),
        ...(tapeCheck?.status === "warn" ? { warning: tapeCheck.note } : {}),
        guard: tapeCheck
          ? "passed — calldata decoded and every field verified against the quote; the quote and the minimum out both checked against the stock's tape"
          : "passed — calldata decoded and every field verified against the quote",
        steps,
        submit_with: `Each step is an UNSIGNED transaction for the USER's wallet (eth_sendTransaction), in order — this service never signs. The quote expires at the deadline; if it passes, build again. After the final step confirms, the ${buy.symbol} is in the wallet — check with portfolio.`,
      });
    } catch (e) {
      return fail(502, `Build failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
