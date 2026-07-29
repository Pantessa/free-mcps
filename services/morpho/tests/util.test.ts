import { describe, expect, it } from "vitest";
import { clip, formatAtoms, humanToAtoms } from "@/lib/util";

describe("amount conversion (decimals read per asset — USDC is 6, never assume 18)", () => {
  it("converts human amounts at 6 and 18 decimals", () => {
    expect(humanToAtoms("100", 6)).toBe(100_000_000n);
    expect(humanToAtoms("0.5", 6)).toBe(500_000n);
    expect(humanToAtoms("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(humanToAtoms("0.001", 8)).toBe(100_000n); // WBTC-style 8 decimals
  });

  it("rejects malformed, zero, and sub-atom amounts", () => {
    expect(humanToAtoms("abc", 6)).toBeNull();
    expect(humanToAtoms("-1", 6)).toBeNull();
    expect(humanToAtoms("0", 6)).toBeNull();
    expect(humanToAtoms("0.0000001", 6)).toBeNull(); // 7 fractional digits at 6 decimals
    expect(humanToAtoms("1e5", 6)).toBeNull();
  });

  it("round-trips through formatAtoms with trailing zeros trimmed", () => {
    expect(formatAtoms(1_500_000n, 6)).toBe("1.5");
    expect(formatAtoms(100_000_000n, 6)).toBe("100");
    expect(formatAtoms(1n, 18)).toBe("0.000000000000000001");
  });
});

describe("clip", () => {
  it("passes small payloads through and truncates huge ones", () => {
    expect(clip({ a: 1 })).toEqual({ a: 1 });
    const big = clip({ x: "y".repeat(30_000) }) as { note: string; preview: string };
    expect(big.note).toContain("truncated");
    expect(big.preview.length).toBeLessThanOrEqual(24_000);
  });
});
