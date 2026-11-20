import { datasetHash, syntheticSeries, train, type TrainReport } from "./backtest";
import { latest, saveVersion, type Agent } from "./engine";
import { loadBars } from "./history";

export type TrainingRecord = {
  at: string; report: TrainReport;
  dataset: { symbol: string; bars: number; hash: string; synthetic: boolean; through: string };
  appliedVersion?: number;
};

export async function trainAgent(agent: Agent, symbol: string, synthetic = false, automatic = false) {
  const version = latest(agent);
  if (!version.markets.includes(symbol)) throw new Error("Allow this market on the agent before training.");
  const history = synthetic ? undefined : await loadBars(symbol);
  const bars = history?.bars ?? syntheticSeries(17, 600);
  const hash = history?.hash ?? datasetHash(bars);
  const previous = agent.training?.findLast(item => item.dataset.symbol === symbol && item.dataset.synthetic === synthetic);
  if (previous?.dataset.hash === hash) return previous;
  if (automatic && bars.filter(bar => !previous || bar.at > previous.dataset.through).length < 200) return;
  if (bars.length < 120) throw new Error(`Training requires 120 recorded bars. ${symbol} has ${bars.length}. Collect more quotes or select SYNTHETIC.`);
  const report = train(bars, version, Number.parseInt(hash.slice(0, 8), 16));
  const record: TrainingRecord = {
    at: new Date().toISOString(), report,
    dataset: { symbol, bars: bars.length, hash, synthetic, through: bars[bars.length - 1].at },
  };
  if (report.promoted) record.appliedVersion = saveVersion(agent, { ...version, ...report.candidate }).number;
  agent.training = [...(agent.training ?? []), record].slice(-20);
  return record;
}
