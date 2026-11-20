import type { Proposal, Snapshot } from "./engine";

const condition = /^(buy|sell|hold) (?:when|if) (?:the )?(yes(?: price)?|midpoint|ask|bid|spread) (?:is |falls |rises )?(below|above|at most|at least|exceeds) (\d{1,2}(?:\.\d+)?)\s*(?:¢|cents?)?$/i;

export function evaluateInstructions(text: string, quote: Snapshot) {
  const notes: string[] = [];
  let matched: Proposal | undefined;
  for (const raw of text.split(/[\n;]+/)) {
    const line = raw.trim().replace(/\.$/, "");
    if (!line) continue;
    if (/^(?:always hold|hold|never trade)$/i.test(line)) {
      matched = { action: "hold", reason: "Instruction matched: " + line };
      continue;
    }
    const rule = condition.exec(line);
    if (!rule) {
      notes.push(line);
      continue;
    }
    const [, action, field, comparison, value] = rule.map(part => part.toLowerCase());
    const observed = field === "ask" ? quote.ask : field === "bid" ? quote.bid
      : field === "spread" ? quote.ask - quote.bid : (quote.ask + quote.bid) / 2;
    const limit = Number(value);
    const matches = comparison === "below" ? observed < limit : comparison === "at most" ? observed <= limit
      : comparison === "at least" ? observed >= limit : observed > limit;
    if (matches && (!matched || action === "hold")) {
      matched = { action: action as Proposal["action"], reason: `Instruction matched: ${line} (observed ${observed}¢).` };
    }
  }
  return { matched, notes };
}
