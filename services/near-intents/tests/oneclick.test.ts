import { beforeEach, describe, expect, it } from "vitest";
import {
  chainLabel,
  clearTokenCache,
  clip,
  formatAtoms,
  getTokens,
  humanToAtoms,
  normalizeChain,
  resolveAsset,
} from "@/lib/oneclick";
import { TOKENS_FIXTURE, callsOf, mockFetch, tokensHandler } from "./fixtures";

beforeEach(() => clearTokenCache());

describe("chain normalization", () => {
  it("accepts enum values, friendly names, and EVM chainIds", () => {
    expect(normalizeChain("base")).toBe("base");
    expect(normalizeChain("Arbitrum")).toBe("arb");
    expect(normalizeChain("ethereum")).toBe("eth");
    expect(normalizeChain("8453")).toBe("base");
    expect(normalizeChain("42161")).toBe("arb");
    expect(normalizeChain("Solana")).toBe("sol");
    expect(normalizeChain("polygon")).toBe("pol");
    // Robinhood Chain: 1Click calls it "hood" (live 2026-09-21).
    expect(normalizeChain("Robinhood Chain")).toBe("hood");
    expect(normalizeChain("robinhood")).toBe("hood");
    expect(normalizeChain("hood")).toBe("hood");
    expect(normalizeChain("4663")).toBe("hood");
  });

  it("rejects unknown chains with the supported list", () => {
    expect(() => normalizeChain("hogwarts")).toThrow(/Unknown chain "hogwarts"/);
  });

  it("labels chains for humans", () => {
    expect(chainLabel("arb")).toBe("Arbitrum");
    expect(chainLabel("btc")).toBe("Bitcoin");
  });
});

describe("amount conversion", () => {
  it("converts human units to base units with real decimals", () => {
    expect(humanToAtoms("0.55", 6)).toBe(550000n);
    expect(humanToAtoms("100", 6)).toBe(100000000n);
    expect(humanToAtoms("1.5", 18)).toBe(1500000000000000000n);
  });

  it("rejects malformed and zero amounts", () => {
    expect(() => humanToAtoms("1,5", 6)).toThrow(/Invalid amount/);
    expect(() => humanToAtoms("-2", 6)).toThrow(/Invalid amount/);
    expect(() => humanToAtoms("0", 6)).toThrow(/greater than zero/);
  });

  it("formats base units back to human units", () => {
    expect(formatAtoms(539550n, 6)).toBe("0.53955");
    expect(formatAtoms("1000000", 6)).toBe("1");
  });
});

describe("token list + resolution", () => {
  it("caches the token list across calls", async () => {
    const f = mockFetch(tokensHandler);
    await getTokens({ fetchImpl: f });
    await getTokens({ fetchImpl: f });
    expect(callsOf(f).length).toBe(1);
  });

  it("resolves by symbol, contract address, and assetId", async () => {
    const f = mockFetch(tokensHandler);
    const bySymbol = await resolveAsset("base", "usdc", { fetchImpl: f });
    expect(bySymbol.assetId).toContain("base-0x833589");
    const byContract = await resolveAsset("arbitrum", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", { fetchImpl: f });
    expect(byContract.symbol).toBe("USDC");
    const byAssetId = await resolveAsset("base", TOKENS_FIXTURE[0].assetId, { fetchImpl: f });
    expect(byAssetId.decimals).toBe(6);
  });

  it("refuses ambiguous symbols and lists the candidates", async () => {
    const f = mockFetch(tokensHandler);
    await expect(resolveAsset("base", "DUP", { fetchImpl: f })).rejects.toThrow(/matches 2 tokens/);
  });

  it("suggests alternatives for unknown tokens", async () => {
    const f = mockFetch(tokensHandler);
    await expect(resolveAsset("base", "NOPE", { fetchImpl: f })).rejects.toThrow(/isn't supported on Base.*USDC/s);
  });
});

describe("clip", () => {
  it("passes small payloads through and truncates huge ones", () => {
    expect(clip({ a: 1 })).toEqual({ a: 1 });
    const huge = { rows: "x".repeat(30_000) };
    const clipped = clip(huge) as { note: string; preview: string };
    expect(clipped.note).toContain("truncated");
    expect(clipped.preview.length).toBeLessThanOrEqual(24_000);
  });
});
