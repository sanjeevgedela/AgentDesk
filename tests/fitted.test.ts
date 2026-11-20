import assert from "node:assert/strict";
import test from "node:test";
import { fitForecast, type FitConfig } from "../lib/fitted";
import { syntheticSeries } from "../lib/backtest";
import { advance, currentSnapshot, latest, newDesk, saveVersion } from "../lib/engine";
import { fitAgent } from "../lib/training";
import { answer } from "../lib/supervisor";
import { recordRun } from "../lib/runner";

const config: FitConfig = { features: ["midpoint", "spread", "last_move"], horizon: 2, ridge: .1 };
test("final test values cannot change fitted coefficients or validation scores", () => {
  const bars = syntheticSeries(17, 150);
  const original = fitForecast(bars, config, 1);
  const changed = fitForecast(bars.map((bar, index) => index >= 120 ? { ...bar, bid: 1, ask: 2 } : bar), config, 1);
  assert.deepEqual(changed.coefficients, original.coefficients);
  assert.deepEqual(changed.validation, original.validation);
  assert.ok(original.split.validationLabelThrough < original.split.testFrom);
  assert.ok(original.split.trainingLabelThrough < original.split.validationFrom);
  assert.throws(() => fitForecast(bars.slice(0, 119), config, 1), /Found 119/);
});

test("saved fit survives reload and the selected version changes numerical inference", async () => {
  const desk = newDesk();
  const agent = desk.agents[0];
  advance(desk);
  const quote = currentSnapshot(desk)!;
  const first = await fitAgent(agent, quote.symbol, true, config);
  const second = await fitAgent(agent, quote.symbol, true, { ...config, horizon: 4 });
  const reloaded: typeof desk = JSON.parse(JSON.stringify(desk));
  const restored = reloaded.agents[0];
  assert.equal(restored.fittedModels?.[0].datasetHash, first.datasetHash);
  saveVersion(restored, { ...latest(restored), modelId: first.id });
  const runA = recordRun(reloaded, restored, quote, { action: "hold", reason: "Fixture" }, "strategy_rule");
  saveVersion(restored, { ...latest(restored), modelId: second.id });
  const runB = recordRun(reloaded, restored, quote, { action: "hold", reason: "Fixture" }, "strategy_rule");
  assert.equal(runA.forecast?.modelId, first.id);
  assert.equal(runB.forecast?.modelId, second.id);
  assert.notEqual(runA.forecast?.change, runB.forecast?.change);
  const response = answer(reloaded, "What did Trend Scout do?");
  assert.ok(response.includes(second.id));
  assert.ok(response.includes(second.datasetHash));
  assert.ok(response.includes(runB.id) && response.includes(quote.at));
});

test("fitted replay records real strategy decisions and a matched baseline", async () => {
  const { forecastProposal } = await import("../lib/runner");
  const { answerTraining } = await import("../lib/training-answers");
  const desk = newDesk();
  const symbol = currentSnapshot(desk)!.symbol;
  assert.equal(forecastProposal(latest(desk.agents[0]), 6, 1).action, "buy");
  assert.equal(forecastProposal(latest(desk.agents[1]), 6, 1).action, "sell");
  assert.equal(forecastProposal(latest(desk.agents[2]), 6, 1).resource, "spread-review");
  for (const agent of desk.agents) {
    const model = await fitAgent(agent, symbol, true, config);
    const replay = model.backtest!;
    assert.ok(replay.rows?.length);
    assert.equal(replay.rows.filter(row => row.fill).length, replay.trades);
    assert.equal(replay.rows.reduce((sum, row) => sum + (row.fill?.fee ?? 0), 0), replay.fees);
    assert.equal(replay.rows.at(-1)!.equity, replay.equity.at(-1));
    assert.equal(replay.rows[0].at, model.artifact.split.testFrom);
    assert.equal(replay.baseline?.equity.length, replay.rows.length);
    const reply = await answerTraining(agent, model.id, "What was the dataset and how did the baseline perform?");
    assert.ok(reply.includes(model.datasetHash));
    assert.match(reply, /SYNTHETIC/);
    assert.match(reply, /same strategy without the forecast/);
  }
  assert.match(await answerTraining(newDesk().agents[0], undefined, "How did it do?"), /No saved fitted model/);
});
