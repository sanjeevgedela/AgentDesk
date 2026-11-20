import { currentSnapshot, latest } from "./engine";
import { loadBars } from "./history";
import { transact } from "./store";
import { fitAgent } from "./training";
import { featureNames } from "./fitted";

const jobs = new Map<string, Promise<string>>();

export function trainWorkspace(owner: string, scheduled = false) {
  const existing = jobs.get(owner);
  if (existing) return existing;
  const job = train(owner, scheduled).finally(() => jobs.delete(owner));
  jobs.set(owner, job);
  return job;
}

async function train(owner: string, scheduled: boolean) {
  const { quote, agents } = await transact(owner, desk => ({
    quote: currentSnapshot(desk), agents: structuredClone(desk.agents),
  }));
  if (!quote || (scheduled && quote.mode !== "live")) return "Choose a market to start training.";
  const synthetic = quote.mode === "replay";
  const bars = synthetic ? [] : (await loadBars(quote.symbol)).bars;
  if (!synthetic && bars.length < 120) return `Collecting Gemini quotes for training · ${bars.length}/120`;
  let saved = 0;
  let eligible = 0;
  for (const agent of agents) {
    const config = latest(agent);
    if (!config.active || !config.markets.includes(quote.symbol)) continue;
    eligible++;
    const previous = agent.fittedModels?.findLast(model => model.symbol === quote.symbol && model.artifact.method === "sgd" &&
      model.synthetic === synthetic && model.execution?.strategy === config.strategy &&
      model.execution?.threshold === config.threshold && model.execution?.positionLimit === config.positionLimit &&
      model.execution?.stopLossPct === config.stopLossPct && model.execution?.instructions === config.instructions);
    if (previous && (synthetic || bars.filter(bar => bar.at > previous.bars.at(-1)!.at).length < 200)) continue;
    const model = await fitAgent(agent, quote.symbol, synthetic, { features: [...featureNames], horizon: 3, ridge: .01 }, true);
    saved += await transact(owner, desk => {
      const current = desk.agents.find(item => item.id === agent.id);
      if (!current || latest(current).number !== config.number || current.fittedModels?.some(item => item.id === model.id)) return 0;
      const models = current.fittedModels ?? [];
      const matching = models.filter(item => item.artifact.method === "sgd" && item.symbol === model.symbol && item.synthetic === model.synthetic);
      const obsolete = new Set(matching.filter(item => item.id !== config.modelId).slice(0, Math.max(0, matching.length - 1)).map(item => item.id));
      current.fittedModels = [...models.filter(item => !obsolete.has(item.id)), model];
      return 1;
    });
  }
  return saved ? `Saved ${saved} stochastic forecast${saved === 1 ? "" : "s"}` : eligible
    ? (synthetic ? "Replay forecasts are up to date." : "Forecasts are up to date · retrain after 200 new quotes.")
    : "Enable an agent and allow this market to start training.";
}
