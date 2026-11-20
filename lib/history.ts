import postgres from "postgres";
import { sha256 } from "./canonical";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { Snapshot } from "./engine";

export const quoteSymbol = z.string().regex(/^[\w-]{1,120}$/);
const quoteSchema = z.object({
  symbol: quoteSymbol, observed_at: z.iso.datetime(), bid: z.number().int().min(0).max(100),
  ask: z.number().int().min(0).max(100), title: z.string().max(400), source: z.string().max(500),
}).refine(row => row.bid <= row.ask);
type Quote = z.infer<typeof quoteSchema>;
const retention = 5000;
// An owner transaction may load history while holding a workspace connection.
export const historySql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 2, prepare: false }) : undefined;
const folder = join(process.cwd(), ".agentdesk");
let queue = Promise.resolve<unknown>(undefined);

function localFile(symbol: string) { return join(folder, `quotes-${symbol}.jsonl`); }
async function readLocal(symbol: string) {
  try {
    const content = await readFile(localFile(symbol), "utf8");
    return content.trim().split("\n").filter(Boolean).map(line => quoteSchema.parse(JSON.parse(line)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
export async function appendQuotes(snapshots: Snapshot[]) {
  const rows = snapshots.filter(s => s.mode === "live").map(s => quoteSchema.parse({
    symbol: s.symbol, observed_at: s.at, bid: s.bid, ask: s.ask, title: s.title, source: s.source,
  }));
  const symbols = [...new Set(rows.map(row => row.symbol))].sort();
  if (historySql) return historySql.begin(async tx => {
    let inserted = 0;
    for (const symbol of symbols) {
      await tx`select pg_advisory_xact_lock(hashtext(${symbol}))`;
      for (const row of rows.filter(r => r.symbol === symbol)) {
        inserted += (await tx`insert into agentdesk_quotes ${tx(row)} on conflict do nothing`).count;
      }
      await tx`delete from agentdesk_quotes where symbol = ${symbol} and observed_at in
        (select observed_at from agentdesk_quotes where symbol = ${symbol} order by observed_at desc offset ${retention})`;
    }
    return inserted;
  });
  const write = queue.then(async () => {
    if (process.env.VERCEL) throw new Error("Configure DATABASE_URL for hosted history.");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    let inserted = 0;
    for (const symbol of symbols) {
      const history = new Map((await readLocal(symbol)).map(row => [row.observed_at, row]));
      for (const row of rows.filter(r => r.symbol === symbol)) {
        if (history.has(row.observed_at)) continue;
        history.set(row.observed_at, row);
        inserted++;
      }
      const result = [...history.values()].sort((a, b) => a.observed_at.localeCompare(b.observed_at)).slice(-retention);
      const file = localFile(symbol);
      await writeFile(file + ".tmp", result.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
      await rename(file + ".tmp", file);
    }
    return inserted;
  });
  queue = write.catch(() => undefined);
  return write;
}
export async function loadBars(input: string, options: { limit?: number; since?: string } = {}) {
  const symbol = quoteSymbol.parse(input);
  const { limit, since } = z.object({ limit: z.number().int().min(1).max(retention).default(retention),
    since: z.iso.datetime().optional() }).parse(options);
  const rows = historySql ? (await historySql`select symbol, observed_at, bid, ask, title, source from agentdesk_quotes
      where symbol = ${symbol} and observed_at >= ${since ?? "1970-01-01T00:00:00.000Z"}
      order by observed_at desc limit ${limit}`).reverse().map(row => quoteSchema.parse({
      ...row, observed_at: new Date(row.observed_at).toISOString(),
    })) : (await readLocal(symbol)).filter(row => !since || row.observed_at >= since).slice(-limit);
  const hash = sha256(rows);
  return { bars: rows.map(row => ({ bid: row.bid, ask: row.ask, at: row.observed_at })), times: rows.map(row => row.observed_at), hash };
}
