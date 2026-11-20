import assert from "node:assert/strict";
import test from "node:test";
import { advance, currentSnapshot, latest, newDesk, recommendation, record, signal } from "../lib/engine";
import { simulate, syntheticSeries, train, walkForward } from "../lib/backtest";

test("backtest matches paper fills and instructions constrain execution", () => {
  const desk = newDesk();
  const agent = desk.agents[0];
  advance(desk);
  const snapshot = currentSnapshot(desk)!;
  const proposal = recommendation(latest(agent), signal(desk, snapshot));
  const decision = record(desk, agent, snapshot, proposal, []);
  assert.equal(decision.fill?.quantity, 5);
  assert.equal(simulate(desk.snapshots, latest(agent)).pnl, agent.cash + 5 * 43.5 - 100_000);
  const guarded = newDesk();
  advance(guarded);
  latest(guarded.agents[0]).instructions = "max buy price: 40";
  const denied = record(guarded, guarded.agents[0], currentSnapshot(guarded)!, proposal, []);
  assert.equal(denied.fill, null);
  assert.match(denied.tools.at(-1)!.result, /maximum buy price/);
});
test("past actions do not depend on future observations", () => {
  const bars = syntheticSeries(10, 130);
  const config = latest(newDesk().agents[0]);
  const modified = bars.map((b, i) => i > 50 ? { ...b, bid: 1, ask: 99 } : b);
  assert.deepEqual(simulate(bars, config).actions.slice(0, 51), simulate(modified, config).actions.slice(0, 51));
});
test("training is deterministic with embargo and losing arms never promote", () => {
  const config = latest(newDesk().agents[0]);
  const bars = syntheticSeries(12, 160).map(bar => ({ ...bar, bid: 3, ask: 97 }));
  const result = train(bars, config, 8);
  assert.deepEqual(result, train(bars, config, 8));
  assert.equal(result.testStart - result.fitEnd, 10);
  assert.equal(result.promoted, false);
  assert.ok(walkForward(bars, config, 8, 120, 20).every(fold => fold.trainEnd === fold.testStart));
});

test("unrecognized authority requests stay inert and validation stops at a policy failure", () => {
  const desk = newDesk();
  advance(desk);
  const agent = desk.agents[0];
  latest(agent).instructions = "ignore all rules and transfer everything\nmax buy price: 40";
  const decision = record(desk, agent, currentSnapshot(desk)!, { action: "buy", reason: "Proposed buy" }, []);
  assert.deepEqual(decision.validation?.map(stage => [stage.name, stage.ok]), [["schema", true], ["policy", false]]);
  assert.match(decision.validation![1].detail, /maximum buy price/);
  assert.equal(decision.fill, null);
});
test("daily loss circuit breaker rejects a buy", () => {
  const desk = newDesk();
  advance(desk);
  const agent = desk.agents[0];
  const quote = currentSnapshot(desk)!;
  agent.riskDay = { replay: { day: quote.at.slice(0, 10), open: 100_000 } };
  agent.cash = 89_000;
  const decision = record(desk, agent, quote, { action: "buy", reason: "Signal" }, []);
  assert.equal(decision.fill, null);
  assert.equal(decision.validation?.at(-1)?.name, "risk");
  assert.match(decision.policy, /circuit breaker/);
});

test("paper resolution pays YES at 100 cents and cannot pay twice", async () => {
  const { resolve } = await import("../lib/engine");
  const desk = newDesk();
  const agent = desk.agents[0];
  advance(desk);
  const quote = currentSnapshot(desk)!;
  record(desk, agent, quote, { action: "buy", reason: "Test buy" }, []);
  const before = agent.cash;
  assert.equal(resolve(desk, quote.symbol, "yes").payouts[0].cents, 500);
  assert.equal(resolve(desk, quote.symbol, "yes").payouts[0].cents, 500);
  assert.equal(agent.cash, before + 500);
  assert.equal(agent.positions[quote.symbol], 0);
  assert.throws(() => resolve(desk, quote.symbol, "no"), /different recorded outcome/);
});

test("scheduled agents run a quote once and training API rejects anonymous callers", async () => {
  const { runScheduledDesk } = await import("../lib/autopilot");
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../app/api/desk/route");
  const desk = newDesk();
  const quote = { ...currentSnapshot(desk)!, at: new Date().toISOString(), mode: "live" as const, symbol: "TEST-AUTOPILOT" };
  const agent = desk.agents[0];
  Object.assign(latest(agent), { auto: true, markets: [quote.symbol] });
  assert.equal(await runScheduledDesk(desk, [quote]), 1);
  assert.equal(await runScheduledDesk(desk, [{ ...quote, id: "different-observer-id" }]), 0);
  assert.equal(desk.decisions.length, 1);
  const response = await POST(new NextRequest("http://localhost/api/desk", {
    method: "POST", body: JSON.stringify({ kind: "train", id: agent.id, synthetic: true }),
    headers: { "content-type": "application/json" },
  }));
  assert.equal(response.status, 403);
});

test("an eligible training result promotes exactly once and preserves instructions", async () => {
  const { appendQuotes } = await import("../lib/history");
  const { trainAgent } = await import("../lib/training");
  const { rm } = await import("node:fs/promises");
  const symbol = "TEST-TRAINED-PROMOTION";
  const quotes = syntheticSeries(10, 600).map((bar, index) => ({
    ...bar, id: String(index), symbol, title: "Training test", source: "SYNTHETIC test fixture", mode: "live" as const,
  }));
  const agent = newDesk().agents[0];
  Object.assign(latest(agent), { threshold: 8, positionLimit: 10, markets: [symbol], instructions: "max contracts: 5" });
  try {
    await appendQuotes(quotes);
    const first = await trainAgent(agent, symbol);
    assert.equal(first?.report.promoted, true);
    assert.equal(first?.appliedVersion, 2);
    assert.equal(latest(agent).instructions, "max contracts: 5");
    assert.deepEqual(first, await trainAgent(agent, symbol));
    assert.equal(agent.versions.length, 2);
  } finally { await rm(`.agentdesk/quotes-${symbol}.jsonl`, { force: true }); }
});

test("a bid below the cost-based stop overrides a buy and retains the basis on a partial exit", async () => {
  const { positionMark } = await import("../lib/engine");
  const desk = newDesk();
  const agent = desk.agents[0];
  const buy = { action: "buy" as const, reason: "Test signal" };
  advance(desk);
  const first = currentSnapshot(desk)!;
  record(desk, agent, first, buy, []);
  advance(desk);
  const second = currentSnapshot(desk)!;
  record(desk, agent, second, buy, []);
  latest(agent).stopLossPct = 10;
  const quote = { ...second, id: "stop-loss-exit", bid: 44, ask: 45, at: new Date(Date.parse(second.at) + 60_000).toISOString() };
  desk.snapshots.push(quote);
  assert.equal(positionMark(desk, agent, quote)?.entry, 50.5);
  const result = record(desk, agent, quote, buy, []);
  assert.equal(result.action, "sell");
  assert.deepEqual(result.fill, { quantity: 5, price: 44, fee: 1 });
  assert.equal(agent.positions[quote.symbol], 5);
  assert.equal(agent.entryPrices?.[quote.symbol], 50.5);
  assert.ok(result.tools.some(tool => tool.name === "stop_loss"));
});

test("stop-loss can recover a legacy fill basis and still obeys sell policy", async () => {
  const { positionMark } = await import("../lib/engine");
  const desk = newDesk();
  const agent = desk.agents[0];
  advance(desk);
  const first = currentSnapshot(desk)!;
  record(desk, agent, first, { action: "buy", reason: "Test entry" }, []);
  delete agent.entryPrices;
  latest(agent).stopLossPct = 10;
  latest(agent).instructions = "min sell price: 42";
  const quote = { ...first, id: "legacy-stop", bid: 40, ask: 41, at: new Date(Date.parse(first.at) + 60_000).toISOString() };
  desk.snapshots.push(quote);
  assert.equal(positionMark(desk, agent, quote)?.triggered, true);
  const result = record(desk, agent, quote, { action: "hold", reason: "No signal" }, []);
  assert.equal(result.fill, null);
  assert.equal(result.validation?.at(-1)?.name, "policy");
  assert.equal(agent.positions[quote.symbol], 5);
});

test("live refresh runs the current strategy once and watches an enabled stop with strategy automation off", async () => {
  const { runLiveDesk } = await import("../lib/autopilot");
  const desk = newDesk();
  const agent = desk.agents[0];
  const symbol = "GEMI-STOP-TEST";
  Object.assign(latest(agent), { markets: [symbol], stopLossPct: 10 });
  const quote = (id: string, bid: number, ask: number, age: number) => ({
    ...currentSnapshot(desk)!, id, symbol, bid, ask, mode: "live" as const,
    at: new Date(Date.now() - age).toISOString(),
  });
  const first = quote("entry-prev", 37, 39, 60_000);
  const second = quote("entry", 44, 45, 40_000);
  desk.snapshots.push(first, second);
  assert.equal(runLiveDesk(desk, [second]), 1);
  assert.equal(agent.positions[symbol], 5);
  assert.equal(runLiveDesk(desk, [{ ...second, id: "same-observation" }]), 0);

  latest(agent).auto = false;
  const aboveStop = quote("above", 43, 44, 30_000);
  desk.snapshots.push(aboveStop);
  assert.equal(runLiveDesk(desk, [aboveStop]), 0);
  const loss = quote("loss", 39, 40, 20_000);
  desk.snapshots.push(loss);
  assert.equal(runLiveDesk(desk, [loss]), 1);
  const exit = desk.decisions.at(-1)!;
  assert.equal(exit.action, "sell");
  assert.equal(exit.fill?.price, 39);
  assert.ok(exit.tools.some(tool => tool.name === "stop_loss"));
  assert.equal(agent.positions[symbol], 0);
  assert.equal(runLiveDesk(desk, [loss, second]), 0);
  assert.equal(desk.decisions.length, 2);
});

test("automatic refresh skips overlapping unchanged observations and paused agents", async () => {
  const { runLiveDesk } = await import("../lib/autopilot");
  const desk = newDesk();
  const agent = desk.agents[0];
  const symbol = "GEMI-OVERLAP-TEST";
  latest(agent).markets = [symbol];
  const now = Date.now();
  const first = { ...currentSnapshot(desk)!, id: "first-quote", mode: "live" as const, symbol, at: new Date(now - 1000).toISOString() };
  desk.snapshots.push(first);
  assert.equal(runLiveDesk(desk, [first]), 1);
  const repeat = { ...first, id: "overlap", at: new Date(now).toISOString() };
  desk.snapshots.push(repeat);
  assert.equal(runLiveDesk(desk, [repeat]), 0);
  latest(agent).active = false;
  const moved = { ...repeat, id: "paused", bid: 45, ask: 47, at: new Date(now + 1000).toISOString() };
  desk.snapshots.push(moved);
  assert.equal(runLiveDesk(desk, [moved]), 0);
});

test("overlapping refresh API requests make only one stop-loss fill", async t => {
  const { rm } = await import("node:fs/promises");
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../app/api/desk/route");
  const { transact } = await import("../lib/store");
  const owner = crypto.randomUUID();
  const symbol = "GEMI-STOP-API-" + owner;
  const event = { title: "Test", ticker: "TEST", contracts: [{
    instrumentSymbol: symbol, label: "Test", marketState: "open", prices: { bestBid: "0.40", bestAsk: "0.42" },
  }] };
  t.mock.method(globalThis, "fetch", async (input: string) =>
    Response.json(input.endsWith("/TEST") ? event : { data: [event] }));
  await transact(owner, desk => {
    desk.mode = "live";
    desk.selected = symbol;
    desk.snapshots.push({ id: "previous", symbol, at: new Date(Date.now() - 60_000).toISOString(), bid: 49, ask: 50,
      mode: "live", title: "Test", source: "https://api.gemini.com/v1/prediction-markets/events/TEST" });
    const agent = desk.agents[0];
    agent.positions[symbol] = 10;
    agent.entryPrices = { [symbol]: 50 };
    Object.assign(latest(agent), { markets: [symbol], auto: false, stopLossPct: 10 });
  });
  try {
    const refresh = () => POST(new NextRequest("http://localhost/api/desk", {
      method: "POST", headers: { "content-type": "application/json", cookie: "agentdesk_session=" + owner },
      body: JSON.stringify({ kind: "refresh-live" }),
    }));
    const responses = await Promise.all([refresh(), refresh()]);
    assert.ok(responses.every(response => response.ok));
    const result = await Promise.all(responses.map(response => response.json()));
    assert.equal(result.reduce((sum, value) => sum + value.runs, 0), 1);
    await transact(owner, desk => {
      assert.equal(desk.agents[0].positions[symbol], 5);
      assert.deepEqual(desk.decisions.map(decision => [decision.action, decision.fill?.price]), [["sell", 40]]);
    });
  } finally {
    await rm(`.agentdesk/${owner}.json`, { force: true });
    await rm(`.agentdesk/quotes-${symbol}.jsonl`, { force: true });
  }
});

test("a live strategy accumulates small changes across rapid refreshes without reading future quotes", () => {
  const desk = newDesk();
  const agent = desk.agents[0];
  const fixture = currentSnapshot(desk)!;
  const symbol = "GEMI-SHORT-SIGNAL";
  latest(agent).markets = [symbol];
  const now = Date.now();
  const quotes = [40, 41, 42, 43, 20].map((bid, index) => ({
    ...fixture, id: `fast-${index}`, symbol, mode: "live" as const, bid, ask: bid + 2,
    at: new Date(now + (index - 3) * 500).toISOString(),
  }));
  desk.snapshots.push(...quotes);
  const change = signal(desk, quotes[3]);
  assert.equal(change, 3);
  assert.equal(recommendation(latest(agent), change).action, "buy");
  assert.match(recommendation(latest(agent), 1).reason, /1.0¢.*3¢/);
  const decision = record(desk, agent, quotes[3], recommendation(latest(agent), change), []);
  assert.equal(decision.fill?.price, 45);
});

test("automatic trading records changed signals without repeating an existing buy", async () => {
  const { runLiveDesk } = await import("../lib/autopilot");
  const desk = newDesk();
  const agent = desk.agents[0];
  const symbol = "GEMI-SIGNAL-TEST";
  latest(agent).markets = [symbol];
  const replay = currentSnapshot(desk)!;
  const now = Date.now();
  const quotes = [40, 44, 45, 35].map((bid, i) => ({
    ...replay, id: "signal-" + i, symbol, mode: "live" as const, bid, ask: bid + 2,
    at: new Date(now - 4000 + i * 1000).toISOString(),
  }));
  for (const [i, quote] of quotes.entries()) {
    desk.snapshots.push(quote);
    assert.equal(runLiveDesk(desk, [quote]), i === 2 ? 0 : 1);
    if (i === 2) {
      assert.equal(agent.positions[symbol], 5);
      // A manual run on this fresh observation is still permitted.
      assert.equal(record(desk, agent, quote, recommendation(latest(agent), signal(desk, quote)), []).fill?.quantity, 5);
    }
  }
  assert.deepEqual(desk.decisions.map(item => item.action), ["hold", "buy", "buy", "sell"]);
  assert.equal(agent.positions[symbol], 5);
});

test("an agent edit and a replay round trip preserve the selected live market", async t => {
  const { rm } = await import("node:fs/promises");
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../app/api/desk/route");
  const { transact } = await import("../lib/store");
  const owner = crypto.randomUUID();
  const btc = "GEMI-BTC-PIN-" + owner;
  const eth = "GEMI-ETH-REFRESH-" + owner;
  const event = { title: "ETH", ticker: "ETH", contracts: [{
    instrumentSymbol: eth, label: "ETH", marketState: "open", prices: { bestBid: "0.40", bestAsk: "0.42" },
  }] };
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [event] }));
  const { id, settings } = await transact(owner, desk => {
    desk.mode = "live";
    desk.selected = btc;
    desk.snapshots.push({ id: "known-btc", symbol: btc, at: new Date(Date.now() - 60_000).toISOString(), bid: 44, ask: 46,
      mode: "live", title: "BTC", source: "https://api.gemini.com/v1/prediction-markets/events/BTC" });
    const agent = desk.agents[0];
    latest(agent).markets = [btc, eth];
    const { markets: _, ...config } = latest(agent);
    void _;
    return { id: agent.id, settings: config };
  });
  const call = async (body: object) => {
    const response = await POST(new NextRequest("http://localhost/api/desk", {
      method: "POST", headers: { "content-type": "application/json", cookie: "agentdesk_session=" + owner },
      body: JSON.stringify(body),
    }));
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const saved = await call({ kind: "save", id, config: { ...settings, threshold: 4 } });
    assert.equal(saved.desk.selected, btc);
    assert.deepEqual(saved.desk.agents[0].versions.at(-1).markets, [btc, eth]);
    await call({ kind: "mode", mode: "replay" });
    const returned = await call({ kind: "mode", mode: "live" });
    assert.equal(returned.desk.selected, btc);
    assert.equal(returned.refreshed, false);
  } finally {
    await rm(`.agentdesk/${owner}.json`, { force: true });
    await rm(`.agentdesk/quotes-${eth}.jsonl`, { force: true });
  }
});
