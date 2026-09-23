// Construction-only transaction building against the pinned Morpho Blue
// singleton on Ethereum + Base (ported from services/robinhood/lib/tx.ts
// with chainId threaded; the bridge builders stayed behind). Calldata is
// encoded locally with viem from the pinned ABIs in chain.ts and validated
// against the sender's REAL on-chain balances, allowances, and market
// health before anything is returned; each flow comes back as ordered
// `send_transaction` steps — the same {action:'send_transaction', tx:{…}}
// contract the uniswap/aave/lido siblings use, so the chat renders
// approve→act chains as sign buttons. Nothing here ever signs or submits.

import { encodeFunctionData } from "viem";
import { MORPHO_ABI, TOKEN_ABI, readRetry, rpcFor } from "./chain";
import { MORPHO_BY_CHAIN, type Address, type SupportedChainId } from "./registry";
import {
  ORACLE_PRICE_SCALE,
  accrueMarket,
  borrowRateOf,
  marketParamsOf,
  marketStateOf,
  oraclePriceOf,
  toAssetsDown,
  toAssetsUp,
  type MarketParams,
  type MarketState,
} from "./morpho";
import { fail, formatAtoms, humanToAtoms, ok, type MorphoResult } from "./util";

/** A transaction for the USER to sign — the transaction-layer contract. */
export interface SendTransactionAction {
  action: "send_transaction";
  label: string;
  summary: string;
  tx: { to: string; data: string; value: string; chainId: number };
}

const ZERO = "0x0000000000000000000000000000000000000000";
const WAD = 10n ** 18n;

export const step = (
  label: string,
  summary: string,
  tx: { to: string; data?: string; value?: bigint; chainId: number },
): SendTransactionAction => ({
  action: "send_transaction",
  label,
  summary,
  tx: { to: tx.to, data: tx.data ?? "0x", value: (tx.value ?? 0n).toString(), chainId: tx.chainId },
});

const submitWith = (after: string) =>
  `Each step is an UNSIGNED transaction for the USER's wallet (eth_sendTransaction), in order — this service never signs. After the final step confirms, ${after}`;

// ── Shared plumbing ────────────────────────────────────────────────────────

interface AssetMeta {
  address: Address;
  symbol: string;
  decimals: number;
}

/** Symbol fail-soft (display only); decimals STRICT — a build must never guess them. */
async function erc20Meta(chainId: SupportedChainId, address: Address): Promise<AssetMeta> {
  const client = rpcFor(chainId);
  const [symbol, decimals] = await Promise.all([
    readRetry(() => client.readContract({ address, abi: TOKEN_ABI, functionName: "symbol" })).catch(() => "token"),
    readRetry(() => client.readContract({ address, abi: TOKEN_ABI, functionName: "decimals" })),
  ]);
  return { address, symbol, decimals: Number(decimals) };
}

const balanceOf = (chainId: SupportedChainId, token: Address, owner: Address): Promise<bigint> =>
  readRetry(() => rpcFor(chainId).readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [owner] }));

const allowanceOf = (chainId: SupportedChainId, token: Address, owner: Address, spender: Address): Promise<bigint> =>
  readRetry(() => rpcFor(chainId).readContract({ address: token, abi: TOKEN_ABI, functionName: "allowance", args: [owner, spender] }));

/**
 * Tokens whose approve() REVERTS when the live allowance and the new amount
 * are both non-zero. Measured on a fork, not guessed: Ethereum's USDT is the
 * one such token among the assets this service meets (Base's bridged
 * stables, USDC, DAI, WETH and WBTC all take a non-zero → non-zero change).
 * A repay-max approve is buffered ~0.05% over the debt, so it routinely
 * LEAVES a dust allowance — the next USDT lend or repay would then revert at
 * its approve, after the user signed it.
 */
const APPROVE_RESET_TOKENS: Partial<Record<SupportedChainId, readonly string[]>> = {
  1: ["0xdac17f958d2ee523a2206206994597c13d831ec7"], // USDT
};

export const approveNeedsReset = (chainId: SupportedChainId, token: string): boolean =>
  (APPROVE_RESET_TOKENS[chainId] ?? []).includes(token.toLowerCase());

/**
 * The exact-amount ERC-20 approve step(s) — none when the live allowance
 * covers the amount; on a reset token with a partial allowance, an
 * approve(spender, 0) first.
 */
async function approveStepsIfNeeded(
  chainId: SupportedChainId,
  asset: AssetMeta,
  owner: Address,
  spender: Address,
  atoms: bigint,
  spenderName: string,
): Promise<SendTransactionAction[]> {
  const allowance = await allowanceOf(chainId, asset.address, owner, spender);
  if (allowance >= atoms) return [];
  const approveData = (amount: bigint) => encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [spender, amount] });
  const steps: SendTransactionAction[] = [];
  if (allowance > 0n && approveNeedsReset(chainId, asset.address)) {
    steps.push(
      step(
        `Clear the old ${asset.symbol} allowance`,
        `${asset.symbol} refuses to change an allowance that is already set, so the older, smaller one to ${spenderName} is cleared first.`,
        { to: asset.address, data: approveData(0n), chainId },
      ),
    );
  }
  steps.push(
    step(
      `Approve ${asset.symbol}`,
      `Allow ${spenderName} to pull exactly ${formatAtoms(atoms, asset.decimals)} ${asset.symbol}.`,
      { to: asset.address, data: approveData(atoms), chainId },
    ),
  );
  return steps;
}

interface LoadedMarket {
  chainId: SupportedChainId;
  chainName: string;
  morpho: Address;
  id: `0x${string}`;
  params: MarketParams;
  state: MarketState; // interest-accrued to now
  rawState: MarketState;
  loan: AssetMeta;
  collateral: AssetMeta;
  label: string;
}

async function loadMarket(chainId: SupportedChainId, marketId: string): Promise<LoadedMarket | MorphoResult> {
  const chain = MORPHO_BY_CHAIN[chainId];
  if (!/^0x[0-9a-fA-F]{64}$/.test(marketId)) {
    return fail(400, `Invalid marketId "${marketId}" — pass the 32-byte market id from \`markets\`.`);
  }
  const id = marketId as `0x${string}`;
  const params = await marketParamsOf(chainId, id);
  if (params.loanToken.toLowerCase() === ZERO) {
    return fail(404, `No Morpho market with id ${marketId} on ${chain.name} — call \`markets\` for live ids (and check the chainId: this market may live on the other chain).`);
  }
  const rawState = await marketStateOf(chainId, id);
  const rate = await borrowRateOf(chainId, params, rawState);
  const state = accrueMarket(rawState, rate, Date.now() / 1000);
  const [loan, collateral] = await Promise.all([erc20Meta(chainId, params.loanToken), erc20Meta(chainId, params.collateralToken)]);
  return { chainId, chainName: chain.name, morpho: chain.morpho, id, params, state, rawState, loan, collateral, label: `${loan.symbol}/${collateral.symbol}` };
}

const isResult = (x: LoadedMarket | MorphoResult): x is MorphoResult => "ok" in x;

/** Health check for a hypothetical (collateral, debt) — null when the oracle won't answer. */
async function healthAfter(m: LoadedMarket, collateralAtoms: bigint, debtAtoms: bigint): Promise<{ maxBorrow: bigint; healthFactor: number | null } | null> {
  if (debtAtoms === 0n) return { maxBorrow: 0n, healthFactor: null };
  const price = await oraclePriceOf(m.chainId, m.params);
  if (price == null) return null; // no oracle answer — callers refuse rather than guess
  const collateralInLoan = (collateralAtoms * price) / ORACLE_PRICE_SCALE;
  const maxBorrow = (collateralInLoan * m.params.lltv) / WAD;
  return { maxBorrow, healthFactor: Number((maxBorrow * 1000n) / debtAtoms) / 1000 };
}

async function userPosition(m: LoadedMarket, user: Address) {
  const pos = await readRetry(() =>
    rpcFor(m.chainId).readContract({ address: m.morpho, abi: MORPHO_ABI, functionName: "position", args: [m.id, user] }),
  );
  return {
    supplyShares: pos.supplyShares,
    borrowShares: BigInt(pos.borrowShares),
    collateral: BigInt(pos.collateral),
    supplied: toAssetsDown(pos.supplyShares, m.state.totalSupplyAssets, m.state.totalSupplyShares),
    debt: toAssetsUp(BigInt(pos.borrowShares), m.state.totalBorrowAssets, m.state.totalBorrowShares),
  };
}

const marketParamsArg = (p: MarketParams) =>
  ({ loanToken: p.loanToken, collateralToken: p.collateralToken, oracle: p.oracle, irm: p.irm, lltv: p.lltv }) as const;

// ── Preview (local health-factor simulation — nothing built) ───────────────

export type PreviewAction = "lend" | "supply_collateral" | "borrow" | "repay" | "withdraw" | "withdraw_collateral";

export interface PreviewArgs {
  chainId: SupportedChainId;
  user: Address;
  marketId: string;
  action: PreviewAction;
  amount: string; // decimal, or "max" for repay/withdraw/withdraw_collateral
}

const hfLabel = (hf: number | null) => (hf == null ? "∞ (no debt)" : String(hf));

/**
 * Simulate an action's effect on the position BEFORE building it: health
 * factor now vs after, borrowing power after — computed locally from live
 * on-chain state + the market oracle. Nothing is built or signed.
 */
export async function preview(args: PreviewArgs): Promise<MorphoResult> {
  try {
    const m = await loadMarket(args.chainId, args.marketId);
    if (isResult(m)) return m;
    const pos = await userPosition(m, args.user);

    const max = args.amount === "max";
    const maxable: PreviewAction[] = ["repay", "withdraw", "withdraw_collateral"];
    if (max && !maxable.includes(args.action)) {
      return fail(400, `"max" only applies to ${maxable.join("/")} — pass an explicit amount for ${args.action}.`);
    }
    const decimals = args.action === "supply_collateral" || args.action === "withdraw_collateral" ? m.collateral.decimals : m.loan.decimals;
    const atoms = max
      ? args.action === "repay"
        ? pos.debt
        : args.action === "withdraw"
          ? pos.supplied
          : pos.collateral
      : humanToAtoms(args.amount, decimals);
    if (atoms == null || (atoms === 0n && !max)) {
      return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal, or "max" for repay/withdraw/withdraw_collateral.`);
    }

    // The hypothetical position after the action.
    let collateral = pos.collateral;
    let debt = pos.debt;
    let supplied = pos.supplied;
    const warnings: string[] = [];
    switch (args.action) {
      case "lend":
        supplied += atoms;
        break;
      case "withdraw":
        if (atoms > pos.supplied) warnings.push(`Withdrawing more than the ${formatAtoms(pos.supplied, m.loan.decimals)} ${m.loan.symbol} supplied — build_withdraw would refuse.`);
        supplied = supplied > atoms ? supplied - atoms : 0n;
        break;
      case "supply_collateral":
        collateral += atoms;
        break;
      case "withdraw_collateral":
        if (atoms > pos.collateral) warnings.push(`Withdrawing more than the ${formatAtoms(pos.collateral, m.collateral.decimals)} ${m.collateral.symbol} posted — build_withdraw_collateral would refuse.`);
        collateral = collateral > atoms ? collateral - atoms : 0n;
        break;
      case "borrow":
        debt += atoms;
        break;
      case "repay":
        if (!max && atoms > pos.debt) warnings.push(`Repaying more than the ${formatAtoms(pos.debt, m.loan.decimals)} ${m.loan.symbol} owed — build_repay would refuse (use "max").`);
        debt = debt > atoms ? debt - atoms : 0n;
        break;
    }

    // One oracle read serves before AND after (unlike healthAfter, previews
    // also want borrowing power at zero debt).
    let price: bigint | null = null;
    if (pos.collateral > 0n || collateral > 0n) {
      price = await oraclePriceOf(args.chainId, m.params);
      if (price == null) {
        return fail(502, "The market's oracle returned no price — refusing to simulate health blind (builds against this market refuse too).");
      }
    }
    const maxBorrowOf = (coll: bigint) => (price != null ? ((coll * price) / ORACLE_PRICE_SCALE) * m.params.lltv / WAD : 0n);
    const hfOf = (coll: bigint, d: bigint) => (d > 0n ? Number((maxBorrowOf(coll) * 1000n) / d) / 1000 : null);
    const hfBefore = hfOf(pos.collateral, pos.debt);
    const hfAfter = hfOf(collateral, debt);
    const maxBorrowAfter = maxBorrowOf(collateral);
    if (hfAfter != null && hfAfter < 1) warnings.push("Health factor after would be UNDER 1 — the position would be liquidatable; the build tools refuse this.");
    else if (hfAfter != null && hfAfter < 1.1) warnings.push("Health factor after is under 1.10 — a small price move could liquidate the collateral.");
    if (args.action === "borrow" && debt > maxBorrowAfter) {
      warnings.push("Exceeds the collateral's borrowing power — build_borrow would refuse.");
    }

    return ok({
      operation: "preview",
      chainId: args.chainId,
      chain: m.chainName,
      market: m.label,
      marketId: m.id,
      action: args.action,
      amount: max ? "max" : args.amount,
      position: {
        before: {
          supplied: `${formatAtoms(pos.supplied, m.loan.decimals)} ${m.loan.symbol}`,
          collateral: `${formatAtoms(pos.collateral, m.collateral.decimals)} ${m.collateral.symbol}`,
          debt: `${formatAtoms(pos.debt, m.loan.decimals)} ${m.loan.symbol}`,
          healthFactor: hfLabel(hfBefore),
        },
        after: {
          supplied: `${formatAtoms(supplied, m.loan.decimals)} ${m.loan.symbol}`,
          collateral: `${formatAtoms(collateral, m.collateral.decimals)} ${m.collateral.symbol}`,
          debt: `${formatAtoms(debt, m.loan.decimals)} ${m.loan.symbol}`,
          healthFactor: hfLabel(hfAfter),
          ...(collateral > 0n
            ? {
                borrowingPower: {
                  maxBorrow: formatAtoms(maxBorrowAfter, m.loan.decimals),
                  remaining: formatAtoms(maxBorrowAfter > debt ? maxBorrowAfter - debt : 0n, m.loan.decimals),
                  asset: m.loan.symbol,
                },
              }
            : {}),
        },
      },
      ...(warnings.length ? { warnings } : {}),
      note: "Simulation only — nothing was built or signed. Numbers come from live on-chain state and the market's oracle.",
    });
  } catch (e) {
    return fail(502, `Preview failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Builders ───────────────────────────────────────────────────────────────

export interface BuildArgs {
  chainId: SupportedChainId;
  user: Address;
  marketId: string;
  amount: string;
}

export const builds = {
  /** Supply the LOAN asset to earn interest (Morpho `supply`). */
  async lend(args: BuildArgs): Promise<MorphoResult> {
    try {
      const m = await loadMarket(args.chainId, args.marketId);
      if (isResult(m)) return m;
      const atoms = humanToAtoms(args.amount, m.loan.decimals);
      if (!atoms) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal like "100" (${m.loan.symbol} has ${m.loan.decimals} decimals).`);
      const balance = await balanceOf(args.chainId, m.loan.address, args.user);
      if (atoms > balance) {
        return fail(400, `Insufficient ${m.loan.symbol}: lending ${args.amount} but the wallet holds ${formatAtoms(balance, m.loan.decimals)} on ${m.chainName}. Nothing was built.`);
      }
      const approves = await approveStepsIfNeeded(args.chainId, m.loan, args.user, m.morpho, atoms, "Morpho");
      const supply = step(
        `Lend ${m.loan.symbol}`,
        `Supply ${args.amount} ${m.loan.symbol} to the Morpho ${m.label} market on ${m.chainName} — starts earning the market's supply APY immediately.`,
        {
          to: m.morpho,
          data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "supply", args: [marketParamsArg(m.params), atoms, 0n, args.user, "0x"] }),
          chainId: args.chainId,
        },
      );
      return ok({
        operation: "lend",
        chainId: args.chainId,
        chain: m.chainName,
        market: m.label,
        marketId: m.id,
        amount: `${args.amount} ${m.loan.symbol}`,
        steps: [...approves, supply],
        submit_with: submitWith(`the ${m.loan.symbol} is supplied and earning — track it with \`position\`.`),
      });
    } catch (e) {
      return fail(502, `Build failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Post the COLLATERAL asset (doesn't earn; enables borrowing). */
  async supplyCollateral(args: BuildArgs): Promise<MorphoResult> {
    try {
      const m = await loadMarket(args.chainId, args.marketId);
      if (isResult(m)) return m;
      const atoms = humanToAtoms(args.amount, m.collateral.decimals);
      if (!atoms) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal like "1.5".`);
      const balance = await balanceOf(args.chainId, m.collateral.address, args.user);
      if (atoms > balance) {
        return fail(400, `Insufficient ${m.collateral.symbol}: posting ${args.amount} but the wallet holds ${formatAtoms(balance, m.collateral.decimals)} on ${m.chainName}. Nothing was built.`);
      }
      const approves = await approveStepsIfNeeded(args.chainId, m.collateral, args.user, m.morpho, atoms, "Morpho");
      const post = step(
        `Post ${m.collateral.symbol} collateral`,
        `Deposit ${args.amount} ${m.collateral.symbol} as collateral in the Morpho ${m.label} market on ${m.chainName} (collateral does not earn interest; it unlocks borrowing ${m.loan.symbol}).`,
        {
          to: m.morpho,
          data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "supplyCollateral", args: [marketParamsArg(m.params), atoms, args.user, "0x"] }),
          chainId: args.chainId,
        },
      );
      return ok({
        operation: "supply_collateral",
        chainId: args.chainId,
        chain: m.chainName,
        market: m.label,
        marketId: m.id,
        amount: `${args.amount} ${m.collateral.symbol}`,
        steps: [...approves, post],
        submit_with: submitWith(`the collateral is posted — build_borrow can now draw ${m.loan.symbol} against it.`),
      });
    } catch (e) {
      return fail(502, `Build failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Borrow the loan asset against posted collateral — fails closed on health. */
  async borrow(args: BuildArgs): Promise<MorphoResult> {
    try {
      const m = await loadMarket(args.chainId, args.marketId);
      if (isResult(m)) return m;
      const atoms = humanToAtoms(args.amount, m.loan.decimals);
      if (!atoms) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal like "50".`);
      const pos = await userPosition(m, args.user);
      if (pos.collateral === 0n) {
        return fail(400, `No collateral posted in the Morpho ${m.label} market on ${m.chainName} — build_supply_collateral first. Nothing was built.`);
      }
      const liquidity = m.state.totalSupplyAssets - m.state.totalBorrowAssets;
      if (atoms > liquidity) {
        return fail(400, `The market only has ${formatAtoms(liquidity, m.loan.decimals)} ${m.loan.symbol} available to borrow right now. Nothing was built.`);
      }
      const newDebt = pos.debt + atoms;
      const health = await healthAfter(m, pos.collateral, newDebt);
      if (!health) return fail(502, "The market's oracle returned no price — refusing to build a borrow blind.");
      if (newDebt > health.maxBorrow) {
        return fail(
          400,
          `Borrowing ${args.amount} ${m.loan.symbol} would exceed the collateral's borrowing power (${formatAtoms(health.maxBorrow > pos.debt ? health.maxBorrow - pos.debt : 0n, m.loan.decimals)} ${m.loan.symbol} still available at lltv ${(Number(m.params.lltv) / 1e16).toFixed(1)}%). Nothing was built.`,
        );
      }
      const borrow = step(
        `Borrow ${m.loan.symbol}`,
        `Borrow ${args.amount} ${m.loan.symbol} from the Morpho ${m.label} market on ${m.chainName} against your ${m.collateral.symbol} collateral — health factor after: ${health.healthFactor}.`,
        {
          to: m.morpho,
          data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "borrow", args: [marketParamsArg(m.params), atoms, 0n, args.user, args.user] }),
          chainId: args.chainId,
        },
      );
      return ok({
        operation: "borrow",
        chainId: args.chainId,
        chain: m.chainName,
        market: m.label,
        marketId: m.id,
        amount: `${args.amount} ${m.loan.symbol}`,
        healthFactorAfter: health.healthFactor,
        ...(health.healthFactor != null && health.healthFactor < 1.1
          ? { warning: "⚠️ Health factor after this borrow is under 1.10 — a small price move could liquidate the collateral. Consider borrowing less." }
          : {}),
        steps: [borrow],
        submit_with: submitWith(`the ${m.loan.symbol} lands in the wallet; interest accrues at the market's borrow APY — watch healthFactor with \`position\`.`),
      });
    } catch (e) {
      return fail(502, `Build failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Repay borrowed loan asset ("max" clears the debt exactly, by shares). */
  async repay(args: BuildArgs): Promise<MorphoResult> {
    try {
      const m = await loadMarket(args.chainId, args.marketId);
      if (isResult(m)) return m;
      const pos = await userPosition(m, args.user);
      if (pos.debt === 0n) return fail(400, `Nothing to repay — no ${m.loan.symbol} debt in the Morpho ${m.label} market on ${m.chainName}.`);
      const balance = await balanceOf(args.chainId, m.loan.address, args.user);

      if (args.amount === "max") {
        // Shares-mode repay clears the debt EXACTLY even as interest accrues
        // between build and sign; the approval carries a small buffer for
        // that drift (unused allowance dust may remain).
        const buffer = pos.debt / 2000n + 1n; // ~0.05%
        const approveAtoms = pos.debt + buffer;
        if (approveAtoms > balance) {
          return fail(400, `Full repayment needs ~${formatAtoms(approveAtoms, m.loan.decimals)} ${m.loan.symbol} (debt + drift buffer) but the wallet holds ${formatAtoms(balance, m.loan.decimals)}. Repay a smaller amount or top up first.`);
        }
        const approves = await approveStepsIfNeeded(args.chainId, m.loan, args.user, m.morpho, approveAtoms, "Morpho");
        const repay = step(
          `Repay all ${m.loan.symbol}`,
          `Repay the entire ${formatAtoms(pos.debt, m.loan.decimals)} ${m.loan.symbol} debt in the Morpho ${m.label} market on ${m.chainName} (repaid by shares, so it clears exactly).`,
          {
            to: m.morpho,
            data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "repay", args: [marketParamsArg(m.params), 0n, pos.borrowShares, args.user, "0x"] }),
            chainId: args.chainId,
          },
        );
        return ok({
          operation: "repay",
          chainId: args.chainId,
          chain: m.chainName,
          market: m.label,
          marketId: m.id,
          amount: `all (~${formatAtoms(pos.debt, m.loan.decimals)} ${m.loan.symbol})`,
          steps: [...approves, repay],
          note: "The approval includes a ~0.05% buffer for interest accruing before you sign; any unused allowance stays as dust.",
          submit_with: submitWith("the debt is cleared — collateral can then be withdrawn with build_withdraw_collateral."),
        });
      }

      const atoms = humanToAtoms(args.amount, m.loan.decimals);
      if (!atoms) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal like "50", or "max" to clear the debt.`);
      if (atoms > pos.debt) {
        return fail(400, `Repaying ${args.amount} ${m.loan.symbol} exceeds the current debt of ${formatAtoms(pos.debt, m.loan.decimals)} — pass "max" to clear it exactly.`);
      }
      if (atoms > balance) {
        return fail(400, `Insufficient ${m.loan.symbol}: repaying ${args.amount} but the wallet holds ${formatAtoms(balance, m.loan.decimals)} on ${m.chainName}. Nothing was built.`);
      }
      const approves = await approveStepsIfNeeded(args.chainId, m.loan, args.user, m.morpho, atoms, "Morpho");
      const repay = step(
        `Repay ${m.loan.symbol}`,
        `Repay ${args.amount} ${m.loan.symbol} of the ${formatAtoms(pos.debt, m.loan.decimals)} ${m.loan.symbol} debt in the Morpho ${m.label} market on ${m.chainName}.`,
        {
          to: m.morpho,
          data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "repay", args: [marketParamsArg(m.params), atoms, 0n, args.user, "0x"] }),
          chainId: args.chainId,
        },
      );
      return ok({
        operation: "repay",
        chainId: args.chainId,
        chain: m.chainName,
        market: m.label,
        marketId: m.id,
        amount: `${args.amount} ${m.loan.symbol}`,
        steps: [...approves, repay],
        submit_with: submitWith("the debt shrinks and the health factor improves — check `position`."),
      });
    } catch (e) {
      return fail(502, `Build failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Withdraw supplied loan asset ("max" empties the position, by shares). */
  async withdraw(args: BuildArgs): Promise<MorphoResult> {
    try {
      const m = await loadMarket(args.chainId, args.marketId);
      if (isResult(m)) return m;
      const pos = await userPosition(m, args.user);
      if (pos.supplied === 0n) return fail(400, `Nothing supplied — no ${m.loan.symbol} lent in the Morpho ${m.label} market on ${m.chainName}.`);
      const liquidity = m.state.totalSupplyAssets - m.state.totalBorrowAssets;

      const max = args.amount === "max";
      const atoms = max ? pos.supplied : humanToAtoms(args.amount, m.loan.decimals);
      if (!atoms) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal like "100", or "max".`);
      if (!max && atoms > pos.supplied) {
        return fail(400, `Withdrawing ${args.amount} ${m.loan.symbol} exceeds the supplied balance of ${formatAtoms(pos.supplied, m.loan.decimals)} — pass "max" to withdraw everything.`);
      }
      if (atoms > liquidity) {
        return fail(400, `The market only has ${formatAtoms(liquidity, m.loan.decimals)} ${m.loan.symbol} un-borrowed right now (utilization is high) — withdraw less or retry later. Nothing was built.`);
      }
      const withdraw = step(
        `Withdraw ${m.loan.symbol}`,
        max
          ? `Withdraw the full ~${formatAtoms(pos.supplied, m.loan.decimals)} ${m.loan.symbol} supplied to the Morpho ${m.label} market on ${m.chainName} (by shares, so accrued interest comes too).`
          : `Withdraw ${args.amount} ${m.loan.symbol} from the Morpho ${m.label} market on ${m.chainName}.`,
        {
          to: m.morpho,
          data: encodeFunctionData({
            abi: MORPHO_ABI,
            functionName: "withdraw",
            args: max ? [marketParamsArg(m.params), 0n, pos.supplyShares, args.user, args.user] : [marketParamsArg(m.params), atoms, 0n, args.user, args.user],
          }),
          chainId: args.chainId,
        },
      );
      return ok({
        operation: "withdraw",
        chainId: args.chainId,
        chain: m.chainName,
        market: m.label,
        marketId: m.id,
        amount: max ? `all (~${formatAtoms(pos.supplied, m.loan.decimals)} ${m.loan.symbol})` : `${args.amount} ${m.loan.symbol}`,
        steps: [withdraw],
        submit_with: submitWith(`the ${m.loan.symbol} is back in the wallet.`),
      });
    } catch (e) {
      return fail(502, `Build failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Withdraw posted collateral — fails closed if it would endanger the debt. */
  async withdrawCollateral(args: BuildArgs): Promise<MorphoResult> {
    try {
      const m = await loadMarket(args.chainId, args.marketId);
      if (isResult(m)) return m;
      const pos = await userPosition(m, args.user);
      if (pos.collateral === 0n) return fail(400, `No ${m.collateral.symbol} collateral posted in the Morpho ${m.label} market on ${m.chainName}.`);

      const max = args.amount === "max";
      const atoms = max ? pos.collateral : humanToAtoms(args.amount, m.collateral.decimals);
      if (!atoms) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal like "1.5", or "max".`);
      if (atoms > pos.collateral) {
        return fail(400, `Withdrawing ${args.amount} ${m.collateral.symbol} exceeds the posted collateral of ${formatAtoms(pos.collateral, m.collateral.decimals)}.`);
      }
      if (pos.debt > 0n) {
        const health = await healthAfter(m, pos.collateral - atoms, pos.debt);
        if (!health) return fail(502, "The market's oracle returned no price — refusing to build a collateral withdrawal blind.");
        if (pos.debt > health.maxBorrow) {
          return fail(
            400,
            `Withdrawing ${max ? "all" : args.amount} ${m.collateral.symbol} would leave the ${formatAtoms(pos.debt, m.loan.decimals)} ${m.loan.symbol} debt under-collateralized (health factor ${health.healthFactor}). Repay first with build_repay. Nothing was built.`,
          );
        }
        if (health.healthFactor != null && health.healthFactor < 1.1) {
          return fail(
            400,
            `Withdrawing that much ${m.collateral.symbol} drops the health factor to ${health.healthFactor} — too close to liquidation for this service to build. Withdraw less or repay debt first.`,
          );
        }
      }
      const withdraw = step(
        `Withdraw ${m.collateral.symbol} collateral`,
        `Withdraw ${max ? `all ${formatAtoms(pos.collateral, m.collateral.decimals)}` : args.amount} ${m.collateral.symbol} collateral from the Morpho ${m.label} market on ${m.chainName}.`,
        {
          to: m.morpho,
          data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "withdrawCollateral", args: [marketParamsArg(m.params), atoms, args.user, args.user] }),
          chainId: args.chainId,
        },
      );
      return ok({
        operation: "withdraw_collateral",
        chainId: args.chainId,
        chain: m.chainName,
        market: m.label,
        marketId: m.id,
        amount: `${max ? formatAtoms(pos.collateral, m.collateral.decimals) : args.amount} ${m.collateral.symbol}`,
        steps: [withdraw],
        submit_with: submitWith(`the ${m.collateral.symbol} is back in the wallet.`),
      });
    } catch (e) {
      return fail(502, `Build failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
