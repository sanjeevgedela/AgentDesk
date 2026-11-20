import { z } from "zod";
import { guard, parseInstructions } from "./policy";

export const INITIAL_CASH = 100_000;
export const PRICE = 250_000; // USDC base units
export const RESOURCE = "spread-review";
export const strategies = ["Momentum", "Contrarian", "Evidence-driven"] as const;
export const configSchema = z.object({
  name: z.string().trim().min(1).max(60),
  strategy: z.enum(strategies),
  instructions: z.string().max(2000),
  threshold: z.number().int().min(1).max(40),
  positionLimit: z.number().int().min(1).max(1000),
  markets: z.array(z.string().regex(/^[\w-]+$/).max(120)).min(1).max(30),
  active: z.boolean(),
});
export type Config = z.infer<typeof configSchema>;
export type Version = Config & { number: number; at: string };
export type Agent = { id: string; versions: Version[]; budget: number; cap: number; resources: string[]; cash: number; positions: Record<string, number> };
export type Snapshot = { id: string; symbol: string; title: string; bid: number; ask: number; at: string; source: string; mode: "replay" | "live" };
export const proposalSchema = z.object({
  action: z.enum(["buy", "sell", "hold"]),
  reason: z.string().trim().min(1).max(420),
  resource: z.literal(RESOURCE).optional(),
}).strict();
export type Proposal = z.infer<typeof proposalSchema>;
export type Decision = {
  id: string; agent: string; version: number; snapshot: Snapshot; at: string;
  change: number | null; action: Proposal["action"]; reason: string; policy: string;
  resource?: typeof RESOURCE;
  researchPurchase?: string;
  fill: { quantity: number; price: number; fee: number } | null;
  tools: { name: string; result: string }[];
};
export type Purchase = {
  id: string; agent: string; decision: string; amount: number; at: string;
  status: "blocked" | "pending" | "confirmed" | "simulated" | "failed" | "uncertain";
  reason: string; before: Proposal["action"]; after?: Proposal["action"]; evidence?: string;
  recipient?: string; mint?: string; signature?: string; programs?: string[];
};
export type BudgetChange = { id: string; agent: string; cap: number; budget: number; expires: number };
export type Desk = {
  agents: Agent[]; snapshots: Snapshot[]; decisions: Decision[]; purchases: Purchase[];
  changes: BudgetChange[]; replay: number; mode: Snapshot["mode"]; selected: string;
};
export function latest(agent: Agent) { return agent.versions[agent.versions.length - 1]; }

export const REPLAY_SYMBOL = "REPLAY-FED";
const replayQuotes = [[36, 39], [42, 45], [48, 56], [53, 57], [45, 49], [38, 42]];
export function replaySnapshot(index: number): Snapshot {
  const [bid, ask] = replayQuotes[index];
  return { id: "replay-" + index, symbol: REPLAY_SYMBOL, title: "Will the Fed cut rates at its next meeting?",
    bid, ask, mode: "replay", source: "AgentDesk synthetic replay",
    at: new Date(Date.UTC(2026, 0, 15, 14, index * 5)).toISOString() };
}
export function newAgent(config: Config): Agent {
  return { id: crypto.randomUUID(), versions: [{ ...config, number: 1, at: new Date().toISOString() }],
    cash: INITIAL_CASH, positions: {}, budget: 1_000_000, cap: 100_000, resources: [RESOURCE] };
}
export function newDesk(): Desk {
  const names = ["Trend Scout", "Mean Reverter", "Evidence Analyst"];
  return {
    agents: strategies.map((strategy, i) => newAgent({
      name: names[i], strategy, instructions: "", threshold: 3, positionLimit: 25, markets: [REPLAY_SYMBOL], active: true,
    })),
    snapshots: [replaySnapshot(0)], decisions: [], purchases: [], changes: [], replay: 0, mode: "replay", selected: REPLAY_SYMBOL,
  };
}
export function advance(desk: Desk) {
  if (desk.replay + 1 >= replayQuotes.length) throw new Error("Replay is at its final snapshot.");
  desk.snapshots.push(replaySnapshot(++desk.replay));
}
export function currentSnapshot(desk: Desk) {
  return desk.snapshots.findLast(s => s.mode === desk.mode && s.symbol === desk.selected);
}
export function signal(desk: Desk, snapshot: Snapshot) {
  const history = desk.snapshots.filter(s => s.mode === snapshot.mode && s.symbol === snapshot.symbol);
  const previous = history.findLast(s => s.id !== snapshot.id && s.at < snapshot.at);
  return previous ? (snapshot.bid + snapshot.ask - previous.bid - previous.ask) / 2 : null;
}
export function recommendation(config: Config, change: number | null): Proposal {
  if (change === null || Math.abs(change) < config.threshold)
    return { action: "hold", reason: "There is insufficient price movement to cross the strategy threshold." };
  if (config.strategy === "Evidence-driven")
    return { action: "hold", resource: RESOURCE, reason: "The price move warrants a review of quote quality before trading." };
  const direction = config.strategy === "Contrarian" ? -change : change;
  return { action: direction > 0 ? "buy" : "sell", reason: `${config.strategy} signal from a ${change.toFixed(1)}¢ midpoint move.` };
}
export function record(desk: Desk, agent: Agent, snapshot: Snapshot, input: Proposal, tools: Decision["tools"], researchPurchase?: string) {
  const config = latest(agent);
  if (!config.active || !config.markets.includes(snapshot.symbol)) throw new Error("Activate the agent and allow this market in its settings.");
  if (desk.decisions.some(d => d.agent === agent.id && d.snapshot.id === snapshot.id && d.version === config.number && d.researchPurchase === researchPurchase))
    throw new Error("This strategy version already ran on this snapshot.");
  const rules = parseInstructions(config.instructions);
  const { proposal, reasons } = guard(input, snapshot, rules);
  const maxQty = Math.min(5, rules.maxQty ?? 5);
  tools = [...tools, { name: "policy_guard", result: reasons.join(". ") || `Passed; max order quantity ${maxQty}.` }];
  const position = agent.positions[snapshot.symbol] ?? 0;
  const price = proposal.action === "buy" ? snapshot.ask : snapshot.bid;
  const fee = 1;
  const quantity = proposal.action === "buy" ? Math.min(maxQty, config.positionLimit - position, Math.floor((agent.cash - fee) / price))
    : proposal.action === "sell" && price > fee ? Math.min(maxQty, position) : 0;
  const fill = quantity > 0 ? { price, quantity, fee } : null;
  if (fill) {
    const delta = proposal.action === "buy" ? quantity : -quantity;
    agent.positions[snapshot.symbol] = position + delta;
    agent.cash -= delta * price + fee;
  }
  const policy = fill ? "Paper order filled at the observed quote."
    : proposal.action === "hold" ? "No order proposed."
    : proposal.action === "sell" && position === 0 ? "No contracts to sell."
    : proposal.action === "buy" && position >= config.positionLimit ? "Position limit reached."
    : proposal.action === "buy" ? "Insufficient paper cash for one contract and the fee."
    : "Sale proceeds would not cover the fee.";
  const decision: Decision = {
    id: crypto.randomUUID(), agent: agent.id, version: config.number, snapshot, at: new Date().toISOString(),
    change: signal(desk, snapshot), ...proposal, researchPurchase, fill, tools,
    policy,
  };
  desk.decisions.push(decision);
  return decision;
}
export function reserved(desk: Desk, agentId: string) {
  return desk.purchases.filter(p => p.agent === agentId && ["pending", "confirmed", "simulated", "uncertain"].includes(p.status))
    .reduce((total, p) => total + p.amount, 0);
}
export function reserve(desk: Desk, agent: Agent, decision: Decision, id: string, enabled: boolean, simulated = false) {
  const existing = desk.purchases.find(p => p.id === id || (p.agent === agent.id && p.decision === decision.id && ["pending","uncertain","confirmed","simulated"].includes(p.status)));
  if (existing) return { purchase: existing, fresh: false };
  let reason = "";
  if (!latest(agent).active || !agent.resources.includes(RESOURCE)) reason = "Agent or resource is disabled.";
  else if (!simulated && PRICE > agent.cap) reason = "Research price exceeds the per-purchase cap.";
  else if (!simulated && reserved(desk, agent.id) + PRICE > agent.budget) reason = "Research price exceeds the remaining budget.";
  else if (!enabled) reason = "Solana devnet payment configuration is unavailable.";
  const purchase: Purchase = { id, agent: agent.id, decision: decision.id, amount: PRICE, at: new Date().toISOString(),
    status: reason ? "blocked" : "pending", reason: reason || "Budget reserved.", before: decision.action };
  desk.purchases.push(purchase);
  return { purchase, fresh: !reason };
}
export function evidenceFor(snapshot: Snapshot) {
  const spread = snapshot.ask - snapshot.bid;
  return { spread, text: `AgentDesk quote review for ${snapshot.symbol}. Spread was ${spread}¢ at ${snapshot.at}, based on ${snapshot.source}. ${spread <= 5 ? "The spread met the 5¢ quote-quality threshold." : "The spread exceeded the 5¢ quote-quality threshold."}` };
}
export function dollars(cents: number) { return "$" + (cents / 100).toFixed(2); }
export function usdc(units: number) { return (units / 1_000_000).toFixed(2) + " USDC"; }
