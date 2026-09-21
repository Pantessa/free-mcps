// Construction-only transaction building against the pinned Robinhood Chain
// contracts (Morpho + the canonical Arbitrum bridge; swaps live in swap.ts).
// Calldata is encoded locally with viem from the pinned ABIs in chain.ts and
// validated against the sender's REAL on-chain balances, allowances, and
// market health before anything is returned; each flow comes back as ordered
// `send_transaction` steps — the same {action:'send_transaction', tx:{…}}
// contract the uniswap/aave/lido siblings use, so the chat renders
// approve→act chains as sign buttons. Nothing here ever signs or submits.

import { encodeFunctionData, parseEther } from "viem";
import {
  ARB_SYS_ABI,
  INBOX_ABI,
  MORPHO_ABI,
  TOKEN_ABI,
  l1Rpc,
  readRetry,
  rpc,
} from "./chain";
import {
  ARB_SYS,
  BRIDGE_UI,
  CHAIN_ID,
  L1_CHAIN_ID,
  L1_INBOX,
  MORPHO,
  tokenByAddress,
  type Address,
} from "./registry";
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
import { fail, formatAtoms, humanToAtoms, ok, type RhResult } from "./util";

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
  tx: { to: string; data?: string; value?: bigint; chainId?: number },
): SendTransactionAction => ({
  action: "send_transaction",
  label,
  summary,
  tx: { to: tx.to, data: tx.data ?? "0x", value: (tx.value ?? 0n).toString(), chainId: tx.chainId ?? CHAIN_ID },
});

const submitWith = (after: string) =>
  `Each step is an UNSIGNED transaction for the USER's wallet (eth_sendTransaction), in order — this service never signs. After the final step confirms, ${after}`;

const fmtEth = (wei: bigint): string => {
  const s = formatAtoms(wei, 18);
  const n = Number(s);
  return n !== 0 && Math.abs(n) < 1e-6 ? s : String(Number(n.toFixed(6)));
};

// ── Shared plumbing ────────────────────────────────────────────────────────

interface AssetMeta {
  address: Address;
  symbol: string;
  decimals: number;
}

async function erc20Meta(address: Address): Promise<AssetMeta> {
  const known = tokenByAddress(address);
  if (known) return { address, symbol: known.symbol, decimals: known.decimals };
  const client = rpc();
  const [symbol, decimals] = await Promise.all([
    readRetry(() =>
      client.readContract({
        address,
        abi: [{ name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] }] as const,
        functionName: "symbol",
      }),
    ).catch(() => "token"),
    readRetry(() => client.readContract({ address, abi: TOKEN_ABI, functionName: "decimals" })),
  ]);
  return { address, symbol, decimals: Number(decimals) };
}

const balanceOf = (token: Address, owner: Address): Promise<bigint> =>
  readRetry(() => rpc().readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [owner] }));

const allowanceOf = (token: Address, owner: Address, spender: Address): Promise<bigint> =>
  readRetry(() => rpc().readContract({ address: token, abi: TOKEN_ABI, functionName: "allowance", args: [owner, spender] }));

/** An exact-amount ERC-20 approve step — only when the live allowance is short. */
async function approveStepIfNeeded(asset: AssetMeta, owner: Address, spender: Address, atoms: bigint, spenderName: string): Promise<SendTransactionAction | null> {
  const allowance = await allowanceOf(asset.address, owner, spender);
  if (allowance >= atoms) return null;
  return step(
    `Approve ${asset.symbol}`,
    `Allow ${spenderName} to pull exactly ${formatAtoms(atoms, asset.decimals)} ${asset.symbol}.`,
    { to: asset.address, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [spender, atoms] }) },
  );
}

interface LoadedMarket {
  id: `0x${string}`;
  params: MarketParams;
  state: MarketState; // interest-accrued to now
  rawState: MarketState;
  loan: AssetMeta;
  collateral: AssetMeta;
  label: string;
}

async function loadMarket(marketId: string): Promise<LoadedMarket | RhResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(marketId)) {
    return fail(400, `Invalid marketId "${marketId}" — pass the 32-byte market id from lending_markets.`);
  }
  const id = marketId as `0x${string}`;
  const params = await marketParamsOf(id);
  if (params.loanToken.toLowerCase() === ZERO) {
    return fail(404, `No Morpho market with id ${marketId} on Robinhood Chain — call lending_markets for live ids.`);
  }
  const rawState = await marketStateOf(id);
  const rate = await borrowRateOf(params, rawState);
  const state = accrueMarket(rawState, rate, Date.now() / 1000);
  const [loan, collateral] = await Promise.all([erc20Meta(params.loanToken), erc20Meta(params.collateralToken)]);
  return { id, params, state, rawState, loan, collateral, label: `${loan.symbol}/${collateral.symbol}` };
}

const isResult = (x: LoadedMarket | RhResult): x is RhResult => "ok" in x;

/** Health check for a hypothetical (collateral, debt) — null when debt is 0. */
async function healthAfter(m: LoadedMarket, collateralAtoms: bigint, debtAtoms: bigint): Promise<{ maxBorrow: bigint; healthFactor: number | null } | null> {
  if (debtAtoms === 0n) return { maxBorrow: 0n, healthFactor: null };
  const price = await oraclePriceOf(m.params);
  if (price == null) return null; // no oracle answer — callers refuse rather than guess
  const collateralInLoan = (collateralAtoms * price) / ORACLE_PRICE_SCALE;
  const maxBorrow = (collateralInLoan * m.params.lltv) / WAD;
  return { maxBorrow, healthFactor: Number((maxBorrow * 1000n) / debtAtoms) / 1000 };
}

async function userPosition(m: LoadedMarket, user: Address) {
  const pos = await readRetry(() =>
    rpc().readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "position", args: [m.id, user] }),
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

// ── Builders ───────────────────────────────────────────────────────────────

export const builds = {
  /** Supply the LOAN asset to earn interest (Morpho `supply`). */
  async lend(args: { user: Address; marketId: string; amount: string }): Promise<RhResult> {
    try {
      const m = await loadMarket(args.marketId);
      if (isResult(m)) return m;
      const atoms = humanToAtoms(args.amount, m.loan.decimals);
      if (!atoms) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal like "100" (${m.loan.symbol} has ${m.loan.decimals} decimals).`);
      const balance = await balanceOf(m.loan.address, args.user);
      if (atoms > balance) {
        return fail(400, `Insufficient ${m.loan.symbol}: lending ${args.amount} but the wallet holds ${formatAtoms(balance, m.loan.decimals)}. Nothing was built.`);
      }
      const approve = await approveStepIfNeeded(m.loan, args.user, MORPHO, atoms, "Morpho");
      const supply = step(
        `Lend ${m.loan.symbol}`,
        `Supply ${args.amount} ${m.loan.symbol} to the Morpho ${m.label} market — starts earning the market's supply APY immediately.`,
        {
          to: MORPHO,
          data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "supply", args: [marketParamsArg(m.params), atoms, 0n, args.user, "0x"] }),
        },
      );
      return ok({
        operation: "lend",
        market: m.label,
        marketId: m.id,
        amount: `${args.amount} ${m.loan.symbol}`,
        steps: [approve, supply].filter(Boolean),
        submit_with: submitWith(`the ${m.loan.symbol} is supplied and earning — track it with lending_position.`),
      });
    } catch (e) {
      return fail(502, `Build failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Post the COLLATERAL asset (doesn't earn; enables borrowing). */
  async supplyCollateral(args: { user: Address; marketId: string; amount: string }): Promise<RhResult> {
    try {
      const m = await loadMarket(args.marketId);
      if (isResult(m)) return m;
      const atoms = humanToAtoms(args.amount, m.collateral.decimals);
      if (!atoms) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal like "1.5".`);
      const balance = await balanceOf(m.collateral.address, args.user);
      if (atoms > balance) {
        return fail(400, `Insufficient ${m.collateral.symbol}: posting ${args.amount} but the wallet holds ${formatAtoms(balance, m.collateral.decimals)}. Nothing was built.`);
      }
      const approve = await approveStepIfNeeded(m.collateral, args.user, MORPHO, atoms, "Morpho");
      const post = step(
        `Post ${m.collateral.symbol} collateral`,
        `Deposit ${args.amount} ${m.collateral.symbol} as collateral in the Morpho ${m.label} market (collateral does not earn interest; it unlocks borrowing ${m.loan.symbol}).`,
        {
          to: MORPHO,
          data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "supplyCollateral", args: [marketParamsArg(m.params), atoms, args.user, "0x"] }),
        },
      );
      return ok({
        operation: "supply_collateral",
        market: m.label,
        marketId: m.id,
        amount: `${args.amount} ${m.collateral.symbol}`,
        steps: [approve, post].filter(Boolean),
        submit_with: submitWith(`the collateral is posted — build_borrow can now draw ${m.loan.symbol} against it.`),
      });
    } catch (e) {
      return fail(502, `Build failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Borrow the loan asset against posted collateral — fails closed on health. */
  async borrow(args: { user: Address; marketId: string; amount: string }): Promise<RhResult> {
    try {
      const m = await loadMarket(args.marketId);
      if (isResult(m)) return m;
      const atoms = humanToAtoms(args.amount, m.loan.decimals);
      if (!atoms) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal like "50".`);
      const pos = await userPosition(m, args.user);
      if (pos.collateral === 0n) {
        return fail(400, `No collateral posted in the Morpho ${m.label} market — build_supply_collateral first. Nothing was built.`);
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
        `Borrow ${args.amount} ${m.loan.symbol} from the Morpho ${m.label} market against your ${m.collateral.symbol} collateral — health factor after: ${health.healthFactor}.`,
        {
          to: MORPHO,
          data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "borrow", args: [marketParamsArg(m.params), atoms, 0n, args.user, args.user] }),
        },
      );
      return ok({
        operation: "borrow",
        market: m.label,
        marketId: m.id,
        amount: `${args.amount} ${m.loan.symbol}`,
        healthFactorAfter: health.healthFactor,
        ...(health.healthFactor != null && health.healthFactor < 1.1
          ? { warning: "⚠️ Health factor after this borrow is under 1.10 — a small price move could liquidate the collateral. Consider borrowing less." }
          : {}),
        steps: [borrow],
        submit_with: submitWith(`the ${m.loan.symbol} lands in the wallet; interest accrues at the market's borrow APY — watch healthFactor with lending_position.`),
      });
    } catch (e) {
      return fail(502, `Build failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Repay borrowed loan asset ("max" clears the debt exactly, by shares). */
  async repay(args: { user: Address; marketId: string; amount: string }): Promise<RhResult> {
    try {
      const m = await loadMarket(args.marketId);
      if (isResult(m)) return m;
      const pos = await userPosition(m, args.user);
      if (pos.debt === 0n) return fail(400, `Nothing to repay — no ${m.loan.symbol} debt in the Morpho ${m.label} market.`);
      const balance = await balanceOf(m.loan.address, args.user);

      if (args.amount === "max") {
        // Shares-mode repay clears the debt EXACTLY even as interest accrues
        // between build and sign; the approval carries a small buffer for
        // that drift (unused allowance dust may remain).
        const buffer = pos.debt / 2000n + 1n; // ~0.05%
        const approveAtoms = pos.debt + buffer;
        if (approveAtoms > balance) {
          return fail(400, `Full repayment needs ~${formatAtoms(approveAtoms, m.loan.decimals)} ${m.loan.symbol} (debt + drift buffer) but the wallet holds ${formatAtoms(balance, m.loan.decimals)}. Repay a smaller amount or top up first.`);
        }
        const approve = await approveStepIfNeeded(m.loan, args.user, MORPHO, approveAtoms, "Morpho");
        const repay = step(
          `Repay all ${m.loan.symbol}`,
          `Repay the entire ${formatAtoms(pos.debt, m.loan.decimals)} ${m.loan.symbol} debt in the Morpho ${m.label} market (repaid by shares, so it clears exactly).`,
          {
            to: MORPHO,
            data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "repay", args: [marketParamsArg(m.params), 0n, pos.borrowShares, args.user, "0x"] }),
          },
        );
        return ok({
          operation: "repay",
          market: m.label,
          marketId: m.id,
          amount: `all (~${formatAtoms(pos.debt, m.loan.decimals)} ${m.loan.symbol})`,
          steps: [approve, repay].filter(Boolean),
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
        return fail(400, `Insufficient ${m.loan.symbol}: repaying ${args.amount} but the wallet holds ${formatAtoms(balance, m.loan.decimals)}. Nothing was built.`);
      }
      const approve = await approveStepIfNeeded(m.loan, args.user, MORPHO, atoms, "Morpho");
      const repay = step(
        `Repay ${m.loan.symbol}`,
        `Repay ${args.amount} ${m.loan.symbol} of the ${formatAtoms(pos.debt, m.loan.decimals)} ${m.loan.symbol} debt in the Morpho ${m.label} market.`,
        {
          to: MORPHO,
          data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "repay", args: [marketParamsArg(m.params), atoms, 0n, args.user, "0x"] }),
        },
      );
      return ok({
        operation: "repay",
        market: m.label,
        marketId: m.id,
        amount: `${args.amount} ${m.loan.symbol}`,
        steps: [approve, repay].filter(Boolean),
        submit_with: submitWith("the debt shrinks and the health factor improves — check lending_position."),
      });
    } catch (e) {
      return fail(502, `Build failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Withdraw supplied loan asset ("max" empties the position, by shares). */
  async withdraw(args: { user: Address; marketId: string; amount: string }): Promise<RhResult> {
    try {
      const m = await loadMarket(args.marketId);
      if (isResult(m)) return m;
      const pos = await userPosition(m, args.user);
      if (pos.supplied === 0n) return fail(400, `Nothing supplied — no ${m.loan.symbol} lent in the Morpho ${m.label} market.`);
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
          ? `Withdraw the full ~${formatAtoms(pos.supplied, m.loan.decimals)} ${m.loan.symbol} supplied to the Morpho ${m.label} market (by shares, so accrued interest comes too).`
          : `Withdraw ${args.amount} ${m.loan.symbol} from the Morpho ${m.label} market.`,
        {
          to: MORPHO,
          data: encodeFunctionData({
            abi: MORPHO_ABI,
            functionName: "withdraw",
            args: max ? [marketParamsArg(m.params), 0n, pos.supplyShares, args.user, args.user] : [marketParamsArg(m.params), atoms, 0n, args.user, args.user],
          }),
        },
      );
      return ok({
        operation: "withdraw",
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
  async withdrawCollateral(args: { user: Address; marketId: string; amount: string }): Promise<RhResult> {
    try {
      const m = await loadMarket(args.marketId);
      if (isResult(m)) return m;
      const pos = await userPosition(m, args.user);
      if (pos.collateral === 0n) return fail(400, `No ${m.collateral.symbol} collateral posted in the Morpho ${m.label} market.`);

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
        `Withdraw ${max ? `all ${formatAtoms(pos.collateral, m.collateral.decimals)}` : args.amount} ${m.collateral.symbol} collateral from the Morpho ${m.label} market.`,
        {
          to: MORPHO,
          data: encodeFunctionData({ abi: MORPHO_ABI, functionName: "withdrawCollateral", args: [marketParamsArg(m.params), atoms, args.user, args.user] }),
        },
      );
      return ok({
        operation: "withdraw_collateral",
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

  // ── Canonical bridge (Ethereum ↔ Robinhood Chain) ────────────────────────

  /** ETH Ethereum → Robinhood Chain via the Delayed Inbox (arrives in ~minutes). */
  async bridgeDeposit(args: { user: Address; amount: string }): Promise<RhResult> {
    if (!/^\d+(\.\d+)?$/.test(args.amount)) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal ETH amount like "0.1".`);
    let wei: bigint;
    try {
      wei = parseEther(args.amount);
    } catch {
      return fail(400, `Invalid amount "${args.amount}".`);
    }
    if (wei <= 0n) return fail(400, "Amount must be positive.");
    try {
      const balance = await readRetry(() => l1Rpc().getBalance({ address: args.user }));
      if (wei > balance) {
        return fail(400, `Insufficient ETH on Ethereum: bridging ${args.amount} ETH but the L1 wallet holds ${fmtEth(balance)} ETH. Nothing was built.`);
      }
      const gasWarning = balance - wei < parseEther("0.003") ? " ⚠️ This leaves almost no ETH for L1 gas — consider bridging slightly less." : "";
      return ok({
        operation: "bridge_deposit",
        route: "Ethereum → Robinhood Chain (canonical Arbitrum bridge)",
        amount: `${args.amount} ETH`,
        eta: "Typically a few minutes after the L1 transaction confirms.",
        steps: [
          step(
            "Bridge ETH to Robinhood Chain",
            `Deposit ${args.amount} ETH into Robinhood Chain's Delayed Inbox — the same address is credited on the L2 a few minutes later.${gasWarning}`,
            { to: L1_INBOX, data: encodeFunctionData({ abi: INBOX_ABI, functionName: "depositEth", args: [] }), value: wei, chainId: L1_CHAIN_ID },
          ),
        ],
        note: "This transaction is on ETHEREUM (chainId 1) — the wallet must be on Ethereum to sign it. depositEth credits the SENDER's own address on Robinhood Chain; smart-contract wallets with different L2 addresses should use the bridge UI instead. ERC-20 deposits also go through the UI: " + BRIDGE_UI,
        submit_with: submitWith("the ETH appears on Robinhood Chain (chainId 4663) at the same address within minutes — check with portfolio."),
      });
    } catch (e) {
      return fail(502, `Ethereum RPC read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** ETH Robinhood Chain → Ethereum via ArbSys (~7-day challenge period + L1 claim). */
  async bridgeWithdraw(args: { user: Address; amount: string; destination?: string }): Promise<RhResult> {
    if (!/^\d+(\.\d+)?$/.test(args.amount)) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal ETH amount like "0.1".`);
    let wei: bigint;
    try {
      wei = parseEther(args.amount);
    } catch {
      return fail(400, `Invalid amount "${args.amount}".`);
    }
    if (wei <= 0n) return fail(400, "Amount must be positive.");
    const destination = (args.destination ?? args.user) as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) return fail(400, `Invalid destination address "${args.destination}".`);
    try {
      const balance = await readRetry(() => rpc().getBalance({ address: args.user }));
      if (wei > balance) {
        return fail(400, `Insufficient ETH on Robinhood Chain: withdrawing ${args.amount} ETH but the wallet holds ${fmtEth(balance)} ETH. Nothing was built.`);
      }
      const gasWarning = balance - wei < parseEther("0.0005") ? " ⚠️ This leaves almost no ETH for L2 gas — consider withdrawing slightly less." : "";
      return ok({
        operation: "bridge_withdraw",
        route: "Robinhood Chain → Ethereum (canonical Arbitrum bridge)",
        amount: `${args.amount} ETH`,
        destination,
        eta: "≈7 days: the withdrawal waits out the rollup challenge period, then needs a one-time CLAIM transaction on Ethereum.",
        steps: [
          step(
            "Start withdrawal to Ethereum",
            `Send ${args.amount} ETH to the ArbSys precompile — starts the L2→L1 exit to ${destination}.${gasWarning}`,
            { to: ARB_SYS, data: encodeFunctionData({ abi: ARB_SYS_ABI, functionName: "withdrawEth", args: [destination] }), value: wei },
          ),
        ],
        note: `⚠️ NOT instant: funds are locked for the ~7-day challenge period, then must be CLAIMED on Ethereum — the claim needs a Merkle proof, so do it at the Arbitrum bridge UI (${BRIDGE_UI}, Withdrawals tab). This service builds the exit start only.`,
        submit_with: submitWith(`the exit is queued; after ~7 days claim it on Ethereum at ${BRIDGE_UI}.`),
      });
    } catch (e) {
      return fail(502, `Robinhood Chain RPC read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Static bridge overview (no build). */
  async bridgeInfo(): Promise<RhResult> {
    return ok({
      bridge: "Canonical Arbitrum (Orbit) bridge — Ethereum ↔ Robinhood Chain",
      ui: BRIDGE_UI,
      routes: {
        deposit: { what: "ETH, Ethereum → Robinhood Chain", how: "build_bridge_deposit (Delayed Inbox depositEth, chainId 1)", eta: "a few minutes" },
        withdraw: { what: "ETH, Robinhood Chain → Ethereum", how: "build_bridge_withdraw (ArbSys withdrawEth, chainId 4663)", eta: "~7-day challenge period, then a claim transaction on Ethereum (bridge UI)" },
        erc20: { what: "USDG/other ERC-20s", how: `Not built here (retryable-ticket gas is easy to get wrong) — use the bridge UI: ${BRIDGE_UI}` },
      },
      contracts: { l1DelayedInbox: L1_INBOX, l2ArbSys: ARB_SYS },
      caveats: [
        "Withdrawals are NOT instant — plan around the ~7-day challenge period.",
        "Stock tokens live natively on Robinhood Chain; they are not bridgeable assets.",
        "depositEth credits the sender's own address on the L2 — fine for EOAs, wrong for some smart-contract wallets.",
      ],
      when_not_to_use: [
        "Funding a stock buy? Don't hand-chain bridges — ask for the buy itself ('Buy $10 of AAPL') and Yeetful's funding planner builds LiFi legs from Base/Ethereum/Arbitrum USDC or ETH straight to USDG + gas on Robinhood Chain in SECONDS. This canonical bridge is the ETH-only, self-custody escape hatch (slow out), not the funding path.",
        "Cross-chain swaps between majors (Base ↔ Arbitrum ↔ Ethereum ↔ Solana, …) belong to NEAR Intents, which since 2026-09-21 also moves USDG into Robinhood Chain and USDG/ETH out of it (fast exits — no 7-day wait). It lists no stock tokens and has quoted no liquidity INTO gas ETH, so gas still arrives via LiFi funding legs or this canonical bridge.",
      ],
    });
  },
};
