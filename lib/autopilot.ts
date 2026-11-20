import { hasRun, keepRecentQuotes, latest, positionMark, signal, type Desk, type Snapshot } from "./engine";
import { evaluateRun, recordRun } from "./runner";
import { trainAgent } from "./training";
import { queueAnchor } from "./anchor-queue";
import { transact } from "./store";

export function followedQuotes(desk: Desk, scheduled = false) {
  const watch = new Set<string>();
  for (const agent of desk.agents) {
    const config = latest(agent);
    if (!config.active || config.stopLossPct === undefined) continue;
    for (const symbol of config.markets) if (agent.positions[symbol] > 0) watch.add(symbol);
  }
  for (const agent of desk.agents) {
    const config = latest(agent);
    if (config.active && (scheduled ? config.auto : config.auto !== false)) for (const symbol of config.markets) watch.add(symbol);
  }
  return [...watch].flatMap(symbol => {
    const quote = desk.snapshots.findLast(item => item.symbol === symbol && item.mode === "live");
    return quote ? [quote] : [];
  });
}

function liveDecision(desk: Desk, agent: Desk["agents"][number], quote: Snapshot, scheduled = false) {
  const config = latest(agent);
  if (quote.mode !== "live" || !config.active || !config.markets.includes(quote.symbol)) return;
  if (desk.settlements?.some(item => item.symbol === quote.symbol)) return;
  const newest = desk.snapshots.findLast(item => item.mode === "live" && item.symbol === quote.symbol);
  if (newest && newest.at > quote.at) return;
  if (hasRun(desk, agent, quote)) return;
  const previous = desk.decisions.findLast(item => item.agent === agent.id && item.snapshot.mode === "live" &&
    item.snapshot.symbol === quote.symbol && item.version === config.number && !item.researchPurchase);
  const stopOnly = scheduled ? config.auto !== true : config.auto === false;
  if (stopOnly && !positionMark(desk, agent, quote)?.triggered) return;
  const base = evaluateRun(config, quote, signal(desk, quote));
  return recordRun(desk, agent, quote, base.proposal, base.source, stopOnly, decision => {
    if (!previous) return true;
    const stop = decision.tools.some(tool => tool.name === "stop_loss");
    const previousStop = previous.tools.some(tool => tool.name === "stop_loss");
    // Overlapping collectors should not liquidate twice on the same stop mark.
    const repeatedStop = previousStop && previous.snapshot.bid === quote.bid && previous.snapshot.ask === quote.ask &&
      Date.parse(quote.at) - Date.parse(previous.snapshot.at) < 15_000;
    return decision.action !== previous.action || decision.resource !== previous.resource ||
      decision.validation?.find(stage => !stage.ok)?.name !== previous.validation?.find(stage => !stage.ok)?.name ||
      stop !== previousStop || (stop && !!decision.fill && !repeatedStop);
  });
}

export function runLiveDesk(desk: Desk, quotes: Snapshot[]) {
  let runs = 0;
  for (const agent of desk.agents) {
    for (const quote of quotes) if (liveDecision(desk, agent, quote)) runs++;
  }
  return runs;
}

export async function runScheduledDesk(desk: Desk, quotes: Snapshot[]) {
  const agents = desk.agents.filter(agent => latest(agent).active &&
    (latest(agent).auto || latest(agent).stopLossPct !== undefined));
  if (!agents.length) return 0;
  const relevant = quotes.filter(quote => quote.mode === "live" && agents.some(agent => latest(agent).markets.includes(quote.symbol)));
  keepRecentQuotes(desk, relevant.filter(quote => !desk.snapshots.some(saved => saved.mode === "live" &&
    saved.symbol === quote.symbol && saved.at === quote.at)));
  let runs = 0;
  for (const agent of agents) {
    for (const quote of relevant) {
      const config = latest(agent);
      if (!config.markets.includes(quote.symbol)) continue;
      if (config.auto && !hasRun(desk, agent, quote)) await trainAgent(agent, quote.symbol, false, true);
      const decision = liveDecision(desk, agent, quote, true);
      if (!decision) continue;
      if (config.auto) queueAnchor(decision, latest(agent));
      runs++;
    }
  }
  return runs;
}

export function runAutopilot(quotes: Snapshot[]) {
  return transact("operator", desk => runScheduledDesk(desk, quotes));
}
