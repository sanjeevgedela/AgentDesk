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
