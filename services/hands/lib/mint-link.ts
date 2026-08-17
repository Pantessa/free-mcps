// Agent-minted intent links — the publish half of the handoff contract.
// prepare_handoff mints a one-shot /sign link; THIS mints a durable,
// shareable /i/<slug> intent link through the website's SIWE-less Bearer
// door (POST /api/intent-links with the operator's yf_ key). The creator is
// the key's owner — the agent's OPERATOR, never the agent itself — so caps,
// funnels, and creator earnings all land on a human's dashboard. Same
// no-artifact property as /sign: the link carries the ask as a sentence and
// Pantessa rebuilds it behind an explicit Connect & build consent step.

import { cleanAsk, SITE } from "./handoff";

const KEY_RE = /^yf_[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

export interface MintedLink {
  linkUrl: string;
  slug: string;
  ask: string;
  redirectUrl: string | null;
  funnelUrl: string;
  contract: string;
  nextSteps: string[];
}

/** Local mirror of the website's mint-time redirect rule (https, public
 *  host, no credentials) so an agent gets a crisp error before the network
 *  round-trip. The website re-validates — this is UX, not the gate. */
export function checkRedirect(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return null;
  return u.toString();
}

/** Mint a real /i/<slug> intent link as the key owner. Throws with the
 *  website's own error message on refusal (bad key → 401, plan cap → 402,
 *  malformed ask/redirect → 400). */
export async function mintIntentLink(
  rawAsk: string,
  opts: { apiKey?: string; redirectUrl?: string; agent?: string; mcps?: string[] } = {},
): Promise<MintedLink> {
  const ask = cleanAsk(rawAsk);
  if (ask.length < 8) throw new Error("The ask must be a plain sentence (at least 8 characters), amounts included.");

  const apiKey = (opts.apiKey ?? process.env.PANTESSA_API_KEY ?? process.env.YEETFUL_API_KEY ?? "").trim();
  if (!KEY_RE.test(apiKey)) {
    throw new Error(
      "Minting a durable intent link needs your operator's Pantessa API key (yf_…, from pantessa.com/dashboard). Pass it as api_key or set PANTESSA_API_KEY (the legacy YEETFUL_API_KEY still works). For a one-shot handoff with no key, use prepare_handoff instead.",
    );
  }

  let redirectUrl: string | undefined;
  if (opts.redirectUrl) {
    const v = checkRedirect(opts.redirectUrl);
    if (!v) throw new Error("redirect_url must be a public https URL (no credentials, no localhost/IPs).");
    redirectUrl = v;
  }

  const mcps = (opts.mcps ?? []).map((s) => s.trim()).filter((s) => SLUG_RE.test(s)).slice(0, 4);
  const agent = cleanAsk(opts.agent ?? "").slice(0, 40);

  const res = await fetch(`${SITE}/api/intent-links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      ask,
      ...(redirectUrl ? { redirectUrl } : {}),
      ...(agent ? { agent } : {}),
      ...(mcps.length ? { mcps } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { slug?: string; ask?: string; redirectUrl?: string | null; error?: string };
  if (!res.ok || !body.slug) {
    throw new Error(body.error ?? `Mint failed (${res.status}).`);
  }

  return {
    linkUrl: `${SITE}/i/${body.slug}`,
    slug: body.slug,
    ask: body.ask ?? ask,
    redirectUrl: body.redirectUrl ?? null,
    funnelUrl: `${SITE}/dashboard/links`,
    contract:
      "The link is live and durable — share it anywhere. It carries the ask as a sentence only: whoever opens it faces an explicit Connect & build step, Pantessa's deterministic guarded builders rebuild the action from scratch, and the visitor's own wallet is the only signer. This call returned no transaction material.",
    nextSteps: [
      "Share the linkUrl — chat, site button, bio, anywhere.",
      "Your operator watches opens → connects → builds → signs (and conversion earnings) on the funnelUrl dashboard.",
      "Revoke anytime from the same dashboard; history and earnings stay.",
    ],
  };
}
