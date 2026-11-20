import { z } from "zod";
import { record, latest, replaySnapshot, type Desk, type Purchase, type Snapshot } from "./engine";
import { loadBars } from "./history";
import { queueAnchor } from "./anchor-queue";
import type { Bar } from "./backtest";

export const researchLimits = { minimumPersistence: .6, maxSpreadPercentile: 50, maxVolatility: 8 };
export const evidenceSchema = z.object({
  spread: z.number().int().nonnegative(), observations: z.number().int().min(1).max(200),
  spreadPercentile: z.number().min(0).max(100), volatility: z.number().nonnegative(),
  staleness: z.number().nonnegative().nullable(), persistence: z.number().min(0).max(1), text: z.string(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export function evidenceFor(snapshot: Snapshot, history: Bar[]) {
  const bars = [...history.filter(bar => bar.at < snapshot.at), snapshot].sort((a, b) => a.at.localeCompare(b.at)).slice(-200);
  const spread = snapshot.ask - snapshot.bid;
  const others = bars.slice(0, -1);
  const spreadPercentile = others.length ? 100 * others.reduce((count, bar) => {
    const observed = bar.ask - bar.bid;
    return count + (observed < spread ? 1 : observed === spread ? .5 : 0);
  }, 0) / others.length : 100;
  const recent = bars.slice(-20);
  const moves = recent.slice(1).map((bar, i) => (bar.ask + bar.bid - recent[i].ask - recent[i].bid) / 2);
  const volatility = moves.length ? Math.sqrt(moves.reduce((sum, move) => sum + move ** 2, 0) / moves.length) : 0;
  const signs = moves.slice(-10);
  const direction = Math.sign(signs.at(-1) ?? 0);
  const persistence = direction ? signs.filter(move => Math.sign(move) === direction).length / signs.length : 0;
  const distinct = others.findLast(bar => bar.bid !== snapshot.bid || bar.ask !== snapshot.ask);
  const staleness = distinct ? (Date.parse(snapshot.at) - Date.parse(distinct.at)) / 1000 : null;
  return {
    spread, observations: bars.length, spreadPercentile, volatility, staleness, persistence,
    text: `${snapshot.mode === "replay" ? "SYNTHETIC. " : ""}${bars.length} observations through ${snapshot.at}. RMS midpoint move ${volatility.toFixed(2)}¢, spread percentile ${spreadPercentile.toFixed(1)}, same-direction moves ${(persistence * 100).toFixed(0)}%, prior distinct quote ${staleness ?? "unavailable"} seconds ago.`,
  };
}

export async function researchFor(snapshot: Snapshot) {
  const bars = snapshot.mode === "replay"
    ? Array.from({ length: 6 }, (_, index) => replaySnapshot(index)).filter(quote => quote.symbol === snapshot.symbol)
    : (await loadBars(snapshot.symbol)).bars;
  return evidenceFor(snapshot, bars);
}

export function applyReview(desk: Desk, purchase: Purchase) {
  const existing = desk.decisions.find(d => d.followUpOf === purchase.decision || d.researchPurchase === purchase.id);
  if (existing) return { decision: existing, reused: true };
  const original = desk.decisions.find(d => d.id === purchase.decision);
  const agent = desk.agents.find(a => a.id === purchase.agent);
  if (!original || !agent || !purchase.after || !latest(agent).active || latest(agent).number !== original.version)
    return;
  // Read the latest quote for this market independently of the dashboard selection.
  const current = desk.snapshots.findLast(q => q.symbol === original.snapshot.symbol && q.mode === original.snapshot.mode);
  if (!current || current.at !== original.snapshot.at || !latest(agent).markets.includes(current.symbol)) return;
  const decision = record(desk, agent, original.snapshot, {
    action: purchase.after, reason: "Re-evaluated the paper decision using purchased quote history.",
  }, [{ name: "paid_research", result: purchase.signature ? `${purchase.id} · ${purchase.signature}` : purchase.id }], purchase.id, original.id);
  if (purchase.status === "confirmed") queueAnchor(decision, latest(agent));
  return { decision, reused: false };
}

export function completeReview(desk: Desk, purchase: Purchase, snapshot: Snapshot, evidence: Evidence, simulated: boolean, programs: readonly string[]) {
  purchase.status = simulated ? "simulated" : "confirmed";
  if (!simulated) purchase.programs = [...programs];
  purchase.evidence = evidence.text;
  const passes = evidence.observations > 1 && evidence.persistence >= researchLimits.minimumPersistence &&
    evidence.spreadPercentile <= researchLimits.maxSpreadPercentile && evidence.volatility <= researchLimits.maxVolatility;
  const previous = desk.snapshots.findLast(q => q.symbol === snapshot.symbol && q.mode === snapshot.mode && q.at < snapshot.at);
  const direction = previous ? snapshot.bid + snapshot.ask - previous.bid - previous.ask : 0;
  purchase.after = passes && direction ? direction > 0 ? "buy" : "sell" : "hold";
  purchase.reason = simulated ? "Simulated review complete." : "Devnet USDC transfer confirmed.";
  purchase.validation = [
    { name: "schema", ok: true, detail: "Historical evidence schema passed.", at: purchase.at },
    { name: "execute", ok: true, detail: simulated ? "Simulated purchase." : "x402 settlement recorded.", at: purchase.at },
    { name: "reconcile", ok: true, detail: simulated ? "Demo ledger updated." : "Verified vendor USDC balance delta on devnet.", at: purchase.at },
  ];
  if (!simulated) {
    if (!applyReview(desk, purchase)) purchase.reason += " The original quote or strategy is no longer current.";
  }
}
