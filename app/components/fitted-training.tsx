"use client";

import { useState, type FormEvent } from "react";
import { featureNames, fitConfig, type FitConfig, type FittedModel } from "../../lib/fitted";
import { Sparkline } from "./training";

export function FittedTraining({ models, active, busy, canFit, operator, fit, activate }: {
  models: FittedModel[]; active?: string; busy: boolean; canFit: boolean; operator: boolean;
  fit: (config: FitConfig, synthetic: boolean) => Promise<void>; activate: (id: string) => Promise<void>;
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
    <p>Active predictive model: {active ?? "None · strategy rules only"}</p>
    {chosen && <>
      <label>Saved models<select aria-label="Saved models" value={chosen.id} onChange={event => setSelection(event.target.value)}>
        {models.map(model => <option key={model.id} value={model.id}>{model.id} · {model.symbol} · {model.synthetic ? "SYNTHETIC" : "recorded"} · Validation MAE {model.artifact.validation.mae.toFixed(2)}¢</option>)}
      </select></label>
      <small>{chosen.bars.length} observations · {chosen.bars[0].at} to {chosen.bars.at(-1)?.at}</small>
      <code className="data-hash" title="Dataset SHA-256">{chosen.datasetHash}</code>
      <p>Target: future midpoint change over {chosen.artifact.config.horizon} observations.</p>
      <p>Validation MAE {chosen.artifact.validation.mae.toFixed(2)}¢ · Final test MAE {chosen.artifact.test.mae.toFixed(2)}¢ · Zero-move test baseline {chosen.artifact.test.zeroMoveMae.toFixed(2)}¢</p>
      <p>Validation starts {chosen.artifact.split.validationFrom} · Test starts {chosen.artifact.split.testFrom}</p>
      {chosen.backtest && <><p>Held-out paper equity · {chosen.backtest.trades} fills · {chosen.backtest.pnl.toFixed(2)}¢ P&L · {chosen.backtest.fees}¢ fees</p>
        <Sparkline values={chosen.backtest.equity} label="Held-out equity" />
        <p>Drawdown (¢)</p><Sparkline values={chosen.backtest.drawdown} label="Held-out drawdown" /></>}
      <details><summary>Inspect saved quotes and coefficients</summary>
        <a href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(chosen, null, 2))}`} download={`agentdesk-model-${chosen.id}.json`}>Download fitted artifact and dataset</a>
        <pre className="data-hash">{JSON.stringify(chosen.bars.slice(0, 3), null, 2)}</pre>
      </details>
      {operator && <button className="quiet" disabled={busy || active === chosen.id} onClick={async () => {
        setError("");
        try { await activate(chosen.id); setStatus("The selected artifact is active."); }
        catch (err) { setError(err instanceof Error ? err.message : "Activation failed."); }
      }}>
        {active === chosen.id ? "Model active" : "Activate model"}
      </button>}
    </>}
  </div>;
}
