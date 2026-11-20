import { latest, recommendation, record, type Agent, type Desk, type Snapshot, type Proposal, type Version } from "./engine";
import { predict } from "./fitted";
import { evaluateInstructions } from "./instructions";
import { parseInstructions } from "./policy";

export function evaluateRun(version: Version, snapshot: Snapshot, change: number | null) {
  const { matched, notes } = evaluateInstructions(version.instructions, snapshot);
  const unknown = parseInstructions(notes.join("\n")).unrecognized;
  const baseline = recommendation(version, change);
  return {
    matched, notes: unknown, baseline,
    proposal: matched ?? (unknown.length
      ? { action: "hold" as const, reason: "Some instructions require an enabled model. The run recorded a hold." }
      : baseline),
    source: matched ? "saved_instruction" : unknown.length ? "instructions_require_model" : "strategy_rule",
  };
}

export function recordRun(desk: Desk, agent: Agent, snapshot: Snapshot, proposal: Proposal, source: string, stopOnly = false) {
  const version = latest(agent);
  const model = agent.fittedModels?.find(item => item.id === version.modelId);
  const previous = desk.snapshots.findLast(quote => quote.mode === snapshot.mode && quote.symbol === snapshot.symbol && quote.at < snapshot.at);
  const usable = model && previous && model.synthetic === (snapshot.mode === "replay") && model.symbol === snapshot.symbol &&
    model.bars.at(-1)!.at < snapshot.at;
  const forecast = usable && predict(model.artifact, snapshot, previous);
  const inference = typeof forecast === "number" && model
    ? { modelId: model.id, horizon: model.artifact.config.horizon, change: forecast } : undefined;
  if (!stopOnly && version.modelId && source !== "saved_instruction") {
    source = inference ? "fitted_model" : "model_unavailable";
    if (inference) {
      const move = version.strategy === "Contrarian" ? -inference.change : inference.change;
      const action = Math.abs(move) < version.threshold || version.strategy === "Evidence-driven" ? "hold" : move > 0 ? "buy" : "sell";
      proposal = { action, reason: `Ridge forecast ${inference.change.toFixed(2)}¢ over ${inference.horizon} observations.`,
        ...(version.strategy === "Evidence-driven" && Math.abs(move) >= version.threshold ? { resource: "spread-review" as const } : {}) };
    } else proposal = { action: "hold", reason: "The active model needs a matching market and a quote after its dataset cutoff." };
  }
  if (stopOnly) {
    proposal = { action: "hold", reason: "Automatic watch only checks the configured stop-loss." };
    source = "stop_watch";
  }
  const decision = record(desk, agent, snapshot, proposal, [
    { name: "market_snapshot", result: snapshot.source },
    { name: source, result: proposal.reason },
  ]);
  if (!stopOnly && inference) decision.forecast = inference;
  return decision;
}
