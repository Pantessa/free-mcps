// The handoff contract — pure and edge-safe. An agent plans; a human signs.
// This service NEVER returns transaction artifacts, calldata, typed data, or
// deposit addresses to the calling agent: it returns a pantessa.com/sign link
// that carries the ASK AS A SENTENCE. Pantessa's deterministic guarded
// builders rebuild the action from scratch on the other side of that link,
// and the user's own wallet is the only thing that can sign it. Nothing an
// agent can put in a link is executable by itself — that property is the
// product.

const ASK_MAX = 400;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

// PANTESSA_SITE_URL is the current name; YEETFUL_SITE_URL is honored as a
// back-compat fallback so existing deployments keep working through the
// rebrand. Default is the canonical origin.
export const SITE = (
  process.env.PANTESSA_SITE_URL ??
  process.env.YEETFUL_SITE_URL ??
  "https://www.pantessa.com"
).replace(/\/$/, "");

/** Untrusted-input hygiene, mirrored from the website's /sign page. */
export function cleanAsk(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ASK_MAX);
}

export interface Handoff {
  signUrl: string;
  ask: string;
  contract: string;
  nextSteps: string[];
}

/** Mint the /sign handoff link for an ask. `mcps` is an optional hint of
 *  free-fleet slugs to toggle on when the human lands. */
export function mintHandoff(rawAsk: string, opts: { agent?: string; mcps?: string[] } = {}): Handoff {
  const ask = cleanAsk(rawAsk);
  if (!ask) throw new Error("The ask is empty after sanitization — pass the action as a plain sentence.");
  const slugs = (opts.mcps ?? []).map((s) => s.trim()).filter((s) => SLUG_RE.test(s)).slice(0, 6);
  const agent = cleanAsk(opts.agent ?? "").slice(0, 40);
  const params = new URLSearchParams();
  params.set("ask", ask);
  if (slugs.length) params.set("mcps", slugs.join(","));
  if (agent) params.set("agent", agent);
  return {
    signUrl: `${SITE}/sign?${params.toString()}`,
    ask,
    contract:
      "Give this link to your human. Pantessa rebuilds the ask from scratch with deterministic guarded builders (no AI writes calldata), prices and receipt-stamps the result, and their own wallet is the only thing that can sign it. This service returned no transaction material — a link like this cannot execute anything by itself.",
    nextSteps: [
      "Show the human the ask you prepared and hand them the signUrl.",
      "They review, the guarded build happens on pantessa.com, and they sign with their own wallet — or close the tab and nothing happens.",
      "Every signed move lands as a receipt they can share.",
    ],
  };
}
