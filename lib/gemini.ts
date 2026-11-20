import { z } from "zod";
import type { Snapshot } from "./engine";
const price = z.string().regex(/^(?:0(?:\.\d{1,2})?|1(?:\.0{1,2})?)$/).transform(x => Math.round(Number(x) * 100));
const contract = z.object({
  instrumentSymbol: z.string().min(1), marketState: z.literal("open"), label: z.string(),
  prices: z.object({ bestBid: price, bestAsk: price }),
});
const eventSchema = z.object({ title: z.string(), ticker: z.string(), contracts: z.array(z.unknown()) });

export async function geminiSnapshots(preferredEvent?: string): Promise<Snapshot[]> {
  const endpoint = "https://api.gemini.com/v1/prediction-markets/events";
  const res = await fetch(endpoint + "?status=active&limit=25", { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Gemini returned HTTP ${res.status}. Retry or choose Replay.`);
  const { data } = z.object({ data: z.array(eventSchema) }).parse(await res.json());
  const tracked = [...new Set([preferredEvent ?? "", ...(process.env.GEMINI_EVENT_TICKERS ?? "").split(",")]
    .map(ticker => ticker.trim()).filter(ticker => /^[\w-]{1,120}$/.test(ticker)))].slice(0, 10);
  const extras = await Promise.allSettled(tracked.map(async ticker => {
    const response = await fetch(endpoint + "/" + encodeURIComponent(ticker), { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Tracked event unavailable.");
    return eventSchema.parse(await response.json());
  }));
  const events = [...new Map([...extras.flatMap(extra => extra.status === "fulfilled" ? [extra.value] : []), ...data]
    .map(event => [event.ticker, event])).values()];
  const at = new Date().toISOString();
  const snapshots = events.flatMap(event => event.contracts.flatMap(raw => {
    const parsed = contract.safeParse(raw);
    if (!parsed.success) return [];
    const { instrumentSymbol, label, prices: { bestBid: bid, bestAsk: ask } } = parsed.data;
    if (bid <= 0 || ask >= 100 || bid > ask) return [];
    return [{ id: crypto.randomUUID(), symbol: instrumentSymbol, mode: "live" as const,
      bid, ask, title: event.title + " · " + label, at, source: endpoint + "/" + encodeURIComponent(event.ticker) }];
  }));
  if (!snapshots.length) throw new Error("Gemini returned no open contracts with usable quotes.");
  return snapshots.slice(0, 25);
}

export async function geminiResolutions() {
  const endpoint = "https://api.gemini.com/v1/prediction-markets/events?status=settled&limit=50";
  const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("Settled Gemini events are unavailable.");
  const result = z.object({ data: z.array(z.object({ contracts: z.array(z.unknown()) })) }).parse(await response.json());
  const settled = z.object({ instrumentSymbol: z.string().min(1), status: z.literal("settled"),
    resolutionSide: z.enum(["yes", "no"]), resolvedAt: z.iso.datetime() });
  return result.data.flatMap(event => event.contracts.flatMap(raw => {
    const record = settled.safeParse(raw);
    return record.success && Date.parse(record.data.resolvedAt) <= Date.now() ? [record.data] : [];
  }));
}
