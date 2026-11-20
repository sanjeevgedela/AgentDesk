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
