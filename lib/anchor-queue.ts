import { AnchorSimulationError, anchorDecision, anchorEnabled, verifyAnchor } from "./anchor";
import { sha256 } from "./canonical";
import type { Decision, Version } from "./engine";
import { parseInstructions } from "./policy";
import { transact } from "./store";

export function queueAnchor(decision: Decision, version: Version) {
  if (anchorEnabled()) decision.anchor = { status: "pending", updated: 0, attempts: 0, policyHash: sha256(parseInstructions(version.instructions)) };
}
export async function processAnchors(id?: string) {
  const claimed = await transact("operator", desk => {
    const now = Date.now();
    const selected = desk.decisions.filter(d => (!id || id === d.id) && d.anchor?.status === "pending" &&
      d.anchor.attempts < 5 && now - d.anchor.updated >= 60_000).slice(0, id ? 1 : 5);
    return selected.map(decision => {
      const anchor = decision.anchor!;
      anchor.updated = now;
      anchor.attempts++;
      const version = desk.agents.find(agent => agent.id === decision.agent)?.versions.find(v => v.number === decision.version);
      return { decision, policy: parseInstructions(version?.instructions ?? "") };
    });
  });
  for (const { decision, policy } of claimed) {
    const anchor = decision.anchor!;
    try {
      const result = anchor.signature ? await verifyAnchor(decision, anchor.signature) : await anchorDecision(decision, policy, signature =>
        transact("operator", desk => {
          desk.decisions.find(d => d.id === decision.id)!.anchor!.signature = signature;
        }));
      await transact("operator", desk => {
        const saved = desk.decisions.find(d => d.id === decision.id)!;
        if (result.state === "uncertain") {
          if (anchor.attempts >= 5) saved.anchor!.detail = "Automatic confirmation attempts exhausted. Verify the signature manually.";
          return;
        }
        saved.anchor!.status = result.state;
        if ("slot" in result) saved.anchor!.slot = result.slot;
        saved.validation?.push({ name: "reconcile", ok: result.state === "confirmed", detail: "Memo verification: " + result.state, at: new Date().toISOString() });
      });
    } catch (err) {
      await transact("operator", desk => {
        const saved = desk.decisions.find(d => d.id === decision.id)!;
        if (err instanceof AnchorSimulationError) {
          saved.anchor!.status = "failed";
          saved.validation?.push({ name: "simulate", ok: false, detail: err.message, at: new Date().toISOString() });
        } else if (anchor.attempts >= 5 && !saved.anchor!.signature) {
          saved.anchor!.status = "failed";
          saved.anchor!.detail = "Memo submission attempts exhausted.";
        }
      });
    }
  }
  return claimed.length;
}
