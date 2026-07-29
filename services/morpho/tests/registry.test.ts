import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAIN_ID,
  MORPHO_BY_CHAIN,
  MORPHO_SINGLETON,
  SUPPORTED_CHAIN_IDS,
  deploymentFor,
  isSupportedChainId,
} from "@/lib/registry";

describe("registry pins (bytecode-verified 2026-07-29 — see registry.ts header)", () => {
  it("pins the SAME canonical singleton on both chains", () => {
    expect(MORPHO_SINGLETON).toBe("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
    expect(MORPHO_BY_CHAIN[1].morpho).toBe(MORPHO_SINGLETON);
    expect(MORPHO_BY_CHAIN[8453].morpho).toBe(MORPHO_SINGLETON);
  });

  it("pins per-chain Adaptive Curve IRMs (chain-local deployments, distinct by design)", () => {
    expect(MORPHO_BY_CHAIN[1].irm).toBe("0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC");
    expect(MORPHO_BY_CHAIN[8453].irm).toBe("0x46415998764C29aB2a25CbeA6254146D50D22687");
    expect(MORPHO_BY_CHAIN[1].irm).not.toBe(MORPHO_BY_CHAIN[8453].irm);
  });

  it("carries well-formed fallback market ids on every chain", () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      const ids = MORPHO_BY_CHAIN[chainId].defaultMarketIds;
      expect(ids.length).toBeGreaterThanOrEqual(3);
      for (const id of ids) expect(id).toMatch(/^0x[0-9a-f]{64}$/);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("supports exactly Ethereum + Base; 4663 stays in services/robinhood", () => {
    expect([...SUPPORTED_CHAIN_IDS]).toEqual([1, 8453]);
    expect(DEFAULT_CHAIN_ID).toBe(8453);
    expect(isSupportedChainId(4663)).toBe(false);
    expect(deploymentFor(4663)).toBeNull();
    expect(deploymentFor(1)?.name).toBe("Ethereum");
    expect(deploymentFor(8453)?.name).toBe("Base");
  });

  it("names a distinct RPC env override per chain", () => {
    expect(MORPHO_BY_CHAIN[1].rpcEnvVar).toBe("ETH_RPC_URL");
    expect(MORPHO_BY_CHAIN[8453].rpcEnvVar).toBe("BASE_RPC_URL");
  });
});
