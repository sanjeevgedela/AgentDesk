import { dollars, latest, type Agent } from "./engine";

export function answerTraining(agent: Agent, modelId: string | undefined, question: string) {
  const model = agent.fittedModels?.find(item => item.id === modelId);
  const name = latest(agent).name;
  if (!model) return `No saved fitted model is selected for ${name}. Fit a model in Training to inspect its dataset and decisions.`;
  const { artifact, backtest, bars } = model;
  const query = question.toLowerCase();
  const parts = [`${name} · model ${model.id} · ${model.synthetic ? "SYNTHETIC" : "recorded quotes"} for ${model.symbol}.`];
  const data = /data|quote|split|train|features|sample|time/.test(query);
  const metrics = /perform|score|baseline|accur|error|held|profit|loss|result|better|test/.test(query);
  const strategy = /strategy|buy|sell|trade|fill|why|research|cost|fee|stop/.test(query);

  if (data || (!metrics && !strategy)) parts.push(
    `The dataset has ${bars.length} observations from ${bars[0].at} through ${bars.at(-1)?.at}. SHA-256 ${model.datasetHash}.`,
    `Features: ${artifact.config.features.join(", ")}. Target: future midpoint change over ${artifact.config.horizon} observations. Validation starts ${artifact.split.validationFrom}; final test starts ${artifact.split.testFrom}.`,
  );
  if (metrics || (!data && !strategy)) {
    parts.push(`Validation MAE ${artifact.validation.mae.toFixed(2)}¢. Final test MAE ${artifact.test.mae.toFixed(2)}¢ vs. ${artifact.test.zeroMoveMae.toFixed(2)}¢ for zero change.`);
    if (backtest) parts.push(
      `Held-out paper P&L ${dollars(backtest.pnl)} after ${backtest.trades} fills and ${dollars(backtest.fees)} in simulated fees.`,
      backtest.baseline ? `The same strategy without the forecast returned ${dollars(backtest.baseline.pnl)} on those quotes.` : "This saved run has no matched strategy baseline.",
    );
  }
  if (strategy) {
    const config = model.execution;
    if (config) parts.push(`${config.strategy} used a ${config.threshold}¢ threshold and a ${config.positionLimit}-contract position limit. ${config.stopLossPct ? `Stop-loss was ${config.stopLossPct}% below entry.` : "Stop-loss was off."}`);
    const fills = backtest?.rows?.filter(row => row.fill) ?? [];
    if (fills.length) {
      const last = fills[fills.length - 1];
      parts.push(`The last recorded fill was a ${last.action} of ${last.fill!.quantity} YES at ${last.fill!.price}¢ on ${last.at}. ${last.reason}`);
    } else if (backtest?.rows) {
      const requests = backtest.rows.filter(row => row.researchRequested).length;
      parts.push(requests ? `The strategy requested research ${requests} times. Backtests leave research requests unpurchased.` : "No paper fills were recorded in this backtest.");
    } else parts.push("This older backtest has no saved decision rows. Refit to capture them.");
  }
  return parts.join("\n\n");
}
