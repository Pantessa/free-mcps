// NEAR Intents 1Click API client (https://1click.chaindefuser.com — the
// official cross-chain swap API). The flow this service wraps:
//
//   1. quote     — price a swap between any two supported assets (dry = true
//                  previews with NO commitment and NO deposit address)
//   2. deposit   — a non-dry quote returns a ONE-TIME deposit address on the
//                  origin chain; transferring the quoted amount there is the
//                  only on-chain action the user ever signs
//   3. execution — NEAR Intents solvers race to fill the swap and deliver
//                  the destination asset to the recipient on the destination
//                  chain (no bridge UI, no wrapped receipt tokens)
//   4. status    — poll by deposit address until SUCCESS / REFUNDED / FAILED
//
// This service never holds keys, never signs, never submits. It PREPARES the
// deposit transfer as an unsigned {to,data,value,chainId} step (the same
// transaction-layer contract the uniswap/aave siblings use) and explains each
// stage of the flow in every response.
//
// Auth: a JWT in NEAR_INTENT_API_KEY (Authorization: Bearer). The API works
// without it, but 1Click then charges an extra 0.2% on swaps — so set it.
// Schemas below match the live OpenAPI spec (validated 2026-07-09).

const API_URL = () => process.env.ONECLICK_API_URL ?? "https://1click.chaindefuser.com";
const API_KEY = () => process.env.NEAR_INTENT_API_KEY ?? "";

// Cap payloads returned through MCP so a huge response can't blow up the
// agent's context. Clipping happens at the TOOL layer, after shaping.
export const MAX_RESPONSE_CHARS = 24_000;

// Injectable seam for tests — production passes nothing (global fetch).
export interface OneClickOpts {
  fetchImpl?: typeof fetch;
}

export interface OneClickResult {
  ok: boolean;
  status: number;
  data: unknown;
}

/** Clip an already-shaped payload to the MCP size budget. */
export function clip(data: unknown): unknown {
  if (typeof data === "string") return data;
  const serialized = JSON.stringify(data);
  if (serialized.length <= MAX_RESPONSE_CHARS) return data;
  return {
    note: `Response truncated to ~${MAX_RESPONSE_CHARS} chars — narrow your filters. \`preview\` is a raw (clipped) JSON string.`,
    preview: serialized.slice(0, MAX_RESPONSE_CHARS),
  };
}

/** One HTTP call against the 1Click API. API errors surface as ok:false. */
export async function apiRequest(
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string | undefined> },
  opts?: OneClickOpts,
): Promise<OneClickResult> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const url = new URL(path, API_URL());
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  const key = API_KEY();
  const res = await doFetch(url.toString(), {
    method: init?.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: "no-store",
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg =
      typeof parsed === "object" && parsed !== null && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : typeof parsed === "string" && parsed.length > 0
          ? parsed.slice(0, 400)
          : `1Click API error (HTTP ${res.status})`;
    return { ok: false, status: res.status, data: msg };
  }
  return { ok: true, status: res.status, data: parsed };
}

// ── Chains ───────────────────────────────────────────────────────────────────
// The 1Click `blockchain` enum, split into EVM chains this service can BUILD
// deposit transactions for (chainIds come from viem — never guessed) and
// everything else (fully quotable; the deposit transfer just can't be
// prepared as an EVM transaction, so the user deposits from their own
// wallet on that chain).

import {
  arbitrum,
  avalanche,
  base,
  bsc,
  gnosis,
  mainnet,
  optimism,
  polygon,
  scroll,
} from "viem/chains";
import { defineChain, type Chain } from "viem";

// Robinhood Chain (4663, Arbitrum Orbit L2). viem ships no definition, so
// this mirrors services/robinhood/lib/chain.ts: the id and public RPC are the
// chain's own published values. 1Click's `blockchain` enum calls it "hood"
// (live on the API since 2026-09-21).
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"] } },
});

export const EVM_CHAINS: Record<string, { chain: Chain; label: string }> = {
  eth: { chain: mainnet, label: "Ethereum" },
  base: { chain: base, label: "Base" },
  arb: { chain: arbitrum, label: "Arbitrum" },
  op: { chain: optimism, label: "Optimism" },
  pol: { chain: polygon, label: "Polygon" },
  bsc: { chain: bsc, label: "BNB Chain" },
  avax: { chain: avalanche, label: "Avalanche" },
  gnosis: { chain: gnosis, label: "Gnosis" },
  scroll: { chain: scroll, label: "Scroll" },
  hood: { chain: robinhoodChain, label: "Robinhood Chain" },
};

export const OTHER_CHAIN_LABELS: Record<string, string> = {
  near: "NEAR",
  btc: "Bitcoin",
  sol: "Solana",
  ton: "TON",
  doge: "Dogecoin",
  xrp: "XRP Ledger",
  zec: "Zcash",
  bera: "Berachain",
  tron: "Tron",
  sui: "Sui",
  movement: "Movement",
  stellar: "Stellar",
  aptos: "Aptos",
  cardano: "Cardano",
  ltc: "Litecoin",
  xlayer: "X Layer",
  monad: "Monad",
  bch: "Bitcoin Cash",
  dash: "Dash",
  adi: "ADI",
  plasma: "Plasma",
  starknet: "Starknet",
  aleo: "Aleo",
  hypercore: "Hypercore",
  fogo: "Fogo",
};

const CHAIN_ALIASES: Record<string, string> = {
  ethereum: "eth",
  mainnet: "eth",
  arbitrum: "arb",
  "arbitrum one": "arb",
  optimism: "op",
  polygon: "pol",
  matic: "pol",
  bnb: "bsc",
  "bnb chain": "bsc",
  binance: "bsc",
  avalanche: "avax",
  solana: "sol",
  bitcoin: "btc",
  dogecoin: "doge",
  litecoin: "ltc",
  berachain: "bera",
  "x layer": "xlayer",
  robinhood: "hood",
  "robinhood chain": "hood",
  robinhoodchain: "hood",
};

/** Normalize a user-supplied chain name to the 1Click `blockchain` enum. */
export function normalizeChain(input: string): string {
  const raw = input.trim().toLowerCase();
  const byId = Object.entries(EVM_CHAINS).find(([, v]) => String(v.chain.id) === raw);
  if (byId) return byId[0];
  const key = CHAIN_ALIASES[raw] ?? raw;
  if (EVM_CHAINS[key] || OTHER_CHAIN_LABELS[key]) return key;
  const known = [...Object.keys(EVM_CHAINS), ...Object.keys(OTHER_CHAIN_LABELS)].join(", ");
  throw new Error(`Unknown chain "${input}". Supported chains: ${known}. Use the \`chains\` tool to see them with token counts.`);
}

export const chainLabel = (blockchain: string): string =>
  EVM_CHAINS[blockchain]?.label ?? OTHER_CHAIN_LABELS[blockchain] ?? blockchain;

// ── Supported tokens (cached) ────────────────────────────────────────────────

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
}

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
let tokenCache: { at: number; tokens: OneClickToken[] } | null = null;

/** Test seam — unit tests reset the module-level cache between cases. */
export function clearTokenCache(): void {
  tokenCache = null;
}

/** All 1Click-supported tokens, cached ~5 min (the list is large + stable). */
export async function getTokens(opts?: OneClickOpts): Promise<OneClickToken[]> {
  if (tokenCache && Date.now() - tokenCache.at < TOKEN_CACHE_TTL_MS) return tokenCache.tokens;
  const r = await apiRequest("/v0/tokens", undefined, opts);
  if (!r.ok || !Array.isArray(r.data)) {
    throw new Error(`Could not load the 1Click supported-token list (HTTP ${r.status}): ${typeof r.data === "string" ? r.data : "unexpected response"}`);
  }
  tokenCache = { at: Date.now(), tokens: r.data as OneClickToken[] };
  return tokenCache.tokens;
}

/**
 * Resolve a user-supplied token (symbol, 0x/contract address, or full
 * assetId like "nep141:…") on a chain to its 1Click token entry.
 */
export async function resolveAsset(chainInput: string, tokenInput: string, opts?: OneClickOpts): Promise<OneClickToken> {
  const blockchain = normalizeChain(chainInput);
  const tokens = await getTokens(opts);
  const onChain = tokens.filter((t) => t.blockchain === blockchain);
  if (onChain.length === 0) {
    throw new Error(`1Click currently lists no swappable tokens on ${chainLabel(blockchain)}.`);
  }
  const needle = tokenInput.trim();
  const lower = needle.toLowerCase();

  const found =
    onChain.find((t) => t.assetId.toLowerCase() === lower) ??
    onChain.find((t) => (t.contractAddress ?? "").toLowerCase() === lower) ??
    (() => {
      const bySymbol = onChain.filter((t) => t.symbol.toLowerCase() === lower);
      if (bySymbol.length > 1) {
        const list = bySymbol.map((t) => `${t.symbol} (${t.assetId})`).join(" · ");
        throw new Error(
          `"${needle}" matches ${bySymbol.length} tokens on ${chainLabel(blockchain)}: ${list}. Pass the exact assetId or contract address.`,
        );
      }
      return bySymbol[0];
    })();

  if (!found) {
    const sample = [...new Set(onChain.map((t) => t.symbol))].slice(0, 25).join(", ");
    throw new Error(
      `Token "${needle}" isn't supported on ${chainLabel(blockchain)}. Tokens there include: ${sample}. Use the \`tokens\` tool to search the full list.`,
    );
  }
  return found;
}

// ── Amount helpers (human units ↔ base units) ───────────────────────────────

export function humanToAtoms(amount: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`Invalid amount "${amount}" — pass a plain decimal number in HUMAN units, e.g. "1.5".`);
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  const atoms = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac === "" ? "0" : frac);
  if (atoms <= 0n) throw new Error(`Amount must be greater than zero (got "${amount}").`);
  return atoms;
}

export function formatAtoms(atoms: bigint | string, decimals: number): string {
  const v = typeof atoms === "bigint" ? atoms : BigInt(atoms);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

// ── Quotes ───────────────────────────────────────────────────────────────────

/** An integrator fee 1Click takes out of the INPUT before the swap (see
 *  APP_FEE_NOTE). Never invented here — always passed in by the caller. */
export interface AppFee {
  /** Any NEAR-supported address: named account, implicit account, or 0x…. */
  recipient: string;
  /** Basis points, 0–500. 1Click splits this 50/50 with the protocol. */
  fee: number;
}

/** The one paragraph every caller needs about app fees, so a fee is never a
 *  surprise in a quote: it comes out of the OUTPUT (the deposit the user
 *  signs is unchanged), and half of it goes to the 1Click protocol. */
export const APP_FEE_NOTE =
  "An app fee is charged from the input token BEFORE the swap: the deposit amount the user signs is unchanged, the delivered amount is lower by the fee. 1Click splits every app fee 50/50 — half to the requested recipient, half to the protocol — and echoes the resulting split back in quoteRequest.appFees.";

export const MAX_APP_FEE_BPS = 500;

/** Validate a caller-supplied fee. Returns null when none was asked for;
 *  THROWS on a malformed one — 1Click accepts a garbage recipient and still
 *  charges the fee (verified live 2026-07-28), so a typo would silently take
 *  money out of the user's swap and send it nowhere. Fail closed. */
export function validateAppFee(recipient?: string, bps?: number): AppFee[] | null {
  if (recipient === undefined && bps === undefined) return null;
  if (recipient === undefined || bps === undefined) {
    throw new Error("feeRecipient and feeBps must be passed together (or neither).");
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_APP_FEE_BPS) {
    throw new Error(`feeBps must be an integer between 0 and ${MAX_APP_FEE_BPS} (basis points; 100 = 1%).`);
  }
  if (bps === 0) return null;
  const named = /^[a-z0-9._-]+\.(near|testnet)$/i;
  const implicit = /^[0-9a-f]{64}$/i;
  const evm = /^0x[0-9a-fA-F]{40}$/;
  if (!evm.test(recipient) && !named.test(recipient) && !implicit.test(recipient)) {
    throw new Error(
      "feeRecipient must be a 0x EVM address, a named NEAR account (alice.near), or a 64-hex implicit account — 1Click does NOT validate this, so a typo would burn the fee.",
    );
  }
  return [{ recipient, fee: bps }];
}

export interface QuoteParams {
  dry: boolean;
  originAsset: OneClickToken;
  destinationAsset: OneClickToken;
  /** Base units of the origin asset (EXACT_INPUT). */
  amountAtoms: bigint;
  slippageBps: number;
  refundTo: string;
  recipient: string;
  deadlineMin: number;
  /** Optional integrator fee, already validated. */
  appFees?: AppFee[] | null;
  /** Confidential Intents level, already validated. Absent = public. */
  confidentiality?: Confidentiality | null;
}

/** NEAR Confidential Intents: the swap executes on NEAR's private shard, so
 *  the route between the deposit and the payout is off the public record. The
 *  deposit transfer and the destination payout themselves stay public. */
export const CONFIDENTIALITY_LEVELS = ["basic", "advanced"] as const;
export type Confidentiality = (typeof CONFIDENTIALITY_LEVELS)[number];

/** "public" and absent both mean the default lane (null). Anything else must
 *  be a level 1Click names — a typo must never quietly build a public swap. */
export function validateConfidentiality(v?: string | null): Confidentiality | null {
  if (v == null || v === "" || v === "public") return null;
  if ((CONFIDENTIALITY_LEVELS as readonly string[]).includes(v)) return v as Confidentiality;
  throw new Error(`confidentiality must be one of: public, ${CONFIDENTIALITY_LEVELS.join(", ")}.`);
}

export const CONFIDENTIAL_NOTE =
  "Confidential execution hides the route between the deposit and the payout. The deposit transfer on the origin chain and the payout on the destination chain are still public, so delivering to the same address that paid is easy to match by amount and timing — pass a different recipient for real privacy. Refunds always return to the paying address.";

/** POST /v0/quote — EXACT_INPUT, origin-chain deposit, destination-chain delivery. */
export async function requestQuote(p: QuoteParams, opts?: OneClickOpts): Promise<OneClickResult> {
  return apiRequest(
    "/v0/quote",
    {
      method: "POST",
      body: {
        dry: p.dry,
        swapType: "EXACT_INPUT",
        slippageTolerance: p.slippageBps,
        originAsset: p.originAsset.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: p.destinationAsset.assetId,
        amount: p.amountAtoms.toString(),
        refundTo: p.refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient: p.recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + p.deadlineMin * 60_000).toISOString(),
        referral: "yeetful",
        ...(p.appFees?.length ? { appFees: p.appFees } : {}),
        ...(p.confidentiality ? { confidentiality: p.confidentiality } : {}),
      },
    },
    opts,
  );
}

// Well-formed placeholder addresses for DRY quotes only (pricing ignores the
// address contents). A real address is always required to BUILD.
const DRY_PLACEHOLDERS: Record<string, string> = {
  evm: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
  sol: "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK",
  near: "intents.near",
};

export function dryPlaceholderFor(blockchain: string): string | null {
  if (EVM_CHAINS[blockchain]) return DRY_PLACEHOLDERS.evm;
  if (blockchain === "sol") return DRY_PLACEHOLDERS.sol;
  if (blockchain === "near") return DRY_PLACEHOLDERS.near;
  return null;
}

// ── Status ───────────────────────────────────────────────────────────────────

export const STATUS_EXPLANATIONS: Record<string, string> = {
  PENDING_DEPOSIT:
    "1Click is waiting for funds to arrive at the deposit address. If the deposit transfer hasn't been signed and sent yet, that's the next step; if it was just sent, the chain hasn't confirmed it yet.",
  KNOWN_DEPOSIT_TX:
    "1Click knows the deposit transaction (submitted via submit_deposit_tx or detected on-chain) and is waiting for it to finalize.",
  INCOMPLETE_DEPOSIT:
    "Funds arrived, but LESS than the quoted amount. Send the remainder to the same deposit address before the deadline, or the partial deposit is refunded to the refund address.",
  PROCESSING:
    "Deposit confirmed — NEAR Intents solvers are executing the cross-chain swap right now. Delivery usually lands within the quoted time estimate.",
  SUCCESS:
    "Swap complete. The destination asset was delivered to the recipient on the destination chain — see destinationChainTxHashes for the delivery transaction and explorer link.",
  REFUNDED:
    "The swap did not complete (deposit too small, too late, or unfillable) and the deposit was returned to the refund address on the origin chain.",
  FAILED:
    "The swap failed. Check refund details in swapDetails; the correlationId plus the saved quote signature is what NEAR Intents support needs to investigate.",
};

/** GET /v0/status?depositAddress=… */
export async function getExecutionStatus(depositAddress: string, opts?: OneClickOpts): Promise<OneClickResult> {
  return apiRequest("/v0/status", { query: { depositAddress } }, opts);
}

/** POST /v0/deposit/submit — optional accelerator after the transfer is sent. */
export async function submitDepositTx(
  args: { txHash: string; depositAddress: string },
  opts?: OneClickOpts,
): Promise<OneClickResult> {
  return apiRequest("/v0/deposit/submit", { method: "POST", body: args }, opts);
}
