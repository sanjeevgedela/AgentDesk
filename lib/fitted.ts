import { z } from "zod";
import type { BacktestRow, Bar } from "./backtest";
import type { Config, Snapshot } from "./engine";

export const featureNames = ["midpoint", "spread", "last_move"] as const;
export const fitConfig = z.object({
  features: z.array(z.enum(featureNames)).min(1).max(3).refine(v => new Set(v).size === v.length),
  horizon: z.number().int().min(1).max(10),
  ridge: z.number().min(.001).max(100),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
}).refine(v => !v.from || !v.to || v.from <= v.to, "Choose a valid date range.");
export type FitConfig = z.infer<typeof fitConfig>;
const mid = (bar: Bar) => (bar.bid + bar.ask) / 2;

function features(bar: Bar, prev: Bar, keys: FitConfig["features"]) {
  const values = { midpoint: mid(bar), spread: bar.ask - bar.bid, last_move: mid(bar) - mid(prev) };
  return keys.map(key => values[key]);
}

export function fitForecast(bars: Bar[], config: FitConfig, seed: number) {
  if (bars.length < 120) throw new Error(`Model fitting needs 120 chronological quotes in the chosen range. Found ${bars.length}.`);
  if (bars.some((bar, index) => index > 0 && bar.at <= bars[index - 1].at)) throw new Error("Model fitting requires unique chronological quotes.");
  const valStart = Math.floor(bars.length * .6);
  const testStart = Math.floor(bars.length * .8);
  const examples = bars.flatMap((bar, index) => index > 0 && index + config.horizon < bars.length
    ? [{ index, x: features(bar, bars[index - 1], config.features), y: mid(bars[index + config.horizon]) - mid(bar) }] : []);
  const train = examples.filter(row => row.index + config.horizon < valStart);
  const validation = examples.filter(row => row.index > valStart && row.index + config.horizon < testStart);
  const test = examples.filter(row => row.index > testStart);
  if (!train.length || !validation.length || !test.length) throw new Error("Horizon leaves no usable examples in a chronological split.");
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const mean = config.features.map((_, i) => average(train.map(row => row.x[i])));
  const scale = mean.map((center, i) => Math.sqrt(average(train.map(row => (row.x[i] - center) ** 2))) || 1);
  const intercept = average(train.map(row => row.y));
  const normalized = train.map(row => ({ z: row.x.map((value, i) => (value - mean[i]) / scale[i]), y: row.y }));
  const coefficients = mean.map(() => 0);
  // Ridge least squares by deterministic coordinate descent on standardized training rows.
  for (let epoch = 0; epoch < 150; epoch++) {
    for (let step = 0; step < coefficients.length; step++) {
      const i = (step + seed % coefficients.length) % coefficients.length;
      const numer = normalized.reduce((sum, row) => sum + row.z[i] * (row.y - intercept -
        coefficients.reduce((acc, coefficient, j) => acc + (i === j ? 0 : coefficient * row.z[j]), 0)), 0);
      const denom = normalized.reduce((sum, row) => sum + row.z[i] ** 2, 0) + config.ridge * train.length;
      coefficients[i] = numer / denom;
    }
  }
  const score = (rows: typeof train) => {
    const predictions = rows.map(row => intercept + row.x.reduce((sum, value, i) => sum + (value - mean[i]) / scale[i] * coefficients[i], 0));
    return {
      samples: rows.length,
      mae: average(rows.map((row, index) => Math.abs(row.y - predictions[index]))),
      zeroMoveMae: average(rows.map(row => Math.abs(row.y))),
      directionAccuracy: average(rows.map((row, index) => Number(Math.sign(row.y) === Math.sign(predictions[index])))),
    };
  };
  return { method: "ridge" as const, target: "future_midpoint_change_cents" as const, config, seed, mean, scale, coefficients, intercept,
    split: { validationFrom: bars[valStart].at, testFrom: bars[testStart].at, trainingLabelThrough: bars[valStart - 1].at,
      validationLabelThrough: bars[testStart - 1].at, trainSamples: train.length },
    validation: score(validation), test: score(test) };
}

export type Forecast = ReturnType<typeof fitForecast>;
export type FittedModel = {
  id: string; createdAt: string; symbol: string; synthetic: boolean; datasetHash: string;
  execution?: Pick<Config, "strategy" | "threshold" | "positionLimit" | "stopLossPct" | "instructions">;
  bars: Bar[]; artifact: Forecast; backtest?: { equity: number[]; drawdown: number[]; pnl: number; fees: number; trades: number; slippage?: number; rows?: BacktestRow[]; baseline?: { pnl: number; trades: number; equity: number[] } };
};

export function predict(artifact: Forecast, quote: Snapshot, previous: Snapshot) {
  const values = features(quote, previous, artifact.config.features);
  return artifact.intercept + values.reduce((sum, value, i) =>
    sum + (value - artifact.mean[i]) / artifact.scale[i] * artifact.coefficients[i], 0);
}
