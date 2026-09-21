// Deterministic deposit-transfer building. A non-dry 1Click quote pins a
// ONE-TIME deposit address on the origin chain; the ONLY transaction the user
// ever signs is a plain transfer of the quoted amount to that address
// (ERC-20 `transfer(depositAddress, amountIn)` or a native-value send). This
// module turns that into the `{action:'send_transaction'}` payload Yeetful's
// transaction layer renders as a sign button — this service never holds
// keys, never signs, never submits. Everything after the transfer is
// automatic: NEAR Intents solvers fill the swap and deliver on the
// destination chain; `check_status` / `await_completion` watch it land.

import { createPublicClient, encodeFunctionData, erc20Abi, http, type Chain } from "viem";
import {
  APP_FEE_NOTE,
  CONFIDENTIAL_NOTE,
  EVM_CHAINS,
  chainLabel,
  dryPlaceholderFor,
  formatAtoms,
  humanToAtoms,
  normalizeChain,
  requestQuote,
  resolveAsset,
  validateAppFee,
  validateConfidentiality,
  type Confidentiality,
  type OneClickOpts,
  type OneClickResult,
  type OneClickToken,
} from "./oneclick";

export const MAX_SLIPPAGE_BPS = 1_000; // 10% — cross-chain routes can be thin
export const DEFAULT_SLIPPAGE_BPS = 100; // 1%, the 1Click-documented default
export const DEFAULT_DEADLINE_MIN = 30;

/** Build-time options — tests inject both seams to stay fully offline. */
export interface BuildOpts extends OneClickOpts {
  /** Balance reader override; production default reads the chain's public RPC. */
  readBalance?: (args: { chain: Chain; tokenAddress?: string; owner: `0x${string}` }) => Promise<bigint>;
}

async function defaultReadBalance(args: { chain: Chain; tokenAddress?: string; owner: `0x${string}` }): Promise<bigint> {
  const client = createPublicClient({ chain: args.chain, transport: http() });
  return args.tokenAddress
    ? client.readContract({ address: args.tokenAddress as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [args.owner] })
    : client.getBalance({ address: args.owner });
}

/** A transaction for the USER to sign — the transaction-layer contract. */
export interface SendTransactionAction {
  action: "send_transaction";
  label: string;
  summary: string;
  tx: { to: string; data: string; value: string; chainId: number };
}

const isEvmAddress = (s: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(s);

interface RawQuote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
}

interface RawQuoteResponse {
  correlationId?: string;
  timestamp?: string;
  signature?: string;
  quote?: RawQuote;
  /** 1Click echoes the request back, INCLUDING the app-fee split it applied
   *  (the requested bps halved between recipient and protocol). Callers that
   *  charge a fee verify their own recipient against this echo. */
  quoteRequest?: { appFees?: Array<{ recipient?: string; fee?: number }>; confidentiality?: string };
}

/** A confidential ask is only honored when 1Click ECHOES the level back. A
 *  venue that dropped the field would hand back an ordinary public swap the
 *  user believes is private — refuse instead. */
function confidentialView(asked: Confidentiality | null, resp: RawQuoteResponse, samePayerAndRecipient: boolean) {
  if (!asked) return {};
  const echoed = resp.quoteRequest?.confidentiality;
  if (echoed !== asked) {
    throw new Error(
      `Asked for a ${asked} confidential swap but the venue answered with "${echoed ?? "public"}" execution. Not built — a private ask never falls back to a public swap.`,
    );
  }
  return {
    confidential: {
      level: asked,
      deliversToPayer: samePayerAndRecipient,
      note: CONFIDENTIAL_NOTE,
    },
  };
}

/** Human summary of a quote both dry and real paths share. */
export function presentQuote(args: {
  q: RawQuote;
  origin: OneClickToken;
  destination: OneClickToken;
  slippageBps: number;
}) {
  const { q, origin, destination, slippageBps } = args;
  const rate =
    Number(q.amountInFormatted) > 0 ? (Number(q.amountOutFormatted) / Number(q.amountInFormatted)).toPrecision(6) : null;
  return {
    sell: {
      token: origin.symbol,
      chain: chainLabel(origin.blockchain),
      amount: q.amountInFormatted,
      amountAtoms: q.amountIn,
      usd: q.amountInUsd,
    },
    receive: {
      token: destination.symbol,
      chain: chainLabel(destination.blockchain),
      estimated: q.amountOutFormatted,
      estimatedAtoms: q.amountOut,
      minimum: formatAtoms(q.minAmountOut, destination.decimals),
      minimumAtoms: q.minAmountOut,
      usd: q.amountOutUsd,
    },
    rate: rate ? `1 ${origin.symbol} (${chainLabel(origin.blockchain)}) ≈ ${rate} ${destination.symbol} (${chainLabel(destination.blockchain)})` : null,
    slippageBps,
    ...(q.withdrawFee && q.withdrawFee !== "0"
      ? { destinationDeliveryFee: `${formatAtoms(q.withdrawFee, destination.decimals)} ${destination.symbol} (already included in the estimate)` }
      : {}),
    etaSeconds: q.timeEstimate,
    summary: `Swap ${q.amountInFormatted} ${origin.symbol} on ${chainLabel(origin.blockchain)} → ~${q.amountOutFormatted} ${destination.symbol} on ${chainLabel(destination.blockchain)} (min ${formatAtoms(q.minAmountOut, destination.decimals)} after ${slippageBps / 100}% slippage, ETA ~${q.timeEstimate}s after deposit confirms)`,
  };
}

function unpackQuote(r: OneClickResult): { resp: RawQuoteResponse; q: RawQuote } {
  if (!r.ok) throw new Error(typeof r.data === "string" ? r.data : `Quote failed (HTTP ${r.status}).`);
  const resp = r.data as RawQuoteResponse;
  if (!resp?.quote?.amountOut) throw new Error("1Click returned no quote — the pair may have no active solver liquidity right now.");
  return { resp, q: resp.quote };
}

// ── Dry quote (preview — nothing committed) ─────────────────────────────────

export interface DryQuoteParams {
  originChain: string;
  originToken: string;
  destinationChain: string;
  destinationToken: string;
  amount: string;
  slippageBps?: number;
  refundTo?: string;
  recipient?: string;
  feeRecipient?: string;
  feeBps?: number;
  confidentiality?: string;
}

export async function dryQuote(p: DryQuoteParams, opts?: OneClickOpts) {
  const slippageBps = validateSlippage(p.slippageBps);
  // Priced with the same fee the build will charge — a preview that omits it
  // would quote a number the user can never actually receive.
  const appFees = validateAppFee(p.feeRecipient, p.feeBps);
  const confidentiality = validateConfidentiality(p.confidentiality);
  const [origin, destination] = await Promise.all([
    resolveAsset(p.originChain, p.originToken, opts),
    resolveAsset(p.destinationChain, p.destinationToken, opts),
  ]);
  if (origin.assetId === destination.assetId) throw new Error("Origin and destination assets must differ.");

  const refundTo = p.refundTo ?? dryPlaceholderFor(origin.blockchain);
  const recipient = p.recipient ?? dryPlaceholderFor(destination.blockchain);
  if (!refundTo) {
    throw new Error(
      `Previewing a swap FROM ${chainLabel(origin.blockchain)} needs a refund address on that chain — pass refundTo (the user's own ${chainLabel(origin.blockchain)} address).`,
    );
  }
  if (!recipient) {
    throw new Error(
      `Previewing a swap TO ${chainLabel(destination.blockchain)} needs a recipient address on that chain — pass recipient (where the user wants funds delivered).`,
    );
  }

  const amountAtoms = humanToAtoms(p.amount, origin.decimals);
  const r = await requestQuote(
    { dry: true, originAsset: origin, destinationAsset: destination, amountAtoms, slippageBps, refundTo, recipient, deadlineMin: DEFAULT_DEADLINE_MIN, appFees, confidentiality },
    opts,
  );
  const { resp, q } = unpackQuote(r);

  return {
    kind: "preview_quote",
    quote: presentQuote({ q, origin, destination, slippageBps }),
    ...(appFees ? { appFee: { requested: appFees, applied: resp.quoteRequest?.appFees ?? null, note: APP_FEE_NOTE } } : {}),
    ...confidentialView(confidentiality, resp, !p.recipient || p.recipient.toLowerCase() === (p.refundTo ?? "").toLowerCase()),
    explain:
      "This is a DRY-RUN preview from the NEAR Intents solver network — nothing is committed and no deposit address exists yet. Cross-chain swaps here don't use a bridge UI: a real quote pins a one-time deposit address on the origin chain, the user sends ONE transfer to it, and solvers deliver the destination asset to the recipient automatically.",
    next_step: `To execute, call build_swap with the same pair plus from = the user's ${chainLabel(origin.blockchain)} wallet address ("$USER_ADDRESS" for the connected user)${EVM_CHAINS[destination.blockchain] ? " — proceeds go to the same address on the destination chain unless a different recipient is passed" : ` and recipient = the user's ${chainLabel(destination.blockchain)} address`}.`,
  };
}

// ── Real swap build (deposit address + unsigned transfer step) ──────────────

export interface BuildSwapParams {
  originChain: string;
  originToken: string;
  destinationChain: string;
  destinationToken: string;
  amount: string;
  from: string;
  recipient?: string;
  slippageBps?: number;
  deadlineMinutes?: number;
  /** Integrator fee recipient — passed together with feeBps or not at all. */
  feeRecipient?: string;
  feeBps?: number;
  /** "basic" | "advanced" — NEAR Confidential Intents. Absent/"public" = the default lane. */
  confidentiality?: string;
}

export async function buildSwap(p: BuildSwapParams, opts?: BuildOpts) {
  const slippageBps = validateSlippage(p.slippageBps);
  const deadlineMin = p.deadlineMinutes ?? DEFAULT_DEADLINE_MIN;
  if (!Number.isInteger(deadlineMin) || deadlineMin < 10 || deadlineMin > 24 * 60) {
    throw new Error("deadlineMinutes must be an integer between 10 and 1440 — the deposit must be mined before it.");
  }

  const originBlockchain = normalizeChain(p.originChain);
  const evm = EVM_CHAINS[originBlockchain];
  if (!evm) {
    throw new Error(
      `This service can only BUILD deposit transactions on EVM chains (${Object.values(EVM_CHAINS).map((c) => c.label).join(", ")}). ` +
        `${chainLabel(originBlockchain)} swaps are still quotable with \`quote\`, but the deposit must be sent from the user's own ${chainLabel(originBlockchain)} wallet.`,
    );
  }
  if (!isEvmAddress(p.from)) {
    throw new Error(
      'A valid `from` is required — the USER\'S OWN wallet address on the origin chain (pass "$USER_ADDRESS" for the connected user). It pays the deposit and receives any refund.',
    );
  }

  const [origin, destination] = await Promise.all([
    resolveAsset(p.originChain, p.originToken, opts),
    resolveAsset(p.destinationChain, p.destinationToken, opts),
  ]);
  if (origin.assetId === destination.assetId) throw new Error("Origin and destination assets must differ.");

  const destinationIsEvm = Boolean(EVM_CHAINS[destination.blockchain]);
  const recipient = p.recipient ?? (destinationIsEvm ? p.from : undefined);
  if (!recipient) {
    throw new Error(
      `Delivering to ${chainLabel(destination.blockchain)} needs an explicit recipient address in that chain's format — never guess one; ask the user where funds should arrive.`,
    );
  }
  if (destinationIsEvm && !isEvmAddress(recipient)) {
    throw new Error(`recipient must be a valid 0x address on ${chainLabel(destination.blockchain)}.`);
  }

  // Throws on a malformed fee rather than quoting without one — see
  // validateAppFee: 1Click charges a garbage recipient just the same.
  const appFees = validateAppFee(p.feeRecipient, p.feeBps);
  const confidentiality = validateConfidentiality(p.confidentiality);

  const amountAtoms = humanToAtoms(p.amount, origin.decimals);
  const r = await requestQuote(
    { dry: false, originAsset: origin, destinationAsset: destination, amountAtoms, slippageBps, refundTo: p.from, recipient, deadlineMin, appFees, confidentiality },
    opts,
  );
  const { resp, q } = unpackQuote(r);
  // Before anything signable exists: a private ask the venue didn't honor refuses.
  const confidential = confidentialView(confidentiality, resp, recipient.toLowerCase() === p.from.toLowerCase());
  if (!q.depositAddress) throw new Error("1Click returned no deposit address — cannot build the transfer.");
  if (q.depositMemo) {
    // EVM origins are SIMPLE deposit mode; a memo would mean we'd build a
    // transfer that silently drops it. Refuse loudly instead.
    throw new Error("This route requires a deposit memo, which EVM transfers can't carry. Not built — try a different origin chain.");
  }

  // The transfer: ERC-20 transfer(depositAddress, amountIn) — or a native
  // value send when the origin asset has no contract (native ETH/AVAX/…).
  const isNative = !origin.contractAddress;
  const depositTx = {
    to: (isNative ? q.depositAddress : origin.contractAddress) as string,
    data: isNative
      ? "0x"
      : encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [q.depositAddress as `0x${string}`, amountAtoms] }),
    value: isNative ? amountAtoms.toString() : "0",
    chainId: evm.chain.id,
  };

  const quoteView = presentQuote({ q, origin, destination, slippageBps });
  const step: SendTransactionAction = {
    action: "send_transaction",
    label: "deposit",
    summary: `Send ${q.amountInFormatted} ${origin.symbol} on ${evm.label} to NEAR Intents deposit address ${q.depositAddress} — solvers then deliver ~${q.amountOutFormatted} ${destination.symbol} to ${recipient} on ${chainLabel(destination.blockchain)} (ETA ~${q.timeEstimate}s, address expires ${q.deadline ?? "at the quote deadline"})`,
    tx: depositTx,
  };

  // Advisory balance check via the chain's public RPC — information, not a
  // refusal (an RPC hiccup must never block a build).
  let balanceCheck: { ok: boolean | null; note: string };
  try {
    const readBalance = opts?.readBalance ?? defaultReadBalance;
    const balance = await readBalance({
      chain: evm.chain,
      tokenAddress: isNative ? undefined : origin.contractAddress,
      owner: p.from as `0x${string}`,
    });
    balanceCheck =
      balance >= amountAtoms
        ? { ok: true, note: `Wallet holds ${formatAtoms(balance, origin.decimals)} ${origin.symbol} on ${evm.label} — enough for this deposit.` }
        : {
            ok: false,
            note: `Wallet holds only ${formatAtoms(balance, origin.decimals)} ${origin.symbol} on ${evm.label} but the deposit needs ${q.amountInFormatted}. Signing now would fail — fund the wallet first or lower the amount.`,
          };
  } catch {
    balanceCheck = { ok: null, note: "Balance check skipped (RPC unavailable) — not a problem with the swap itself." };
  }

  return {
    kind: "swap_ready",
    quote: quoteView,
    deposit: {
      address: q.depositAddress,
      chain: evm.label,
      exactAmount: `${q.amountInFormatted} ${origin.symbol} (${q.amountIn} base units)`,
      addressExpires: q.deadline ?? null,
      refundsGoTo: p.from,
      deliveredTo: `${recipient} on ${chainLabel(destination.blockchain)}`,
    },
    balanceCheck,
    // Verbatim echo of the split 1Click applied — the caller that asked for
    // the fee checks its OWN recipient against this before offering the
    // transaction, and it's what makes the fee disclosable to the user.
    ...(appFees ? { appFee: { requested: appFees, applied: resp.quoteRequest?.appFees ?? null, note: APP_FEE_NOTE } } : {}),
    ...confidential,
    steps: [step],
    flow: [
      `1. NOW — the user signs the single "deposit" transaction below: a plain ${isNative ? "native" : origin.symbol} transfer of exactly ${q.amountInFormatted} ${origin.symbol} on ${evm.label} to 1Click's one-time deposit address. This is the ONLY signature the whole cross-chain swap needs.`,
      `2. AFTER IT CONFIRMS — call submit_deposit_tx with the transaction hash and depositAddress ${q.depositAddress} (optional but recommended: it lets 1Click pick the deposit up faster).`,
      `3. AUTOMATIC — NEAR Intents solvers detect the deposit, execute the swap, and deliver ~${q.amountOutFormatted} ${destination.symbol} (minimum ${quoteView.receive.minimum} after slippage) straight to ${recipient} on ${chainLabel(destination.blockchain)}. No second signature, no claiming, no bridge UI.`,
      `4. VERIFY — call await_completion (or check_status) with depositAddress ${q.depositAddress} until status is SUCCESS, then show the user the destination-chain transaction link from swapDetails — and re-read their balances with a wallet/portfolio tool so the reply shows the FRESH holdings on both chains, not pre-swap numbers.`,
    ],
    warnings: [
      `Send EXACTLY the quoted amount in ONE transfer. Less → refunded after the deadline; more → the excess is refunded to ${p.from} after the swap.`,
      `The deposit address is single-use and expires ${q.deadline ?? "at the deadline"} — never reuse it for another swap, and don't sign after expiry (request a fresh build_swap instead).`,
      "If the swap can't be filled, the deposit is automatically refunded to the refund address on the origin chain — funds are never stranded mid-bridge.",
    ],
    receipt: {
      note: "Keep these — they prove the quote if anything needs investigating with NEAR Intents support.",
      correlationId: resp.correlationId ?? null,
      quoteSignature: resp.signature ?? null,
    },
  };
}

function validateSlippage(slippageBps?: number): number {
  const v = slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(v) || v < 5 || v > MAX_SLIPPAGE_BPS) {
    throw new Error(`slippageBps must be an integer between 5 and ${MAX_SLIPPAGE_BPS} (default ${DEFAULT_SLIPPAGE_BPS} = 1%).`);
  }
  return v;
}
