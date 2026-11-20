"use client";

import { useState, type FormEvent } from "react";
import { dollars } from "../../lib/engine";
import type { FittedModel } from "../../lib/fitted";

const pageSize = 12;
type View = "training" | "validation" | "test" | "decisions";
export function BacktestInspector({ model }: { model: FittedModel }) {
  const [view, setView] = useState<View>("training");
  const [page, setPage] = useState(0);
  const rows = model.backtest?.rows ?? [];
  const { split, config } = model.artifact;
  const quotes = model.bars.flatMap((bar, i) => {
    if (!i || !model.bars[i + config.horizon]) return [];
    const label = model.bars[i + config.horizon];
    const belongs = view === "training" ? label.at < split.validationFrom
      : view === "validation" ? bar.at > split.validationFrom && label.at < split.testFrom
      : bar.at > split.testFrom;
    const midpoint = (bar.bid + bar.ask) / 2;
    return belongs ? [{ ...bar, midpoint, target: (label.bid + label.ask) / 2 - midpoint }] : [];
  });
  const count = view === "decisions" ? rows.length : quotes.length;
  const pages = Math.ceil(count / pageSize);
  return <div className="backtest-inspector">
    <label>Inspect backtest data<select aria-label="Inspect backtest data" value={view} onChange={event => { setView(event.target.value as View); setPage(0); }}>
      <option value="training">Training examples</option><option value="validation">Validation examples</option>
      <option value="test">Final test examples</option><option value="decisions">Paper decisions and fills</option>
    </select></label>
    {count === 0 ? <p className="empty">{view === "decisions" ? "No decision rows saved for this artifact. Refit to capture them." : "No examples in this split."}</p>
      : <div className="backtest-table-wrap" tabIndex={0} role="region" aria-label="Saved backtest rows">
        {view === "decisions" ? <table className="backtest-table">
          <thead><tr><th scope="col">Observed at (UTC)</th><th scope="col">Action</th><th scope="col">Paper fill</th><th scope="col">Open YES</th><th scope="col">Paper equity</th><th scope="col">Reason</th></tr></thead>
          <tbody>{rows.slice(page * pageSize, (page + 1) * pageSize).map(row => <tr key={row.at}>
            <td>{row.at}</td><td>{row.action}</td><td>{row.fill ? `${row.fill.quantity} at ${row.fill.price}¢` : "—"}</td><td>{row.position}</td>
            <td>{dollars(row.equity)}</td><td>{row.reason} {row.policy}{row.researchRequested ? " Research requested." : ""}</td>
          </tr>)}</tbody>
        </table> : <table className="backtest-table">
          <thead><tr><th scope="col">Observed at (UTC)</th><th scope="col">Bid</th><th scope="col">Ask</th><th scope="col">Midpoint</th><th scope="col">Observed target · {config.horizon} ahead</th></tr></thead>
          <tbody>{quotes.slice(page * pageSize, (page + 1) * pageSize).map(row => <tr key={row.at}>
            <td>{row.at}</td><td>{row.bid}¢</td><td>{row.ask}¢</td><td>{row.midpoint}¢</td><td>{row.target}¢</td>
          </tr>)}</tbody>
        </table>}
      </div>}
    {pages > 1 && <div className="backtest-pages">
      <button type="button" className="quiet" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous rows</button>
      <small>Page {page + 1} of {pages} · {count} rows</small>
      <button type="button" className="quiet" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next rows</button>
    </div>}
  </div>;
}

export function TrainingChat({ modelId, ask }: { modelId?: string; ask: (question: string, modelId?: string) => Promise<string> }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<{ question: string; answer: string }[]>([]);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    setQuestion("");
    setBusy(true);
    try {
      const answer = await ask(text, modelId);
      setMessages(old => [...old, { question: text, answer }].slice(-10));
    } catch (error) {
      const answer = error instanceof Error ? error.message : "The training records are unavailable.";
      setMessages(old => [...old, { question: text, answer }].slice(-10));
    } finally { setBusy(false); }
  }
  return <section className="training-chat" aria-label="Training assistant">
    <h3>Training assistant</h3>
    <p className="empty">Ask about this model’s data, strategy, or held-out results.</p>
    <div className="messages" aria-live="polite">{messages.map((message, i) => <article key={i}><strong>{message.question}</strong><p>{message.answer}</p></article>)}</div>
    <form className="chat" onSubmit={submit}>
      <input aria-label="Training question" placeholder="How did this strategy perform?" maxLength={600} value={question} onChange={event => setQuestion(event.target.value)} />
      <button className="primary" disabled={busy || !question.trim()}>{busy ? "Reading…" : "Ask"}</button>
    </form>
  </section>;
}
