import { z } from "zod";
import { transact } from "./store";

export type HistoryBackfill = { checkedAt: number; source: string; points: { at: string; cents: number }[]; status: "available" | "empty" | "unavailable" };
export async function backfill(symbol: string, event: string) {
  return transact("history-" + symbol, async desk => {
    const previous = desk.backfill;
    const now = Date.now();
    if (previous && now - previous.checkedAt < 300_000) return previous;
    const source = "https://api.gemini.com/v1/prediction-markets/events/" + encodeURIComponent(event);
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error("Gemini history unavailable");
      const schema = z.object({ contracts: z.array(z.object({
        instrumentSymbol: z.string(), priceHistory: z.array(z.unknown()).nullish(),
      })) });
      const parsed = schema.parse(await response.json());
      const contract = parsed.contracts.find(item => item.instrumentSymbol === symbol);
      const point = z.object({ timestamp: z.iso.datetime(), price: z.string().regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/) });
      const quotes = (contract?.priceHistory ?? []).flatMap(raw => {
        const parsed = point.safeParse(raw);
        return parsed.success && Date.parse(parsed.data.timestamp) <= now
          ? [{ at: parsed.data.timestamp, cents: Math.round(Number(parsed.data.price) * 100) }] : [];
      });
      const points = [...new Map([...(previous?.points ?? []), ...quotes].map(quote => [quote.at, quote])).values()]
        .sort((a, b) => a.at.localeCompare(b.at)).slice(-5000);
      return desk.backfill = { checkedAt: now, source, points, status: points.length ? "available" : "empty" };
    } catch {
      return desk.backfill = { checkedAt: now, source, points: previous?.points ?? [], status: "unavailable" };
    }
  });
}
