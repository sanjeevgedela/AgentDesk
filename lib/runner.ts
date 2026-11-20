import { RESOURCE, latest, recommendation, recordIf, type Agent, type Config, type Desk, type Decision, type Snapshot, type Proposal, type Version } from "./engine";
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

export function forecastProposal(config: Pick<Config, "strategy" | "threshold">, change: number, horizon: number): Proposal {
  const move = config.strategy === "Contrarian" ? -change : change;
  const actionable = Math.abs(move) >= config.threshold;
  return {
    action: !actionable || config.strategy === "Evidence-driven" ? "hold" : move > 0 ? "buy" : "sell",
    reason: `Model forecast ${change.toFixed(2)}¢ over ${horizon} observations.`,
    resource: actionable && config.strategy === "Evidence-driven" ? RESOURCE : undefined,
  };
}

export function recordRun(desk: Desk, agent: Agent, snapshot: Snapshot, proposal: Proposal, source: string, stopOnly?: boolean): Decision;
export function recordRun(desk: Desk, agent: Agent, snapshot: Snapshot, proposal: Proposal, source: string, stopOnly: boolean, accept: (decision: Decision) => boolean): Decision | undefined;
export function recordRun(desk: Desk, agent: Agent, snapshot: Snapshot, proposal: Proposal, source: string, stopOnly = false, accept?: (decision: Decision) => boolean) {
  const version = latest(agent);
  const models = agent.fittedModels ?? [];
  const model = models.find(item => item.id === version.modelId) ?? models.findLast(item =>
    item.artifact.method === "sgd" && item.symbol === snapshot.symbol && item.synthetic === (snapshot.mode === "replay") &&
    item.bars.at(-1)!.at < snapshot.at && item.artifact.validation.mae < item.artifact.validation.zeroMoveMae &&
    item.execution?.strategy === version.strategy && item.execution?.instructions === version.instructions &&
    item.execution?.threshold === version.threshold && item.execution?.positionLimit === version.positionLimit &&
    item.execution?.stopLossPct === version.stopLossPct);
  const previous = desk.snapshots.findLast(quote => quote.mode === snapshot.mode && quote.symbol === snapshot.symbol && quote.at < snapshot.at);
  const usable = model && previous && model.synthetic === (snapshot.mode === "replay") && model.symbol === snapshot.symbol &&
    model.bars.at(-1)!.at < snapshot.at;
  const forecast = usable && predict(model.artifact, snapshot, previous);
  const inference = typeof forecast === "number" && model
    ? { modelId: model.id, horizon: model.artifact.config.horizon, change: forecast } : undefined;
  if (!stopOnly && (version.modelId || model) && source !== "saved_instruction") {
    source = inference ? "fitted_model" : "model_unavailable";
    if (inference) {
      proposal = forecastProposal(version, inference.change, inference.horizon);
    } else proposal = { action: "hold", reason: "The active model needs a matching market and a quote after its dataset cutoff." };
  }
  if (stopOnly) {
    proposal = { action: "hold", reason: "Automatic watch only checks the configured stop-loss." };
    source = "stop_watch";
  }
  const decision = recordIf(desk, agent, snapshot, proposal, [
    { name: "market_snapshot", result: snapshot.source },
    { name: source, result: proposal.reason },
  ], undefined, undefined, accept);
  if (decision && !stopOnly && inference) decision.forecast = inference;
  return decision;
}
