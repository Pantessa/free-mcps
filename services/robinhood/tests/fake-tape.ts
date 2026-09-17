// A fake of the price feeds behind the tape check (lib/tape.ts): Robinhood's
// batch historicals, Yahoo's chart meta, and Coinbase's ETH-USD stats,
// answered from a table. Install with fakeTape(...); reset with
// setTapeFetchForTests(null). Returns the list of URLs it was asked for.

import { ROBINHOOD_BATCH_MAX, setTapeFetchForTests } from "@/lib/tape";

export interface FakeTapeState {
  /** Robinhood 24/7 last close per tape ticker (AAPL, USO, …). */
  robinhood?: Record<string, number>;
  /** Yahoo regularMarketPrice per ticker — the fallback. */
  yahoo?: Record<string, number>;
  /** Coinbase ETH-USD last. */
  eth?: number;
  /** The Robinhood batch call itself fails with this HTTP status. */
  robinhoodStatus?: number;
  /** Print time of every quote, unix ms (default: five minutes ago). */
  asOf?: number;
}

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

export function fakeTape(state: FakeTapeState): string[] {
  const urls: string[] = [];
  setTapeFetchForTests(async (url) => {
    urls.push(url);
    const asOf = state.asOf ?? Date.now() - 5 * 60_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    if (url.startsWith("https://api.robinhood.com/marketdata/historicals/")) {
      if (state.robinhoodStatus) return json(state.robinhoodStatus, { detail: "unavailable" });
      const symbols = (new URL(url).searchParams.get("symbols") ?? "").split(",");
      if (symbols.length > ROBINHOOD_BATCH_MAX) return json(400, { symbols: ["Too many symbols."] });
      return json(200, {
        results: symbols.map((s) => {
          const px = state.robinhood?.[s];
          // Robinhood answers an unknown ticker with an empty-symbol row.
          if (px === undefined) return { symbol: "", historicals: [] };
          return {
            symbol: s,
            previous_close_price: String(px),
            historicals: [
              { begins_at: iso(asOf - 300_000), close_price: String(px * 0.99), interpolated: false },
              { begins_at: iso(asOf), close_price: String(px), interpolated: false },
              // A later interpolated (no-trade) bar must never be read as the price.
              { begins_at: iso(asOf + 300_000), close_price: String(px * 2), interpolated: true },
            ],
          };
        }),
      });
    }
    if (url.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/")) {
      const symbol = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
      const px = state.yahoo?.[symbol];
      if (px === undefined) return json(404, { chart: { result: null, error: { code: "Not Found" } } });
      return json(200, { chart: { result: [{ meta: { regularMarketPrice: px, regularMarketTime: Math.floor(asOf / 1000) } }] } });
    }
    if (url === "https://api.exchange.coinbase.com/products/ETH-USD/stats") {
      return state.eth === undefined ? json(503, { message: "unavailable" }) : json(200, { last: String(state.eth) });
    }
    throw new Error(`fake-tape: unexpected fetch ${url}`);
  });
  return urls;
}
