import type { Proposal, Snapshot } from "./engine";

export type Policy = { hold: boolean; maxBuyPrice?: number; minSellPrice?: number; maxSpread?: number; maxQty?: number; unrecognized: string[] };

export function parseInstructions(text: string): Policy {
  const policy: Policy = { hold: false, unrecognized: [] };
  for (const raw of text.split(/[;\n]/)) {
    const line = raw.trim().replace(/\.$/, "");
    if (!line) continue;
    if (/^(always hold|never trade|hold)$/i.test(line)) { policy.hold = true; continue; }
    const max = /^(max buy price|max spread|max quantity|max contracts|min sell price)\s*(?:is|=|:)?\s*(\d{1,3})\s*(?:¢|cents?)?$/i.exec(line);
    const hold = /^hold if (?:the )?spread exceeds (\d{1,2})\s*(?:¢|cents?)?$/i.exec(line);
    const maximum = (current: number | undefined, value: number) => Math.min(current ?? value, value);
    if (hold) { policy.maxSpread = maximum(policy.maxSpread, Number(hold[1])); continue; }
    if (max) {
      const value = Number(max[2]);
      switch (max[1].toLowerCase()) {
        case "max buy price": policy.maxBuyPrice = maximum(policy.maxBuyPrice, value); break;
        case "min sell price": policy.minSellPrice = Math.max(policy.minSellPrice ?? 0, value); break;
        case "max spread": policy.maxSpread = maximum(policy.maxSpread, value); break;
        default: policy.maxQty = maximum(policy.maxQty, value);
      }
      continue;
    }
    if (!/^(buy|sell|hold) (when|if) /i.test(line)) policy.unrecognized.push(line);
  }
  return policy;
}

export function guard(proposal: Proposal, snapshot: Snapshot, policy: Policy) {
  const reasons: string[] = [];
  if (policy.hold && (proposal.action !== "hold" || proposal.resource)) reasons.push("Always hold policy");
  if (proposal.action === "buy" && policy.maxBuyPrice !== undefined && snapshot.ask > policy.maxBuyPrice)
    reasons.push(`Ask ${snapshot.ask}¢ exceeds maximum buy price ${policy.maxBuyPrice}¢`);
  if (proposal.action === "sell" && policy.minSellPrice !== undefined && snapshot.bid < policy.minSellPrice)
    reasons.push(`Bid ${snapshot.bid}¢ is below minimum sell price ${policy.minSellPrice}¢`);
  if ((proposal.action !== "hold" || proposal.resource) && policy.maxSpread !== undefined && snapshot.ask - snapshot.bid > policy.maxSpread)
    reasons.push(`Spread exceeds ${policy.maxSpread}¢`);
  return { proposal: reasons.length ? { action: "hold" as const, reason: reasons.join(". ") } : proposal, reasons };
}
