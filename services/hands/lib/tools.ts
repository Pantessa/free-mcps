import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { scanWallet } from "./scan";
import { mintHandoff, SITE } from "./handoff";
import { mintIntentLink } from "./mint-link";

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function guarded<T>(run: () => Promise<T> | T) {
  try {
    return ok(await run());
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Call failed.");
  }
}

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

const userArg = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe(
    'The wallet to read — for the connected user ALWAYS pass "$USER_ADDRESS"; never guess or reuse an address from conversation. Read-only: scanning needs no signature.',
  );

/** What Pantessa's guarded builders can compile an ask into, one line each —
 *  the routing map a client agent needs to know when to hand off. */
const CAPABILITIES = [
  "Buy tokenized stocks (AAPL, TSLA, NVDA…) on Robinhood Chain — including automatic cross-chain funding when the money sits on Base/Ethereum/Arbitrum",
  "Swap tokens (Uniswap v3/v4, CoW incl. MEV-protected + limit orders), dollar-denominated asks welcome ('swap $5 of ETH')",
  "Recurring buys — 'buy $10 of AAPL every week' becomes a DCA schedule",
  "Protect a Hyperliquid position — stop-loss / take-profit the Guardian watches every minute",
  "Cross-chain moves (NEAR Intents) and Robinhood Chain bridging",
  "Aave supply/withdraw/borrow/repay, Lido staking, NFT transfers + Seaport listings, Snapshot DAO votes",
];

/** Where an agent that holds its OWN key and its OWN money goes instead. This
 *  service is the human-handoff front door by design — it returns sentences
 *  and links and nothing else — so the one honest thing it can do for a
 *  self-signing agent is name the surface that serves legs, and name it
 *  precisely enough to connect without a docs round trip. */
const DESK_URL = `${SITE}/api/broker/mcp`;
const AGENT_SIGNED = {
  url: DESK_URL,
  transport: "streamable-http",
  when: "You hold the wallet AND the key, and the ask is SEQUENCED (fund → wait for arrival → act). Anything a human should sign stays here.",
  loop: [
    "broker_open  — your plain sentence + your wallet + agent_key (your desk identity); returns the quote, the funding verdict, and route options.",
    "broker_choose — optional, repeatable: pick a funding route; it rewrites the working sentence and the desk re-quotes.",
    "broker_execute — one personal_sign over the desk's consent text proves the wallet; the ask compiles into a job owned by it.",
    "broker_next — the leg the runner is offering: what it does in a sentence, its kind (tx | txChain | hlAction | hlBatch | order), chain, notional, how long it stays signable, and the guarded artifact itself.",
    "broker_done — post what you signed; it records the leg, rolls the runner forward, and answers with the next one.",
    "… repeat next/done per leg, then broker_status for the funnel.",
  ],
  contract:
    "Round-trip across every settlement boundary, batched within one. A wait leg verifies on-chain arrival before the next leg is built, and same-chain work (approve → swap) arrives as one ordered chain. Pantessa still writes every transaction deterministically and guard-checks it fail-closed at offer time; your key is the only thing that signs, and legs are served only to the agent_key the intent was opened with.",
};

/** The capability map, as data. Exported so the test suite can pin the
 *  contract this service publishes — a stale contract misdescribes the
 *  product to every agent that reads it (the exact bug M2 fixed). */
export function capabilitiesPayload() {
  return {
    capabilities: CAPABILITIES,
    contract:
      "Pantessa is the non-custodial back office for autonomous money: deterministic builders construct every transaction (no AI writes calldata or addresses), every build is guarded fail-closed, priced, and receipted, and only a wallet signature moves anything. Your job as the agent: scan (scan_wallet), decide what should happen, then mint a sign link (prepare_handoff / plan_stock_buy) and hand it to your human — or PUBLISH the plan as a durable, shareable intent link (mint_intent_link, needs your operator's yf_ API key). If the wallet and the key are YOURS, don't hand anything off: the desk MCP's agent-signed path (see `agentSigned`) compiles the ask into a sequenced job and serves you one guarded leg at a time.",
    handoff: `Sign links look like ${SITE}/sign?ask=<sentence>, or a durable ${SITE}/i/<slug> intent link — the ask travels as a sentence and is rebuilt from scratch on Pantessa's side.`,
    desk: `This service is fire-and-forget: you plan, you hand off, you're done. If you want a stateful negotiation loop that TALKS BACK — funding routes, and a broker_status feedback loop that tells you when your human actually signed — connect the Pantessa desk MCP at ${DESK_URL} (broker_open → broker_choose → broker_handoff → broker_status).`,
    agentSigned: AGENT_SIGNED,
  };
}

/** The capability-map handler, shared by the current tool name and the
 *  back-compat alias. */
async function capabilitiesHandler() {
  return guarded(() => capabilitiesPayload());
}

/** Register the hands (agent-handoff) tool surface. */
export function registerHandsTools(server: Server): void {
  server.registerTool(
    "what_pantessa_can_do",
    {
      title: "What Pantessa Can Build (and the handoff contract)",
      description:
        "START HERE. The capability map of what Pantessa's guarded transaction layer can compile a plain-English ask into, plus the handoff contract: YOU plan, the HUMAN signs at pantessa.com — this service never returns calldata or artifacts, so nothing you receive here can execute by itself. Free, instant, no wallet needed.",
      inputSchema: {},
    },
    capabilitiesHandler,
  );

  // Back-compat alias: agents (and registries) that learned the old name keep
  // working through the rebrand. Same handler, same output.
  server.registerTool(
    "what_yeetful_can_do",
    {
      title: "What Pantessa Can Build (alias of what_pantessa_can_do)",
      description:
        "Alias of what_pantessa_can_do (Pantessa was formerly Yeetful). START HERE for the capability map + handoff contract. Prefer what_pantessa_can_do in new integrations.",
      inputSchema: {},
    },
    capabilitiesHandler,
  );

  server.registerTool(
    "scan_wallet",
    {
      title: "Scan a Wallet's Movable Money",
      description:
        'ETH + USDC across Base, Arbitrum, and Ethereum in one call, gas-reserve aware (an ETH balance only counts above what a transfer costs; USDC only counts where the wallet also holds gas). Use it to ground your plan in what the human actually holds — e.g. discovering the money for a Robinhood Chain stock buy sits on Ethereum. failedChains means UNKNOWN, never empty. Pass user="$USER_ADDRESS" for the connected user.',
      inputSchema: { user: userArg },
    },
    async ({ user }) => guarded(() => scanWallet(user as `0x${string}`)),
  );

  server.registerTool(
    "prepare_handoff",
    {
      title: "Mint the Sign Link (any ask)",
      description:
        "Turn ANY ask Pantessa can build (see what_pantessa_can_do) into the ONE link you hand your human: a pantessa.com/sign page showing the ask and the guardrail contract, flowing into the guarded build + their wallet's signature. Phrase the ask as a complete plain-English sentence with amounts and tokens ('Buy $12 of AAPL', 'Swap $5 of ETH to USDC on Base', 'Buy $10 of AAPL every week'). The link carries the sentence only — no calldata, no addresses — and nothing happens until the human acts. USE THIS WHEN A HUMAN OWNS THE WALLET. If the wallet and the key are your OWN, there is nobody to hand off to: connect the desk MCP at " +
        DESK_URL +
        " (streamable-http) and run broker_open → broker_execute → broker_next / broker_done — it compiles your ask into a sequenced job and serves you one guarded, signable leg at a time, round-tripping across every settlement boundary and batching within one.",
      inputSchema: {
        ask: z.string().min(3).max(400).describe("The action as one plain-English sentence, amounts included."),
        agent: z.string().max(40).optional().describe('Who prepared this — shown on the sign page byline (e.g. "Claude").'),
        mcps: z.array(z.string()).max(6).optional().describe('Optional free-fleet slugs to toggle on when the human lands (e.g. ["robinhood-free"]). Omit when unsure — the native layers parse most asks without any.'),
      },
    },
    async ({ ask, agent, mcps }) => guarded(() => mintHandoff(ask, { agent, mcps })),
  );

  server.registerTool(
    "mint_intent_link",
    {
      title: "Publish a Plan as an Intent Link (durable, shareable)",
      description:
        "Mint a REAL, durable pantessa.com/i/<slug> intent link carrying your ask — the shareable version of prepare_handoff. Whoever opens it (anyone, forever, until revoked) faces an explicit Connect & build consent step; Pantessa rebuilds the ask from scratch through its guarded builders and the visitor's own wallet is the only signer. The creator on record is your OPERATOR (the owner of the yf_ API key — from pantessa.com/dashboard), who gets the open→connect→build→sign funnel and any conversion earnings on their dashboard, and can revoke anytime. Optional redirect_url (public https) sends signers back to a site afterwards — never automatically, only via a post-signature button. This call returns no transaction material.",
      inputSchema: {
        ask: z.string().min(8).max(400).describe("The action as one plain-English sentence, amounts included ('Buy $10 of AAPL', 'DCA $25 into ETH weekly')."),
        api_key: z
          .string()
          .regex(/^yf_[0-9a-f]{64}$/)
          .optional()
          .describe("Your operator's Pantessa API key (yf_…). Optional when the service is deployed with PANTESSA_API_KEY (or the legacy YEETFUL_API_KEY) set."),
        redirect_url: z.string().url().optional().describe("Public https URL signers are offered a return button to after signing (e.g. your operator's site)."),
        agent: z.string().max(40).optional().describe('Who prepared this — shown as the byline on the link page (e.g. "Claude").'),
        mcps: z.array(z.string()).max(4).optional().describe('Optional free-fleet slugs to attach (e.g. ["robinhood-free"]). Omit when unsure — the composer decides from the ask.'),
      },
    },
    async ({ ask, api_key, redirect_url, agent, mcps }) =>
      guarded(() => mintIntentLink(ask, { apiKey: api_key, redirectUrl: redirect_url, agent, mcps })),
  );

  server.registerTool(
    "plan_stock_buy",
    {
      title: "Plan a Stock Buy (scan + narrate + sign link)",
      description:
        'The one-call composite for tokenized-stock asks ("buy $12 of AAPL"): scans the wallet\'s movable money across Base/Arbitrum/Ethereum, narrates how Pantessa will settle the buy on Robinhood Chain (cross-chain funding included when the money sits elsewhere), and mints the sign link. Tell the human what you found and hand them the link. Construction-only: this call reads balances and builds a link — it cannot sign, submit, or move anything.',
      inputSchema: {
        user: userArg,
        symbol: z
          .string()
          .regex(/^[A-Za-z.]{1,10}$/)
          .describe('The stock ticker ("AAPL", "TSLA", "NVDA"…).'),
        usd: z.number().positive().max(100000).describe("The buy size in US dollars."),
        agent: z.string().max(40).optional().describe('Who prepared this — shown on the sign page byline (e.g. "Claude").'),
      },
    },
    async ({ user, symbol, usd, agent }) =>
      guarded(async () => {
        const ticker = symbol.toUpperCase();
        const ask = `Buy $${usd} of ${ticker}`;
        const scan = await scanWallet(user as `0x${string}`);
        const movableUsd = scan.holdings.reduce((s, h) => s + h.usd, 0);
        const funded = movableUsd >= usd;
        const where = scan.holdings.map((h) => `${h.balance.toFixed(h.token === "ETH" ? 5 : 2)} ${h.token} on ${h.chain}`).join(", ") || "nothing movable on the scanned chains";
        const handoff = mintHandoff(ask, { agent, mcps: ["robinhood-free"] });
        return {
          scan,
          narrative: funded
            ? `The wallet holds ${where} (~$${movableUsd.toFixed(2)} movable). Pantessa will route what's needed to Robinhood Chain (bridge legs where required), settle the ${ticker} buy through its guarded venue with the fee as its own visible step, and the human signs each step with their own wallet.`
            : `The wallet holds ${where} (~$${movableUsd.toFixed(2)} movable) — short of $${usd}. Hand over the link anyway: Pantessa's funding planner will show what's possible, and unreadable chains (${scan.failedChains.join(", ") || "none"}) may hold more.`,
          ...handoff,
        };
      }),
  );
}
