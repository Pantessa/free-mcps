// Status shaping + the poll-inside-the-tool-call waiter. Every status
// response explains what the state MEANS and what to do next, so the chat
// can narrate the swap's progress instead of echoing an enum at the user.

import {
  STATUS_EXPLANATIONS,
  getExecutionStatus,
  submitDepositTx,
  type OneClickOpts,
  type OneClickResult,
} from "./oneclick";

const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

// The live API often returns tx hashes with an EMPTY explorerUrl (observed
// 2026-07-09), so build the link ourselves for chains we know — the chat
// needs a clickable delivery link, not a bare hash.
const EXPLORER_TX: Record<string, string> = {
  eth: "https://etherscan.io/tx/",
  base: "https://basescan.org/tx/",
  arb: "https://arbiscan.io/tx/",
  op: "https://optimistic.etherscan.io/tx/",
  pol: "https://polygonscan.com/tx/",
  bsc: "https://bscscan.com/tx/",
  avax: "https://snowtrace.io/tx/",
  gnosis: "https://gnosisscan.io/tx/",
  scroll: "https://scrollscan.com/tx/",
  hood: "https://robinhoodchain.blockscout.com/tx/",
  sol: "https://solscan.io/tx/",
  btc: "https://mempool.space/tx/",
  near: "https://nearblocks.io/txns/",
};

/** Best-effort chain prefix from a 1Click assetId ("nep141:arb-0x….omft.near" → "arb"). */
function chainOfAssetId(assetId?: string): string | null {
  if (!assetId) return null;
  const m = /^nep\d+:([a-z]+)[-.]/.exec(assetId);
  return m && EXPLORER_TX[m[1]] ? m[1] : null;
}

interface RawTxDetails {
  hash?: string;
  explorerUrl?: string;
}
interface RawStatus {
  status?: string;
  updatedAt?: string;
  correlationId?: string;
  quoteResponse?: { quoteRequest?: { originAsset?: string; destinationAsset?: string } };
  swapDetails?: {
    amountInFormatted?: string;
    amountInUsd?: string;
    amountOutFormatted?: string;
    amountOutUsd?: string;
    slippage?: number;
    originChainTxHashes?: RawTxDetails[];
    destinationChainTxHashes?: RawTxDetails[];
    refundedAmountFormatted?: string;
    refundReason?: string;
    depositedAmountFormatted?: string;
  };
}

function nextStepFor(status: string, depositAddress: string): string {
  switch (status) {
    case "PENDING_DEPOSIT":
      return "If the deposit transfer hasn't been signed yet, that's the next step. If it was just sent, wait for the transaction to confirm, then optionally call submit_deposit_tx with its hash to speed up detection.";
    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
      return `In flight — call await_completion with depositAddress ${depositAddress} to watch it finish (usually well under the quoted ETA).`;
    case "INCOMPLETE_DEPOSIT":
      return "Top up the SAME deposit address with the missing amount before the deadline, or wait for the automatic refund.";
    case "SUCCESS":
      return "Done — show the user the destination transaction (swap.destinationTransactions has the explorer link), then RE-READ their balances with a wallet/portfolio tool (never reuse pre-swap numbers): the origin chain went down and the destination chain went up the moment this settled.";
    case "REFUNDED":
      return "The origin funds are back in the refund wallet. To retry, request a fresh build_swap (never reuse the old deposit address).";
    case "FAILED":
      return "Report the correlationId and saved quote signature to NEAR Intents support. Check swap.refunded for whether funds already came back.";
    default:
      return "Unknown status — poll again with check_status.";
  }
}

export function shapeStatus(depositAddress: string, r: OneClickResult) {
  if (!r.ok) {
    if (r.status === 404) {
      throw new Error(
        `1Click doesn't recognize deposit address ${depositAddress}. Either it was mistyped, or the quote was a DRY preview (previews never create deposit addresses — only build_swap does).`,
      );
    }
    throw new Error(typeof r.data === "string" ? r.data : `Status lookup failed (HTTP ${r.status}).`);
  }
  const raw = r.data as RawStatus;
  const status = raw.status ?? "UNKNOWN";
  const d = raw.swapDetails;
  const txs = (list: RawTxDetails[] | undefined, chain: string | null) =>
    (list ?? []).map((t) => ({
      hash: t.hash ?? null,
      explorer: t.explorerUrl || (chain && t.hash ? `${EXPLORER_TX[chain]}${t.hash}` : null),
    }));
  const originChain = chainOfAssetId(raw.quoteResponse?.quoteRequest?.originAsset);
  const destinationChain = chainOfAssetId(raw.quoteResponse?.quoteRequest?.destinationAsset);

  return {
    kind: "swap_status",
    depositAddress,
    status,
    terminal: TERMINAL.has(status),
    explanation: STATUS_EXPLANATIONS[status] ?? "Unrecognized status value from the 1Click API.",
    updatedAt: raw.updatedAt ?? null,
    swap: {
      deposited: d?.depositedAmountFormatted ?? null,
      swappedIn: d?.amountInFormatted ?? null,
      delivered: d?.amountOutFormatted ?? null,
      deliveredUsd: d?.amountOutUsd ?? null,
      actualSlippageBps: d?.slippage ?? null,
      originTransactions: txs(d?.originChainTxHashes, originChain),
      destinationTransactions: txs(d?.destinationChainTxHashes, destinationChain),
      ...(d?.refundedAmountFormatted ? { refunded: d.refundedAmountFormatted, refundReason: d.refundReason ?? null } : {}),
    },
    next_step: nextStepFor(status, depositAddress),
  };
}

export async function checkStatus(depositAddress: string, opts?: OneClickOpts) {
  return shapeStatus(depositAddress, await getExecutionStatus(depositAddress, opts));
}

/**
 * Poll until the swap reaches a terminal state or the timeout hits —
 * bounded ≤45s so it's safe inside one serverless tool call. Not reaching a
 * terminal state is NOT a failure; the caller just polls again.
 */
export async function awaitCompletion(
  args: { depositAddress: string; timeoutSec?: number; pollMs?: number },
  opts?: OneClickOpts,
) {
  const timeoutSec = Math.min(Math.max(args.timeoutSec ?? 40, 5), 45);
  const pollMs = args.pollMs ?? 4_000;
  const startedAt = Date.now();
  let last = await checkStatus(args.depositAddress, opts);
  while (!last.terminal && Date.now() - startedAt < timeoutSec * 1_000) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    last = await checkStatus(args.depositAddress, opts);
  }
  return {
    ...last,
    waitedSec: Math.round((Date.now() - startedAt) / 1000),
    ...(last.terminal
      ? {}
      : {
          note: `Still ${last.status} after ${timeoutSec}s of watching — that's normal for cross-chain settlement. Call await_completion again to keep watching; nothing is wrong.`,
        }),
  };
}

export async function notifyDeposit(args: { depositAddress: string; txHash: string }, opts?: OneClickOpts) {
  const r = await submitDepositTx(args, opts);
  if (!r.ok) {
    throw new Error(typeof r.data === "string" ? r.data : `Deposit notification failed (HTTP ${r.status}).`);
  }
  const raw = r.data as RawStatus;
  const status = raw.status ?? "UNKNOWN";
  return {
    kind: "deposit_submitted",
    depositAddress: args.depositAddress,
    txHash: args.txHash,
    status,
    explanation: STATUS_EXPLANATIONS[status] ?? null,
    next_step: `1Click now knows the deposit transaction — call await_completion with depositAddress ${args.depositAddress} to watch the swap finish and get the destination-chain transaction link.`,
  };
}
