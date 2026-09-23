import { describe, expect, it } from "vitest";
import { capabilitiesPayload } from "../lib/tools";
import { SITE } from "../lib/handoff";

// The hands MCP is the human-handoff front door, and it stays that. But an
// agent that holds its OWN key has nobody to hand off to, and until it can
// NAME the surface that serves it legs it will either fake a human or give up.
// These pins keep that pointer honest — the M2 lesson (a stale public contract
// misdescribes the product to every agent that reads it), one surface on.
describe("the agent-signed pointer", () => {
  const cap = capabilitiesPayload();

  it("names the desk by URL and transport", () => {
    expect(cap.agentSigned.url).toBe(`${SITE}/api/broker/mcp`);
    expect(cap.agentSigned.transport).toBe("streamable-http");
    // Same host as every link this service mints — never a hardcoded origin.
    expect(cap.agentSigned.url.startsWith(SITE)).toBe(true);
  });

  it("names every tool of the loop, in order", () => {
    const loop = cap.agentSigned.loop.join(" ");
    for (const tool of ["broker_open", "broker_choose", "broker_execute", "broker_next", "broker_done", "broker_status"]) {
      expect(loop).toContain(tool);
    }
    expect(loop.indexOf("broker_execute")).toBeLessThan(loop.indexOf("broker_next"));
    expect(loop.indexOf("broker_next")).toBeLessThan(loop.indexOf("broker_done"));
  });

  it("carries the batch rule verbatim", () => {
    expect(cap.agentSigned.contract).toContain("Round-trip across every settlement boundary, batched within one.");
  });

  it("says when to use it, and keeps handoff the default", () => {
    expect(cap.agentSigned.when).toMatch(/hold the wallet AND the key/i);
    expect(cap.agentSigned.when).toMatch(/human should sign stays here/i);
    // The human lane is still the headline contract.
    expect(cap.contract).toMatch(/only a wallet signature moves anything/i);
    expect(cap.handoff).toContain("/sign?ask=");
  });

  it("still promises no transaction material FROM THIS SERVICE", () => {
    const whole = JSON.stringify(cap);
    // 64+ hex runs = calldata / typed data / signatures. The desk may serve
    // them to a proven agent; the hands surface never does.
    expect(whole).not.toMatch(/0x[0-9a-fA-F]{64,}/);
  });
});
