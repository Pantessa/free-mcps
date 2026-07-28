// The chain arg's describe has always promised aliases (ethereum→mainnet,
// …) but the bare z.enum rejected them — live 2026-07-28, a planner-routed
// build_swap_order with chain "ethereum" -32602'd twice in one chat while
// lib/cow's resolveChain would have accepted it. The schema is the boundary;
// it must keep the description's promise.
import { describe, expect, it } from "vitest";
import { chainValue } from "@/lib/tools";

describe("chain arg schema aliases", () => {
  it("accepts every alias the describe promises, case-insensitively", () => {
    expect(chainValue.parse("ethereum")).toBe("mainnet");
    expect(chainValue.parse("Ethereum")).toBe("mainnet");
    expect(chainValue.parse("eth")).toBe("mainnet");
    expect(chainValue.parse("xdai")).toBe("gnosis");
    expect(chainValue.parse("arbitrum_one")).toBe("arbitrum");
    expect(chainValue.parse("matic")).toBe("polygon");
    expect(chainValue.parse("bsc")).toBe("bnb");
    expect(chainValue.parse("avax")).toBe("avalanche");
  });

  it("keeps canonical names and still rejects garbage", () => {
    expect(chainValue.parse("Mainnet")).toBe("mainnet");
    expect(chainValue.parse("base")).toBe("base");
    expect(() => chainValue.parse("solana")).toThrow();
  });
});
