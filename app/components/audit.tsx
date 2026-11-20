import type { Decision } from "../../lib/engine";
import type { Stage } from "../../lib/validate";

export function ValidationSteps({ stages }: { stages?: Stage[] }) {
  if (!stages?.length) return null;
  return <ol className="validation-steps" aria-label="Validation stages">
    {stages.map((stage, i) => <li key={stage.name + i} className={stage.ok ? "passed" : "failed"} title={stage.detail}>
      <strong>{stage.ok ? "✓" : "×"} {stage.name}</strong>
      {!stage.ok && <span>{stage.detail}</span>}
    </li>)}
  </ol>;
}
export function DecisionAudit({ decision, busy, verify }: { decision: Decision; busy: boolean; verify: () => void }) {
  const policy = decision.tools.find(tool => tool.name === "policy_guard");
  const anchor = decision.anchor;
  return <>
    <ValidationSteps stages={decision.validation} />
    {policy && <small>Policy · {policy.result}</small>}
    {decision.researchPurchase && <p><a href={"#purchase-" + decision.researchPurchase}>Quote review</a>
      {decision.followUpOf && <> · <a href={"#decision-" + decision.followUpOf}>Original decision</a></>}</p>}
    {anchor && <div className="audit-actions">
      <span className={anchor.status === "mismatch" ? "audit-error" : "empty"}>{anchor.status === "mismatch" ? "TAMPERED" : `Memo ${anchor.status}`}</span>
      {anchor.signature && <>
        <a href={`https://explorer.solana.com/tx/${anchor.signature}?cluster=devnet`} target="_blank" rel="noreferrer">Explorer ↗</a>
        <button className="quiet" disabled={busy} onClick={verify}>Verify memo</button>
      </>}
      {anchor.detail && <small>{anchor.detail}</small>}
    </div>}
  </>;
}
