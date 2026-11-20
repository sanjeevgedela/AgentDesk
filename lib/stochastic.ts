import { forecastArtifact, prepareForecast, type FitConfig } from "./fitted";
import { pythonML } from "./python-ml";
import type { Bar } from "./backtest";

export async function fitStochastic(bars: Bar[], config: FitConfig, seed: number) {
  const split = prepareForecast(bars, config);
  const fit = await pythonML<{ coefficients: number[]; intercept: number; loss: number[] }>({
    x: split.train.map(row => row.x.map((value, i) => (value - split.mean[i]) / split.scale[i])),
    y: split.train.map(row => row.y), seed, alpha: config.ridge,
  });
  return forecastArtifact(bars, config, seed, split, fit.coefficients, fit.intercept, fit.loss);
}
