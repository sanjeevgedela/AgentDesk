import { parseInstructions } from "../../lib/policy";
import type { TrainingRecord } from "../../lib/training";

export function Sparkline({ values, label, baseline, accent = "#79ebbc" }: { values: number[]; label: string; baseline?: number[]; accent?: string }) {
  if (values.length < 2) return null;
  const all = [...values, ...(baseline ?? [])];
  const low = Math.min(...all);
  const range = Math.max(1, Math.max(...all) - low);
  const points = (items: number[]) => items.map((value, index) =>
    `${4 + index * 232 / Math.max(1, items.length - 1)},${51 - (value - low) * 46 / range}`).join(" ");
  return <svg className="mini-chart" viewBox="0 0 240 56" role="img" aria-label={label} preserveAspectRatio="none">
    {baseline && <polyline points={points(baseline)} fill="none" stroke="#a99ce9" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
    <polyline points={points(values)} fill="none" stroke={accent} strokeWidth="1.7" vectorEffect="non-scaling-stroke" />
  </svg>;
}
export function TrainingPanel({ training }: { training: TrainingRecord }) {
  const { report, dataset, appliedVersion } = training;
  const moving = report.learning.map((_, index) => {
    const range = report.learning.slice(Math.max(0, index - 9), index + 1);
    return range.reduce((sum, value) => sum + value, 0) / range.length;
  });
  return <details className="training-panel">
    <summary>{dataset.synthetic ? "SYNTHETIC training" : "Recorded-market training"} · {appliedVersion ? `Promoted v${appliedVersion}` : "Kept incumbent"}</summary>
    <small>{dataset.symbol} · {dataset.bars} observations</small>
    <code className="data-hash" title="Dataset SHA-256">{dataset.hash}</code>
    <p>Episode P&L and 10-episode average · cents</p>
    <Sparkline values={report.learning} baseline={moving} label="Training rewards and moving average" />
    <dl>
      <div><dt>Incumbent holdout P&L</dt><dd>{report.incumbent.pnl}¢</dd></div>
      <div><dt>Candidate holdout P&L</dt><dd>{report.trial.pnl}¢</dd></div>
      <div><dt>Paired delta 90% CI</dt><dd>[{report.ci.join(", ")}]¢</dd></div>
    </dl>
    <p>Posterior probability of a profitable episode</p>
    {report.arms.map(arm => <div className="posterior" key={`${arm.threshold}/${arm.positionLimit}`}>
      <span>{arm.threshold}¢ / {arm.positionLimit}</span><meter min={0} max={1} value={arm.mean} aria-label={`Threshold ${arm.threshold} cents, position limit ${arm.positionLimit}`} />
      <small>{(arm.mean * 100).toFixed(0)}%</small>
    </div>)}
  </details>;
}
export function PolicyPreview({ instructions }: { instructions: string }) {
  const rules = parseInstructions(instructions);
  const restrictions = [
    rules.hold ? "Always hold" : undefined,
    rules.maxBuyPrice === undefined ? undefined : `Buy at or below ${rules.maxBuyPrice}¢`,
    rules.minSellPrice === undefined ? undefined : `Sell at or above ${rules.minSellPrice}¢`,
    rules.maxSpread === undefined ? undefined : `Spread ≤ ${rules.maxSpread}¢`,
    rules.maxQty === undefined ? undefined : `At most ${rules.maxQty} contracts`,
  ].filter(Boolean);
  if (!restrictions.length && !rules.unrecognized.length) return null;
  return <div className="policy-preview" aria-live="polite">
    {restrictions.map(item => <span key={item} className="pill">{item}</span>)}
    {rules.unrecognized.length > 0 && <small>Unrecognized as executable policy: {rules.unrecognized.join("; ")}</small>}
  </div>;
}
