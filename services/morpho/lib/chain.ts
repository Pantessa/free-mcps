// ─────────────────────────────────────────────────────────────────────────
//  RPC wiring + the minimal ABIs this service calls. One shared viem client
//  per supported chain: rpcFor(1) → Ethereum, rpcFor(8453) → Base. Each
//  chain's env var (ETH_RPC_URL / BASE_RPC_URL) overrides its keyless
//  publicnode default. Every address probed live by `pnpm smoke` before a
//  deploy is called done.
// ─────────────────────────────────────────────────────────────────────────

import { createPublicClient, http } from "viem";
import { base, mainnet } from "viem/chains";
import { MORPHO_BY_CHAIN, type SupportedChainId } from "./registry";

// Inferred types (not the exported PublicClient) — the workspace hoists
// multiple viem copies whose nominal types don't unify.
const clients = new Map<SupportedChainId, ReturnType<typeof makeClient>>();
let testClient: ReturnType<typeof makeClient> | null = null;

function rpcUrl(chainId: SupportedChainId): string {
  const d = MORPHO_BY_CHAIN[chainId];
  return process.env[d.rpcEnvVar] || d.publicRpc;
}

function makeClient(chainId: SupportedChainId) {
  return createPublicClient({
    chain: chainId === 1 ? mainnet : base,
    // Multicall batching: a position scan (params + market + position per id)
    // collapses into a few Multicall3 aggregates instead of dozens of
    // eth_calls — which is what keeps the public RPCs from rate-limiting us.
    batch: { multicall: { wait: 16 } },
    transport: http(rpcUrl(chainId), { retryCount: 3, retryDelay: 300 }),
  });
}

/** Shared client for a supported chain. */
export function rpcFor(chainId: SupportedChainId) {
  if (testClient) return testClient;
  let client = clients.get(chainId);
  if (!client) {
    client = makeClient(chainId);
    clients.set(chainId, client);
  }
  return client;
}

/** Test seam: one fake serves EVERY chain (tests pass chainId explicitly). */
export function setRpcForTests(fake: unknown | null) {
  testClient = fake as ReturnType<typeof makeClient> | null;
}

/**
 * Retry a read when a free RPC rate-limits. The limiter answers with a
 * JSON-RPC error (not an HTTP failure), which viem's transport retry does NOT
 * retry — so resilience has to live here. Real reverts / unknown errors are
 * rethrown immediately.
 */
export async function readRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : "";
      if (!/rate limit|429|RPC Request failed|timeout/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

// ── Minimal ABIs (only the functions we call) ───────────────────────────────

/** Plain ERC-20 — balances, allowances, approvals, metadata. */
export const TOKEN_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

// ── Morpho (Blue) — lifted verbatim from services/robinhood/lib/chain.ts ────

export const MARKET_PARAMS_COMPONENTS = [
  { name: "loanToken", type: "address" },
  { name: "collateralToken", type: "address" },
  { name: "oracle", type: "address" },
  { name: "irm", type: "address" },
  { name: "lltv", type: "uint256" },
] as const;

export const MORPHO_ABI = [
  { name: "idToMarketParams", type: "function", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "", type: "tuple", components: MARKET_PARAMS_COMPONENTS }] },
  {
    name: "market",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "totalSupplyAssets", type: "uint128" },
          { name: "totalSupplyShares", type: "uint128" },
          { name: "totalBorrowAssets", type: "uint128" },
          { name: "totalBorrowShares", type: "uint128" },
          { name: "lastUpdate", type: "uint128" },
          { name: "fee", type: "uint128" },
        ],
      },
    ],
  },
  {
    name: "position",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }, { name: "user", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "supplyShares", type: "uint256" },
          { name: "borrowShares", type: "uint128" },
          { name: "collateral", type: "uint128" },
        ],
      },
    ],
  },
  { name: "supply", type: "function", stateMutability: "nonpayable", inputs: [{ name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS }, { name: "assets", type: "uint256" }, { name: "shares", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "data", type: "bytes" }], outputs: [{ name: "", type: "uint256" }, { name: "", type: "uint256" }] },
  { name: "withdraw", type: "function", stateMutability: "nonpayable", inputs: [{ name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS }, { name: "assets", type: "uint256" }, { name: "shares", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "receiver", type: "address" }], outputs: [{ name: "", type: "uint256" }, { name: "", type: "uint256" }] },
  { name: "supplyCollateral", type: "function", stateMutability: "nonpayable", inputs: [{ name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS }, { name: "assets", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "data", type: "bytes" }], outputs: [] },
  { name: "withdrawCollateral", type: "function", stateMutability: "nonpayable", inputs: [{ name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS }, { name: "assets", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "receiver", type: "address" }], outputs: [] },
  { name: "borrow", type: "function", stateMutability: "nonpayable", inputs: [{ name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS }, { name: "assets", type: "uint256" }, { name: "shares", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "receiver", type: "address" }], outputs: [{ name: "", type: "uint256" }, { name: "", type: "uint256" }] },
  { name: "repay", type: "function", stateMutability: "nonpayable", inputs: [{ name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS }, { name: "assets", type: "uint256" }, { name: "shares", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "data", type: "bytes" }], outputs: [{ name: "", type: "uint256" }, { name: "", type: "uint256" }] },
] as const;

/** Morpho market oracle: price of 1 collateral token in loan tokens, scaled so
 *  collateralValueInLoanAtoms = collateralAtoms × price / 1e36. */
export const MORPHO_ORACLE_ABI = [
  { name: "price", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

export const IRM_ABI = [
  {
    name: "borrowRateView",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS },
      {
        name: "market",
        type: "tuple",
        components: [
          { name: "totalSupplyAssets", type: "uint128" },
          { name: "totalSupplyShares", type: "uint128" },
          { name: "totalBorrowAssets", type: "uint128" },
          { name: "totalBorrowShares", type: "uint128" },
          { name: "lastUpdate", type: "uint128" },
          { name: "fee", type: "uint128" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
