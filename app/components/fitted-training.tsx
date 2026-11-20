"use client";

import { useState, type FormEvent } from "react";
import { featureNames, fitConfig, type FitConfig, type FittedModel } from "../../lib/fitted";
import { BacktestInspector, TrainingChat } from "./backtest-inspector";
import { Sparkline } from "./training";
import { RecordedPlayback } from "./recorded-playback";

export function FittedTraining({ models, active, demo, busy, canFit, operator, fit, activate, ask }: {
  models: FittedModel[]; active?: string; demo?: boolean; busy: boolean; canFit: boolean; operator: boolean;
  fit: (config: FitConfig, synthetic: boolean) => Promise<void>; activate: (id: string) => Promise<void>;
  ask: (question: string, modelId?: string) => Promise<string>;
}) {
  const [selection, setSelection] = useState("");
  const chosen = models.find(model => model.id === selection) ?? models.at(-1);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = fitConfig.safeParse({ features: data.getAll("features"), horizon: Number(data.get("horizon")), ridge: Number(data.get("ridge")),
      from: data.get("from") || undefined, to: data.get("to") || undefined });
    if (!parsed.success) { setError("Select features and valid dates, horizon and ridge strength."); return; }
    setError("");
    setSelection("");
    setStatus("Fitting the model and measuring held-out results…");
    try {
      await fit(parsed.data, data.get("dataset") === "synthetic");
      setStatus("Fitted artifact saved. Review the results before activation.");
    } catch (err) {
      setStatus("");
      setError(err instanceof Error ? err.message : "Model fitting failed.");
    }
  }
  return <div className="training-panel">
    {operator && <form onSubmit={submit} className="form-grid">
      <label>Dataset<select name="dataset" aria-label="Dataset"><option value="recorded">Recorded quotes for the selected market</option><option value="synthetic">SYNTHETIC fixture</option></select></label>
      <label>Target<select aria-label="Prediction target"><option>Future midpoint change (¢)</option></select></label>
      <label>From (UTC)<input type="date" name="from" /></label>
      <label>Through (UTC)<input type="date" name="to" /></label>
      <label>Horizon (observations)<input name="horizon" type="number" min={1} max={10} defaultValue={1} required /></label>
      <label>Ridge strength<input name="ridge" type="number" min=".001" max="100" step=".001" defaultValue=".1" required /></label>
      <fieldset><legend>Model features</legend>{featureNames.map(name => <label className="check" key={name}>
        <input type="checkbox" name="features" value={name} defaultChecked /> {name.replace("_", " ")}
      </label>)}</fieldset>
      <button className="primary" disabled={busy || !canFit}>Fit forecast model</button>

    </form>}
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    <p>Active predictive model: {active ?? "Automatic forecasts must beat the validation baseline"}</p>
    {!chosen && demo && <FitComparison baseline={4} fit={2.8} example />}
    {chosen && demo && <details><summary>View an illustrative positive result</summary><FitComparison baseline={4} fit={2.8} example /></details>}
    {chosen && <>
      <label>Saved models<select aria-label="Saved models" value={chosen.id} onChange={event => setSelection(event.target.value)}>
        {models.map(model => <option key={model.id} value={model.id}>{model.id} · {model.symbol} · {model.synthetic ? "SYNTHETIC" : "recorded"} · Validation MAE {model.artifact.validation.mae.toFixed(2)}¢</option>)}
      </select></label>
      <small>{chosen.bars.length} observations · {chosen.bars[0].at} to {chosen.bars.at(-1)?.at}</small>
      <code className="data-hash" title="Dataset SHA-256">{chosen.datasetHash}</code>
      {chosen.execution && <p>{chosen.execution.strategy} · {chosen.execution.threshold}¢ signal threshold · {chosen.execution.positionLimit}-contract position limit{chosen.execution.stopLossPct ? ` · ${chosen.execution.stopLossPct}% stop-loss` : ""}</p>}
      <p>Target: future midpoint change over {chosen.artifact.config.horizon} observations.</p>
      <FitComparison baseline={chosen.artifact.test.zeroMoveMae} fit={chosen.artifact.test.mae} />
      <p>Validation MAE {chosen.artifact.validation.mae.toFixed(2)}¢ · Final test MAE {chosen.artifact.test.mae.toFixed(2)}¢ · Zero-move test baseline {chosen.artifact.test.zeroMoveMae.toFixed(2)}¢</p>
      {chosen.artifact.loss && <div>
        <p>Scikit-learn stochastic gradient descent · {chosen.artifact.loss.length} epochs · mean squared training loss {chosen.artifact.loss[0].toFixed(2)} → {chosen.artifact.loss.at(-1)!.toFixed(2)}</p>
        <Sparkline values={chosen.artifact.loss} label="Mean squared loss by training epoch" />
        <small>{chosen.artifact.validation.mae < chosen.artifact.validation.zeroMoveMae ? "Passed the zero-move validation baseline." : "Below the promotion threshold. Strategy rules remain available."}</small>
      </div>}
      <p>Validation starts {chosen.artifact.split.validationFrom} · Test starts {chosen.artifact.split.testFrom}</p>
      {chosen.backtest && <><p>Held-out paper equity · {chosen.backtest.trades} fills · {chosen.backtest.pnl.toFixed(2)}¢ P&L · {chosen.backtest.fees}¢ fees</p>
        {chosen.backtest.baseline && <p>Strategy rules without a fitted forecast · {chosen.backtest.baseline.pnl.toFixed(2)}¢ P&amp;L · {chosen.backtest.baseline.trades} fills · dashed line</p>}
        <Sparkline values={chosen.backtest.equity} baseline={chosen.backtest.baseline?.equity} label="Held-out equity" />
        <p>Drawdown (¢)</p><Sparkline values={chosen.backtest.drawdown} label="Held-out drawdown" /></>}
      <RecordedPlayback key={chosen.id} quotes={chosen.bars} start={Math.max(1, chosen.bars.findIndex(bar => bar.at >= chosen.artifact.split.testFrom))} />
      <details><summary>Inspect saved quotes and coefficients</summary>
        <a href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(chosen, null, 2))}`} download={`agentdesk-model-${chosen.id}.json`}>Download fitted artifact and dataset</a>
        <BacktestInspector key={chosen.id} model={chosen} />
      </details>
      {operator && <button className="quiet" disabled={busy || active === chosen.id} onClick={async () => {
        setError("");
        try { await activate(chosen.id); setStatus("The selected artifact is active."); }
        catch (err) { setError(err instanceof Error ? err.message : "Activation failed."); }
      }}>
        {active === chosen.id ? "Model active" : "Activate model"}
      </button>}
    </>}
    <TrainingChat key={chosen?.id ?? "no-model"} modelId={chosen?.id} ask={ask} />
  </div>;
}

function FitComparison({ baseline, fit, example = false }: { baseline: number; fit: number; example?: boolean }) {
  const max = Math.max(baseline, fit, 0.01);
  const ratio = baseline > 0 ? fit / baseline : undefined;
  return <figure className="fit-comparison">
    <figcaption>{example ? "Illustrative demo result · sample numbers" : "Forecast vs. no model on held-out quotes"}</figcaption>
    <small>Mean absolute error in cents · lower is better</small>
    <div><span>No model · {baseline.toFixed(2)}¢</span><meter aria-label="No model forecast error" min="0" max={max} value={baseline} /></div>
    <div><span>Fitted · {fit.toFixed(2)}¢</span><meter aria-label="Fitted forecast error" min="0" max={max} value={fit} /></div>
    <strong>{ratio === undefined ? "Fit ratio unavailable · baseline error is zero"
      : `Fit / no-model error: ${ratio.toFixed(2)}× · ${Math.abs(1 - ratio).toLocaleString(undefined, { style: "percent" })} ${ratio <= 1 ? "less" : "more"} error`}</strong>
  </figure>;
}
