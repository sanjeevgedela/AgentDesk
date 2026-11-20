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
