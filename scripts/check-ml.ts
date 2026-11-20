import assert from "node:assert/strict";
import { syntheticSeries } from "../lib/backtest";
import { pythonML } from "../lib/python-ml";
import { fitStochastic } from "../lib/stochastic";

const bars = syntheticSeries(17, 600);
const config = { features: ["midpoint", "spread", "last_move"] as const, horizon: 3, ridge: .01 };
const fit = (series: typeof bars) => fitStochastic(series, { ...config, features: [...config.features] }, 17);
const model = await fit(bars);
const changed = await fit(bars.map((bar, index) => index < 480 ? bar : { ...bar, bid: 1, ask: 2 }));
assert.equal(model.method, "sgd");
assert.equal(model.loss?.length, 30);
assert.ok(model.loss?.every(Number.isFinite));
assert.deepEqual(model.coefficients, changed.coefficients);
assert.deepEqual(model.validation, changed.validation);
assert.notEqual(model.test.mae, changed.test.mae);
assert.equal(await pythonML({ question: "historical observations", feedback: ["historical observations", "paper trade fills"] }), 0);
console.log("Verified Python SGD losses, chronological isolation, and TF-IDF feedback retrieval.");
