import { fitStochastic } from "./stochastic";
import { fitForecast, predict, type FitConfig, type FittedModel } from "./fitted";
import { sha256 } from "./canonical";
import { datasetHash, simulate, syntheticSeries, train, type TrainReport } from "./backtest";
import { latest, saveVersion, type Agent } from "./engine";
import { evaluateInstructions } from "./instructions";
import { forecastProposal } from "./runner";
import { loadBars } from "./history";

export type TrainingRecord = {
  at: string; report: TrainReport;
  dataset: { symbol: string; bars: number; hash: string; synthetic: boolean; through: string };
  baseVersion?: number;
  appliedVersion?: number;
};

export async function trainAgent(agent: Agent, symbol: string, synthetic = false, automatic = false) {
  const version = latest(agent);
  if (!version.markets.includes(symbol)) throw new Error("Allow this market on the agent before training.");
  const history = synthetic ? undefined : await loadBars(symbol);
  const bars = history?.bars ?? syntheticSeries(17, 600);
  const hash = history?.hash ?? datasetHash(bars);
  const previous = agent.training?.findLast(item => item.dataset.symbol === symbol && item.dataset.synthetic === synthetic);
  if (previous?.dataset.hash === hash &&
      (previous.appliedVersion ?? previous.baseVersion ?? version.number) === version.number) return previous;
  if (automatic && bars.filter(bar => !previous || bar.at > previous.dataset.through).length < 200) return;
  if (bars.length < 120) throw new Error(`Training requires 120 recorded bars. ${symbol} has ${bars.length}. Collect more quotes or select SYNTHETIC.`);
  const report = train(bars, version, Number.parseInt(hash.slice(0, 8), 16));
  const record: TrainingRecord = {
    at: new Date().toISOString(), report, baseVersion: version.number,
    dataset: { symbol, bars: bars.length, hash, synthetic, through: bars[bars.length - 1].at },
  };
  if (report.promoted) record.appliedVersion = saveVersion(agent, { ...version, ...report.candidate }).number;
  agent.training = [...(agent.training ?? []), record].slice(-20);
  return record;
}

export async function fitAgent(agent: Agent, symbol: string, synthetic: boolean, config: FitConfig, stochastic = false) {
  const version = latest(agent);
  if (!version.markets.includes(symbol)) throw new Error("Allow this market before fitting its model.");
  const available = synthetic ? syntheticSeries(17, 600) : (await loadBars(symbol)).bars;
  const bars = available.filter(bar => (!config.from || bar.at.slice(0, 10) >= config.from) && (!config.to || bar.at.slice(0, 10) <= config.to));
  const datasetHash = sha256({ symbol, synthetic, bars });
  const execution = { strategy: version.strategy, threshold: version.threshold, positionLimit: version.positionLimit,
    stopLossPct: version.stopLossPct, instructions: version.instructions };
  const id = sha256({ datasetHash, config, execution, replayVersion: 1, ...(stochastic ? { method: "sgd" } : {}) }).slice(0, 20);
  const existing = agent.fittedModels?.find(model => model.id === id);
  if (existing) return existing;
  if (!stochastic && (agent.fittedModels?.length ?? 0) >= 20) throw new Error("This agent has reached 20 saved model artifacts.");
  const model: FittedModel = {
    id, createdAt: new Date().toISOString(), symbol, synthetic, datasetHash, bars, execution,
    artifact: await (stochastic ? fitStochastic : fitForecast)(bars, config, Number.parseInt(datasetHash.slice(0, 8), 16)),
  };
  const heldOut = bars.filter(bar => bar.at >= model.artifact.split.testFrom);
  const test = simulate(heldOut, version, 1, i => {
    if (!i) return { action: "hold", reason: "A prior held-out quote is required." };
    const observations = [heldOut[i], heldOut[i - 1]].map((bar, j) => ({
      ...bar, id: String(j), symbol, mode: "replay" as const, title: symbol, source: "Held-out quote",
    }));
    const instruction = evaluateInstructions(version.instructions, observations[0]).matched;
    const forecast = predict(model.artifact, observations[0], observations[1]);
    return instruction ?? forecastProposal(version, forecast, config.horizon);
  }, true);
  const baseline = simulate(heldOut, version, 1);
  let peak = 100_000;
  model.backtest = { equity: test.equity, pnl: test.pnl, fees: test.fees, trades: test.trades, rows: test.rows, slippage: 1,
    baseline: { pnl: baseline.pnl, trades: baseline.trades, equity: baseline.equity },
    drawdown: test.equity.map(value => { peak = Math.max(peak, value); return peak - value; }) };
  (agent.fittedModels ??= []).push(model);
  return model;
}
