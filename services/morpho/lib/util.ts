// Small shared plumbing: the service-wide result envelope, the MCP response
// size budget, and human↔atom amount conversion. Decimals are ALWAYS read
// per asset (USDC is 6, WBTC is 8, WETH is 18 — never assume).

export interface MorphoResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export const ok = (data: unknown): MorphoResult => ({ ok: true, status: 200, data });
export const fail = (status: number, message: string): MorphoResult => ({ ok: false, status, data: message });

/** MCP responses get stuffed into a model context — keep them bounded. */
export const MAX_RESPONSE_CHARS = 24_000;

export function clip(data: unknown): unknown {
  const text = JSON.stringify(data);
  if (text.length <= MAX_RESPONSE_CHARS) return data;
  return {
    note: `Response truncated to ${MAX_RESPONSE_CHARS} chars (was ${text.length}). Ask a narrower question for full detail.`,
    preview: text.slice(0, MAX_RESPONSE_CHARS),
  };
}

export const isEvmAddress = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(s);

/** "1.5" + 6 decimals → 1500000n. Null on malformed/negative/zero input. */
export function humanToAtoms(amount: string, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(amount)) return null;
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) return null; // sub-atom precision would silently truncate
  const atoms = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return atoms > 0n ? atoms : null;
}

/** Atoms → human decimal string, trailing zeros trimmed ("1.5", not "1.500000"). */
export function formatAtoms(atoms: bigint, decimals: number): string {
  const negative = atoms < 0n;
  const abs = negative ? -atoms : atoms;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
