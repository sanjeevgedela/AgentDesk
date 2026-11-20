import { agentStats, dollars, latest, usdc, type Desk } from "./engine";

export function answer(desk: Desk, question: string) {
  const match = question.toLowerCase();
  const selected = desk.agents.filter(a => match.includes(latest(a).name.toLowerCase()));
  const agents = selected.length ? selected : desk.agents;
  const comparison = desk.decisions.length && /disagree|compar/.test(match)
    ? desk.decisions.filter(d => d.snapshot.id === desk.decisions.at(-1)?.snapshot.id)
    : desk.decisions;
  return agents.map(agent => {
    const config = latest(agent);
    const decision = comparison.findLast(d => d.agent === agent.id);
    const stale = decision?.snapshot.mode === "live" && Date.now() - Date.parse(decision.snapshot.at) > 900_000;
    const purchases = desk.purchases.filter(p => p.agent === agent.id);
    const confirmed = purchases.filter(p => p.status === "confirmed");
    const simulated = purchases.filter(p => p.status === "simulated");
    const activeModel = agent.fittedModels?.find(model => model.id === config.modelId);
    const stats = agentStats(desk, agent);
    const training = agent.training?.at(-1);
    const change = agent.versions.at(-2);
    const updates = change ? (["name","strategy","instructions","threshold","positionLimit","stopLossPct","markets","active"] as const)
      .filter(k => JSON.stringify(change[k]) !== JSON.stringify(config[k])).map(k => `${k}: ${change[k]} → ${config[k]}`).join(", ") : "";
    const overlaps = desk.agents.filter(other => other.id !== agent.id).flatMap(other =>
      Object.keys(agent.positions).filter(symbol => agent.positions[symbol] > 0 && (other.positions[symbol] ?? 0) > 0)
        .map(symbol => `${latest(other).name} (${symbol})`));
    return [
      `${config.name} · ${config.strategy} v${config.number} · ${config.active ? "active" : "paused"} · ${dollars(agent.cash)} paper cash.`,
      `Settings saved ${config.at}. Threshold ${config.threshold}¢; position limit ${config.positionLimit}; stop-loss ${config.stopLossPct ?? "off"}. Paper equity ${dollars(stats.equity)}. Positions: ${Object.entries(agent.positions).filter(([, quantity]) => quantity > 0).map(([symbol, quantity]) => `${symbol} ${quantity} YES`).join(", ") || "none"}.`,
      activeModel ? `Active fitted model [${activeModel.id}] · ${activeModel.synthetic ? "SYNTHETIC" : "recorded"} ${activeModel.bars.length} quotes, SHA-256 ${activeModel.datasetHash}. Target: change in midpoint over ${activeModel.artifact.config.horizon} observations. Validation MAE ${activeModel.artifact.validation.mae.toFixed(2)}¢. Test MAE ${activeModel.artifact.test.mae.toFixed(2)}¢.` : "No fitted model is active.",
      decision ? `Decision [${decision.id}] on ${decision.snapshot.symbol} at ${decision.snapshot.at}: ${decision.action}. ${decision.reason} ${decision.policy}${stale ? " The quote is older than 15 minutes." : ""}` : "No matching recorded decision.",
      `Confirmed research: ${usdc(confirmed.reduce((sum, p) => sum + p.amount, 0))}.`,
      ...(simulated.length ? [`Simulated research: ${usdc(simulated.reduce((sum, p) => sum + p.amount, 0))}.`] : []),
      ...purchases.slice(-3).map(p => `Purchase [${p.id}] · ${p.status} at ${p.at}. ${p.reason}${p.after ? ` Recommendation ${p.before} → ${p.after}. ${p.evidence}` : ""}`),
      overlaps.length ? "Overlapping exposure: " + overlaps.join(", ") + "." : "No overlapping open positions.",
      ...(training ? [`Training: ${training.dataset.synthetic ? "SYNTHETIC" : "recorded"} ${training.dataset.bars} bars, SHA-256 ${training.dataset.hash}. ${training.appliedVersion ? "Promoted v" + training.appliedVersion : "Kept incumbent"}. Held-out PnL difference ${training.report.trial.pnl - training.report.incumbent.pnl} cents.`] : []),
      change ? `Changes from v${change.number}: ${updates || "no configuration differences"}.` : "This is the first strategy version.",
    ].join("\n");
  }).join("\n\n") || "Create an agent and record a run first.";
}
