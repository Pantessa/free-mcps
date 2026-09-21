// Shared offline fixtures — shapes mirror the live 1Click OpenAPI spec
// (probed 2026-07-09). The live smoke script validates the real wire.

export const TOKENS_FIXTURE = [
  {
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals: 6,
    blockchain: "base",
    symbol: "USDC",
    price: 0.9998,
    priceUpdatedAt: "2026-07-09T15:10:30.585Z",
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  {
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    decimals: 6,
    blockchain: "arb",
    symbol: "USDC",
    price: 0.9998,
    priceUpdatedAt: "2026-07-09T15:10:30.585Z",
    contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  },
  {
    assetId: "nep141:base.omft.near",
    decimals: 18,
    blockchain: "base",
    symbol: "ETH",
    price: 1744.9,
    priceUpdatedAt: "2026-07-09T15:10:30.585Z",
    // native asset — no contractAddress
  },
  {
    assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    decimals: 6,
    blockchain: "sol",
    symbol: "USDC",
    price: 0.9998,
    priceUpdatedAt: "2026-07-09T15:10:30.585Z",
    contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  {
    assetId: "nep141:btc.omft.near",
    decimals: 8,
    blockchain: "btc",
    symbol: "BTC",
    price: 67000,
    priceUpdatedAt: "2026-07-09T15:10:30.585Z",
  },
  // Duplicate symbol on one chain — resolveAsset must refuse ambiguity.
  {
    assetId: "nep141:base-0x1111111111111111111111111111111111111111.omft.near",
    decimals: 18,
    blockchain: "base",
    symbol: "DUP",
    price: 1,
    priceUpdatedAt: "2026-07-09T15:10:30.585Z",
    contractAddress: "0x1111111111111111111111111111111111111111",
  },
  {
    assetId: "nep141:base-0x2222222222222222222222222222222222222222.omft.near",
    decimals: 18,
    blockchain: "base",
    symbol: "DUP",
    price: 1,
    priceUpdatedAt: "2026-07-09T15:10:30.585Z",
    contractAddress: "0x2222222222222222222222222222222222222222",
  },
];

export const DEPOSIT_ADDRESS = "0x76b4c56085ED136a8744D52bE956396624a730E8";

export function quoteFixture(args: { dry: boolean; amountIn?: string; withMemo?: boolean; appFees?: Array<{ recipient: string; fee: number }>; confidentiality?: string }) {
  return {
    correlationId: "550e8400-e29b-41d4-a716-446655440000",
    timestamp: "2026-07-09T15:20:00.000Z",
    signature: "ed25519:sig-fixture",
    // 1Click echoes the request back with the app fee already split 50/50.
    quoteRequest: { ...(args.appFees ? { appFees: args.appFees } : {}), ...(args.confidentiality ? { confidentiality: args.confidentiality } : {}) },
    quote: {
      ...(args.dry ? {} : { depositAddress: DEPOSIT_ADDRESS, deadline: "2026-07-09T15:50:00.000Z" }),
      ...(args.withMemo ? { depositMemo: "1111111" } : {}),
      amountIn: args.amountIn ?? "550000",
      amountInFormatted: "0.55",
      amountInUsd: "0.55",
      minAmountIn: "550000",
      amountOut: "545000",
      amountOutFormatted: "0.545",
      amountOutUsd: "0.54",
      minAmountOut: "539550",
      timeEstimate: 60,
      withdrawFee: "3000",
    },
  };
}

export function statusFixture(status: string, extra?: Record<string, unknown>) {
  return {
    correlationId: "550e8400-e29b-41d4-a716-446655440000",
    quoteResponse: {
      quoteRequest: {
        originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        destinationAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
      },
    },
    status,
    updatedAt: "2026-07-09T15:25:00.000Z",
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [{ hash: "0xoriginhash", explorerUrl: "https://basescan.org/tx/0xoriginhash" }],
      destinationChainTxHashes:
        status === "SUCCESS" ? [{ hash: "0xdesthash", explorerUrl: "https://arbiscan.io/tx/0xdesthash" }] : [],
      amountInFormatted: "0.55",
      amountOutFormatted: status === "SUCCESS" ? "0.545" : undefined,
      amountOutUsd: status === "SUCCESS" ? "0.54" : undefined,
      ...extra,
    },
  };
}

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | null;

/** Tiny fetch mock: first handler that returns non-null wins. */
export function mockFetch(...handlers: Handler[]): typeof fetch {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const h of handlers) {
      const hit = h(url, init);
      if (hit) {
        return new Response(JSON.stringify(hit.body), {
          status: hit.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  (impl as unknown as { calls: typeof calls }).calls = calls;
  return impl;
}

export const tokensHandler: Handler = (url) => (url.includes("/v0/tokens") ? { body: TOKENS_FIXTURE } : null);

export const callsOf = (f: typeof fetch) => (f as unknown as { calls: { url: string; init?: RequestInit }[] }).calls;

export const bodyOf = (call: { init?: RequestInit }) => JSON.parse(String(call.init?.body ?? "{}"));
