import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as tick } from "../app/api/tick/route";
import { appendQuotes, loadBars } from "../lib/history";
import type { Snapshot } from "../lib/engine";

test("live history deduplicates, retains 5000 observations and hashes stable rows", async () => {
  const symbol = "TEST-" + crypto.randomUUID();
  const quotes: Snapshot[] = Array.from({ length: 5002 }, (_, i) => ({
    id: String(i), symbol, bid: 40, ask: 42, at: new Date(1700000000000 + i * 60_000).toISOString(),
    title: "History test", source: "test fixture", mode: "live",
  }));
  try {
    assert.equal(await appendQuotes([...quotes, quotes[5001]]), 5002);
    assert.equal(await appendQuotes([quotes[5001]]), 0);
    const result = await loadBars(symbol);
    assert.equal(result.bars.length, 5000);
    assert.equal(result.times[0], quotes[2].at);
    assert.equal(result.hash, (await loadBars(symbol)).hash);
  } finally { await rm(`.agentdesk/quotes-${symbol}.jsonl`, { force: true }); }
});
test("quote collection requires authorization before any fetch", async t => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network call"); });
  const response = await tick(new NextRequest("http://localhost/api/tick"));
  assert.equal(response.status, 403);
  assert.equal(network.mock.callCount(), 0);
});

test("Gemini backfill keeps genuine chronological points and caches duplicate fetches", async t => {
  const { backfill } = await import("../lib/backfill");
  const symbol = "BACKFILL-" + crypto.randomUUID();
  const first = "2026-01-01T00:00:00.000Z";
  const last = "2026-01-02T00:00:00.000Z";
  const network = t.mock.method(globalThis, "fetch", async () => Response.json({ contracts: [{
    instrumentSymbol: symbol, priceHistory: [{ timestamp: last, price: "0.55" }, { timestamp: first, price: "0.45" }, { timestamp: last, price: "0.55" }],
  }] }));
  try {
    const results = await backfill(symbol, "EVENT");
    assert.deepEqual(results.points, [{ at: first, cents: 45 }, { at: last, cents: 55 }]);
    assert.deepEqual(await backfill(symbol, "EVENT"), results);
    assert.equal(network.mock.callCount(), 1);
    assert.equal((await loadBars(symbol)).bars.length, 0);
  } finally { await rm(`.agentdesk/history-${symbol}.json`, { force: true }); }
});
