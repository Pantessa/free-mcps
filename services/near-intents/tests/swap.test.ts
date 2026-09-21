import { beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache } from "@/lib/oneclick";
import { buildSwap, dryQuote } from "@/lib/swap";
import { DEPOSIT_ADDRESS, bodyOf, callsOf, mockFetch, quoteFixture, tokensHandler } from "./fixtures";

beforeEach(() => clearTokenCache());

const FROM = "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const quoteHandler =
  (fixture: ReturnType<typeof quoteFixture>) =>
  (url: string): { body: unknown } | null =>
    url.includes("/v0/quote") ? { body: fixture } : null;

describe("dry quote (preview)", () => {
  it("prices USDC Base → Arbitrum with placeholders and explains the next step", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: true })));
    const r = await dryQuote(
      { originChain: "base", originToken: "USDC", destinationChain: "arbitrum", destinationToken: "USDC", amount: "0.55" },
      { fetchImpl: f },
    );

    expect(r.kind).toBe("preview_quote");
    expect(r.quote.sell.amount).toBe("0.55");
    expect(r.quote.receive.minimum).toBe("0.53955");
    expect(r.quote.summary).toContain("Base");
    expect(r.quote.summary).toContain("Arbitrum");
    expect(r.next_step).toContain("build_swap");

    const quoteCall = callsOf(f).find((c) => c.url.includes("/v0/quote"))!;
    const body = bodyOf(quoteCall);
    expect(body.dry).toBe(true);
    expect(body.swapType).toBe("EXACT_INPUT");
    expect(body.amount).toBe("550000");
    expect(body.depositType).toBe("ORIGIN_CHAIN");
    expect(body.recipientType).toBe("DESTINATION_CHAIN");
    expect(body.referral).toBe("yeetful");
    expect(new Date(body.deadline).getTime()).toBeGreaterThan(Date.now());
  });

  it("requires an explicit recipient for destinations with no safe placeholder (BTC)", async () => {
    const f = mockFetch(tokensHandler);
    await expect(
      dryQuote(
        { originChain: "base", originToken: "USDC", destinationChain: "btc", destinationToken: "BTC", amount: "10" },
        { fetchImpl: f },
      ),
    ).rejects.toThrow(/needs a recipient address/);
  });

  it("rejects same-asset swaps", async () => {
    const f = mockFetch(tokensHandler);
    await expect(
      dryQuote(
        { originChain: "base", originToken: "USDC", destinationChain: "base", destinationToken: "USDC", amount: "1" },
        { fetchImpl: f },
      ),
    ).rejects.toThrow(/must differ/);
  });
});

describe("build_swap (real deposit transfer)", () => {
  const args = {
    originChain: "base",
    originToken: "USDC",
    destinationChain: "arbitrum",
    destinationToken: "USDC",
    amount: "0.55",
    from: FROM,
  };

  it("builds the ERC-20 transfer to the deposit address as a send_transaction step", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false })));
    const r = await buildSwap(args, { fetchImpl: f, readBalance: async () => 10_000_000n });

    expect(r.kind).toBe("swap_ready");
    expect(r.deposit.address).toBe(DEPOSIT_ADDRESS);
    expect(r.steps).toHaveLength(1);
    const step = r.steps[0];
    expect(step.action).toBe("send_transaction");
    expect(step.label).toBe("deposit");
    expect(step.tx.chainId).toBe(8453);
    expect(step.tx.to.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(step.tx.value).toBe("0");
    // transfer(address,uint256) selector + deposit address + 550000
    expect(step.tx.data.startsWith("0xa9059cbb")).toBe(true);
    expect(step.tx.data.toLowerCase()).toContain(DEPOSIT_ADDRESS.slice(2).toLowerCase());
    expect(step.tx.data).toContain((550000n).toString(16).padStart(8, "0"));

    // The wire request is a REAL (non-dry) quote refunding to the payer.
    const body = bodyOf(callsOf(f).find((c) => c.url.includes("/v0/quote"))!);
    expect(body.dry).toBe(false);
    expect(body.refundTo).toBe(FROM);
    expect(body.recipient).toBe(FROM); // EVM→EVM defaults to the payer

    // Narration contract: numbered flow + warnings + balance verdict.
    expect(r.flow).toHaveLength(4);
    expect(r.flow[0]).toContain("signs");
    expect(r.flow[3]).toContain("await_completion");
    expect(r.warnings.join(" ")).toContain("single-use");
    expect(r.balanceCheck.ok).toBe(true);
    expect(r.receipt.correlationId).toBeTruthy();
  });

  it("funds Robinhood Chain: Base USDC → USDG on hood, delivered to the payer", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false })));
    const r = await buildSwap(
      { ...args, destinationChain: "robinhood chain", destinationToken: "USDG" },
      { fetchImpl: f, readBalance: async () => 10_000_000n },
    );
    expect(r.steps[0].tx.chainId).toBe(8453);
    const body = bodyOf(callsOf(f).find((c) => c.url.includes("/v0/quote"))!);
    expect(body.destinationAsset).toBe("nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near");
    expect(body.recipient).toBe(FROM); // hood is EVM — same address, no recipient needed
    expect(body.refundTo).toBe(FROM);
  });

  it("leaves Robinhood Chain: USDG on hood → Base USDC is a deposit built on chain 4663", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false })));
    const r = await buildSwap(
      { originChain: "hood", originToken: "USDG", destinationChain: "base", destinationToken: "USDC", amount: "0.55", from: FROM },
      { fetchImpl: f, readBalance: async () => 10_000_000n },
    );
    const step = r.steps[0];
    expect(step.tx.chainId).toBe(4663);
    expect(step.tx.to.toLowerCase()).toBe("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
    expect(step.tx.data.startsWith("0xa9059cbb")).toBe(true);
    expect(step.tx.data.toLowerCase()).toContain(DEPOSIT_ADDRESS.slice(2).toLowerCase());
  });

  it("builds a native-value transfer when the origin asset has no contract", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false, amountIn: "1500000000000000000" })));
    const r = await buildSwap(
      { ...args, originToken: "ETH", amount: "1.5" },
      { fetchImpl: f, readBalance: async () => 2_000_000_000_000_000_000n },
    );
    const step = r.steps[0];
    expect(step.tx.to).toBe(DEPOSIT_ADDRESS);
    expect(step.tx.data).toBe("0x");
    expect(step.tx.value).toBe("1500000000000000000");
  });

  it("flags an insufficient balance without refusing the build", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false })));
    const r = await buildSwap(args, { fetchImpl: f, readBalance: async () => 1000n });
    expect(r.balanceCheck.ok).toBe(false);
    expect(r.balanceCheck.note).toContain("fund the wallet");
    expect(r.steps).toHaveLength(1);
  });

  it("survives a dead RPC (balance check is advisory)", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false })));
    const r = await buildSwap(args, {
      fetchImpl: f,
      readBalance: async () => {
        throw new Error("rpc down");
      },
    });
    expect(r.balanceCheck.ok).toBeNull();
    expect(r.steps).toHaveLength(1);
  });

  it("refuses non-EVM origins with a pointer to quote", async () => {
    const f = mockFetch(tokensHandler);
    await expect(buildSwap({ ...args, originChain: "sol" }, { fetchImpl: f })).rejects.toThrow(/only BUILD deposit transactions on EVM/);
  });

  it("requires an explicit recipient for non-EVM destinations", async () => {
    const f = mockFetch(tokensHandler);
    await expect(
      buildSwap({ ...args, destinationChain: "btc", destinationToken: "BTC" }, { fetchImpl: f }),
    ).rejects.toThrow(/needs an explicit recipient/);
  });

  it("requires a valid from address", async () => {
    const f = mockFetch(tokensHandler);
    await expect(buildSwap({ ...args, from: "$USER_ADDRESS" }, { fetchImpl: f })).rejects.toThrow(/valid `from`/);
  });

  it("refuses memo-carrying routes instead of dropping the memo", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false, withMemo: true })));
    await expect(buildSwap(args, { fetchImpl: f, readBalance: async () => 10_000_000n })).rejects.toThrow(/deposit memo/);
  });

  it("surfaces 1Click API errors legibly", async () => {
    const f = mockFetch(tokensHandler, (url) =>
      url.includes("/v0/quote") ? { status: 400, body: { message: "Amount too low for this route" } } : null,
    );
    await expect(buildSwap(args, { fetchImpl: f })).rejects.toThrow(/Amount too low/);
  });
});

describe("app fees", () => {
  const args = {
    originChain: "base",
    originToken: "USDC",
    destinationChain: "arbitrum",
    destinationToken: "USDC",
    amount: "0.55",
    from: FROM,
  };
  const TREASURY = "0x9Cc0B7A0DdB091E17647d689206e730131E9892A";
  // What 1Click echoes back for a 20bps request: halved between the caller
  // and the protocol's own implicit account.
  const SPLIT = [
    { recipient: TREASURY, fee: 10 },
    { recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: 10 },
  ];

  it("sends appFees on the quote and echoes the split 1Click applied", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false, appFees: SPLIT })));
    const r = await buildSwap({ ...args, feeRecipient: TREASURY, feeBps: 20 }, { fetchImpl: f, readBalance: async () => 10_000_000n });

    const body = bodyOf(callsOf(f).find((c) => c.url.includes("/v0/quote"))!);
    expect(body.appFees).toEqual([{ recipient: TREASURY, fee: 20 }]);
    // The deposit is untouched by the fee — it comes out of the OUTPUT.
    expect(body.amount).toBe("550000");
    expect(r.appFee!.requested).toEqual([{ recipient: TREASURY, fee: 20 }]);
    expect(r.appFee!.applied).toEqual(SPLIT);
    expect(r.appFee!.note).toMatch(/50\/50/);
  });

  it("prices previews with the same fee the build will charge", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: true, appFees: SPLIT })));
    const r = await dryQuote({ ...args, feeRecipient: TREASURY, feeBps: 20 }, { fetchImpl: f });
    expect(bodyOf(callsOf(f).find((c) => c.url.includes("/v0/quote"))!).appFees).toEqual([{ recipient: TREASURY, fee: 20 }]);
    expect(r.appFee!.applied).toEqual(SPLIT);
  });

  it("omits appFees entirely when no fee is asked for", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false })));
    const r = await buildSwap(args, { fetchImpl: f, readBalance: async () => 10_000_000n });
    expect(bodyOf(callsOf(f).find((c) => c.url.includes("/v0/quote"))!).appFees).toBeUndefined();
    expect(r.appFee).toBeUndefined();
  });

  it("fails CLOSED on a malformed recipient — 1Click would charge it anyway", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false })));
    await expect(
      buildSwap({ ...args, feeRecipient: "not-an-address", feeBps: 20 }, { fetchImpl: f }),
    ).rejects.toThrow(/feeRecipient must be/);
    // Nothing was quoted — the refusal happens before any network call.
    expect(callsOf(f).some((c) => c.url.includes("/v0/quote"))).toBe(false);
  });

  it("refuses half a fee spec and an out-of-range rate", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false })));
    await expect(buildSwap({ ...args, feeBps: 20 }, { fetchImpl: f })).rejects.toThrow(/must be passed together/);
    await expect(
      buildSwap({ ...args, feeRecipient: TREASURY, feeBps: 900 }, { fetchImpl: f }),
    ).rejects.toThrow(/between 0 and 500/);
  });

  it("treats feeBps 0 as no fee at all", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false })));
    const r = await buildSwap({ ...args, feeRecipient: TREASURY, feeBps: 0 }, { fetchImpl: f, readBalance: async () => 10_000_000n });
    expect(bodyOf(callsOf(f).find((c) => c.url.includes("/v0/quote"))!).appFees).toBeUndefined();
    expect(r.appFee).toBeUndefined();
  });
});

describe("confidential swaps", () => {
  const args = {
    originChain: "base",
    originToken: "USDC",
    destinationChain: "arbitrum",
    destinationToken: "USDC",
    amount: "0.55",
    from: FROM,
  };
  const OTHER = "0x1111111111111111111111111111111111111111";
  const quoteBody = (f: typeof fetch) => bodyOf(callsOf(f).find((c) => c.url.includes("/v0/quote"))!);

  it("sends the level, builds the SAME deposit, and says the payout is matchable when it returns to the payer", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false, confidentiality: "basic" })));
    const r = await buildSwap({ ...args, confidentiality: "basic" }, { fetchImpl: f, readBalance: async () => 10_000_000n });
    expect(quoteBody(f).confidentiality).toBe("basic");
    expect(quoteBody(f).refundTo).toBe(FROM);
    expect(r.deposit.address).toBe(DEPOSIT_ADDRESS);
    expect(r.steps).toHaveLength(1);
    expect(r.confidential).toMatchObject({ level: "basic", deliversToPayer: true });
    expect(r.confidential!.note).toMatch(/different recipient/);
  });

  it("delivers to a separate recipient while refunds stay with the payer", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false, confidentiality: "advanced" })));
    const r = await buildSwap({ ...args, recipient: OTHER, confidentiality: "advanced" }, { fetchImpl: f, readBalance: async () => 10_000_000n });
    expect(quoteBody(f).recipient).toBe(OTHER);
    expect(quoteBody(f).refundTo).toBe(FROM);
    expect(r.confidential).toMatchObject({ level: "advanced", deliversToPayer: false });
  });

  it("refuses when the venue does not echo the level — a private ask never becomes a public swap", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false })));
    await expect(buildSwap({ ...args, confidentiality: "basic" }, { fetchImpl: f, readBalance: async () => 10_000_000n })).rejects.toThrow(/never falls back to a public swap/);
  });

  it("omits the field for public and absent, and refuses an unknown level before any quote", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false })));
    const r = await buildSwap({ ...args, confidentiality: "public" }, { fetchImpl: f, readBalance: async () => 10_000_000n });
    expect(quoteBody(f).confidentiality).toBeUndefined();
    expect(r.confidential).toBeUndefined();

    const g = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: false })));
    await expect(buildSwap({ ...args, confidentiality: "stealth" }, { fetchImpl: g })).rejects.toThrow(/must be one of/);
    expect(callsOf(g).some((c) => c.url.includes("/v0/quote"))).toBe(false);
  });

  it("previews at the same level the build will use", async () => {
    const f = mockFetch(tokensHandler, quoteHandler(quoteFixture({ dry: true, confidentiality: "basic" })));
    const r = await dryQuote({ ...args, confidentiality: "basic" }, { fetchImpl: f });
    expect(quoteBody(f).confidentiality).toBe("basic");
    expect(r.confidential!.level).toBe("basic");
  });
});
