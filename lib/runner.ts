import { recommendation, record, type Agent, type Desk, type Snapshot, type Proposal, type Version } from "./engine";
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

export function recordRun(desk: Desk, agent: Agent, snapshot: Snapshot, proposal: Proposal, source: string) {
  return record(desk, agent, snapshot, proposal, [
    { name: "market_snapshot", result: snapshot.source },
    { name: source, result: proposal.reason },
  ]);
}
