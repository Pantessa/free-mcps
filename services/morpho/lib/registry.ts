// ─────────────────────────────────────────────────────────────────────────
//  Morpho (Blue) address book — Ethereum mainnet (1) + Base (8453).
//  Sources + verification, performed 2026-07-29:
//    · Morpho Blue singleton + Adaptive Curve IRM addresses —
//      docs.morpho.org (Resources → Addresses).
//    · Singleton 0xBBBB…FFCb bytecode verified via eth_getCode against
//      ethereum-rpc.publicnode.com AND base-rpc.publicnode.com: 15,623
//      bytes of runtime code on BOTH chains, byte-identical except two
//      32-byte PUSH32 immediates — the EIP-712 DOMAIN_SEPARATOR immutable,
//      which bakes in the chain id. Both embedded values were recomputed
//      locally (keccak256(abi.encode(typehash, chainId, address)):
//      chain 1 → 0xec6a…dd2d, chain 8453 → 0xc602…ad20) and match exactly,
//      proving the two deployments are the same contract.
//    · Adaptive Curve IRM bytecode verified non-empty via eth_getCode the
//      same day: 2,717 bytes on Ethereum, 2,323 bytes on Base (different
//      compiler settings per deployment — the IRM is chain-local, not a
//      CREATE2 twin; addresses differ by design).
//    · defaultMarketIds — blue-api.morpho.org/graphql, listed:true markets
//      ordered by SupplyAssetsUsd desc, snapshotted 2026-07-29 (USDC-loan
//      markets preferred). Params always come from on-chain
//      idToMarketParams — these are just ids to scan when the API is down.
//
//  NOTE: Morpho on Robinhood Chain (4663) deliberately stays in
//  services/robinhood — that chain runs a DIFFERENT core deployment
//  (0x9D53…1010, NOT this singleton) with its own token registry. This
//  service covers the canonical 0xBBBB… singleton chains only.
// ─────────────────────────────────────────────────────────────────────────

export type Address = `0x${string}`;

export type SupportedChainId = 1 | 8453;

export const SUPPORTED_CHAIN_IDS: readonly SupportedChainId[] = [1, 8453] as const;

/** Base is the default — cheapest to act on and the deepest listed USDC markets. */
export const DEFAULT_CHAIN_ID: SupportedChainId = 8453;

/** Morpho's official indexer (market discovery + curated `listed` flags). */
export const MORPHO_API = "https://blue-api.morpho.org/graphql";

/** The canonical Morpho Blue singleton — SAME address on Ethereum and Base. */
export const MORPHO_SINGLETON: Address = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

export interface MorphoDeployment {
  chainId: SupportedChainId;
  name: string;
  /** Morpho Blue core (the singleton every market lives in). */
  morpho: Address;
  /** Adaptive Curve IRM — the standard interest-rate model on this chain. */
  irm: Address;
  /**
   * Fallback market ids so `position`/`markets` keep working when the Blue
   * API is down: high-TVL listed markets snapshotted 2026-07-29. Ids only —
   * params are always read live from on-chain idToMarketParams.
   */
  defaultMarketIds: `0x${string}`[];
  /** Env var that overrides the public RPC for this chain. */
  rpcEnvVar: string;
  publicRpc: string;
  explorer: string;
}

export const MORPHO_BY_CHAIN: Record<SupportedChainId, MorphoDeployment> = {
  1: {
    chainId: 1,
    name: "Ethereum",
    morpho: MORPHO_SINGLETON,
    irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
    defaultMarketIds: [
      // Snapshot 2026-07-29 (blue-api, listed:true, by supplyAssetsUsd desc):
      "0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64", // USDC / cbBTC  (~$294M supplied)
      "0x3a85e619751152991742810df6ec69ce473daef99e28a64ab2340d7b7ccfee49", // USDC / WBTC   (~$118M)
      "0xe7e9694b754c4d4f7e21faf7223f6fa71abaeb10296a4c43a54a7977149687d2", // USDT / wstETH (~$195M)
      "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e", // WETH / wstETH (~$90M)
    ],
    rpcEnvVar: "ETH_RPC_URL",
    publicRpc: "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
  },
  8453: {
    chainId: 8453,
    name: "Base",
    morpho: MORPHO_SINGLETON,
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    defaultMarketIds: [
      // Snapshot 2026-07-29 (blue-api, listed:true, by supplyAssetsUsd desc):
      "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836", // USDC / cbBTC (~$1.44B supplied)
      "0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354", // USDC / USDe  (~$265M)
      "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda", // USDC / WETH  (~$78M)
      "0x3a4048c64ba1b375330d376b1ce40e4047d03b47ab4d48af484edec9fec801ba", // WETH / wstETH (~$8M)
    ],
    rpcEnvVar: "BASE_RPC_URL",
    publicRpc: "https://base-rpc.publicnode.com",
    explorer: "https://basescan.org",
  },
};

export const isSupportedChainId = (n: number): n is SupportedChainId =>
  (SUPPORTED_CHAIN_IDS as readonly number[]).includes(n);

/** Deployment lookup — null for unsupported chains (4663 lives in services/robinhood). */
export function deploymentFor(chainId: number): MorphoDeployment | null {
  return isSupportedChainId(chainId) ? MORPHO_BY_CHAIN[chainId] : null;
}
