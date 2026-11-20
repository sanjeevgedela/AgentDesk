import { dollars, latest, usdc, type Desk } from "./engine";

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
    const purchases = desk.purchases.filter(p => p.agent === agent.id);
    const confirmed = purchases.filter(p => p.status === "confirmed");
    const simulated = purchases.filter(p => p.status === "simulated");
    const change = agent.versions.at(-2);
    const updates = change ? (["name","strategy","instructions","threshold","positionLimit","markets","active"] as const)
      .filter(k => JSON.stringify(change[k]) !== JSON.stringify(config[k])).map(k => `${k}: ${change[k]} → ${config[k]}`).join(", ") : "";
    const overlaps = desk.agents.filter(other => other.id !== agent.id).flatMap(other =>
      Object.keys(agent.positions).filter(symbol => agent.positions[symbol] > 0 && (other.positions[symbol] ?? 0) > 0)
        .map(symbol => `${latest(other).name} (${symbol})`));
    return [
      `${config.name} · ${config.strategy} v${config.number} · ${config.active ? "active" : "paused"} · ${dollars(agent.cash)} paper cash.`,
      decision ? `Decision [${decision.id}] on ${decision.snapshot.symbol}: ${decision.action}. ${decision.reason} ${decision.policy}` : "No matching recorded decision.",
      `Confirmed research: ${usdc(confirmed.reduce((sum, p) => sum + p.amount, 0))}.`,
      ...(simulated.length ? [`Simulated research: ${usdc(simulated.reduce((sum, p) => sum + p.amount, 0))}.`] : []),
      ...purchases.slice(-3).map(p => `Purchase [${p.id}] · ${p.status}. ${p.reason}${p.after ? ` Recommendation ${p.before} → ${p.after}. ${p.evidence}` : ""}`),
      overlaps.length ? "Overlapping exposure: " + overlaps.join(", ") + "." : "No overlapping open positions.",
      change ? `Changes from v${change.number}: ${updates || "no configuration differences"}.` : "This is the first strategy version.",
    ].join("\n");
  }).join("\n\n") || "Create an agent and record a run first.";
}
