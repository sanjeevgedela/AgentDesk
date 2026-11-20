import { keepRecentQuotes, latest, signal, type Snapshot } from "./engine";
import { evaluateRun, recordRun } from "./runner";
import { trainAgent } from "./training";
import { queueAnchor } from "./anchor-queue";
import { transact } from "./store";
export async function runAutopilot(quotes: Snapshot[]) {
  return transact("operator", async desk => {
    const agents = desk.agents.filter(agent => latest(agent).active && latest(agent).auto);
    if (!agents.length) return 0;
    const relevant = quotes.filter(quote => agents.some(agent => latest(agent).markets.includes(quote.symbol)));
    const observations = relevant.map(quote => ({ ...quote, id: quote.symbol + "/" + quote.at }));
    keepRecentQuotes(desk, observations.filter(quote => !desk.snapshots.some(saved => saved.symbol === quote.symbol && saved.at === quote.at)));
    let runs = 0;
    for (const agent of agents) {
      for (const quote of observations) {
        let version = latest(agent);
        if (!version.markets.includes(quote.symbol)) continue;
        await trainAgent(agent, quote.symbol, false, true);
        version = latest(agent);
        if (desk.decisions.some(d => d.agent === agent.id && d.version === version.number &&
            d.snapshot.symbol === quote.symbol && d.snapshot.at === quote.at && !d.researchPurchase)) continue;
        const { proposal, source } = evaluateRun(version, quote, signal(desk, quote));
        queueAnchor(recordRun(desk, agent, quote, proposal, source), version);
        runs++;
      }
    }
    return runs;
  });
}

