"use client";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { currentSnapshot, dollars, latest, PRICE, reserved, strategies, usdc, type Agent, type Config, type Decision, type Desk } from "../lib/engine";

type Payload = { desk?: Desk; auth?: boolean; voice?: boolean; model?: boolean; decision?: Decision; reused?: boolean; answer?: string; signedUrl?: string; error?: string };
type Action = Record<string, unknown> & { kind: string };
const money = (value: FormDataEntryValue | null) => Math.round(Number(value) * 1_000_000);
const date = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const suggestions = ["Why did the agents disagree?", "How much research did each agent buy?", "What changed between strategy versions?"];

export default function Dashboard() {
  return <ConversationProvider><DeskView /></ConversationProvider>;
}

function DeskView() {
  const [desk, setDesk] = useState<Desk>();
  const [token, setToken] = useState("");
  const [auth, setAuth] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [model, setModel] = useState(false);
  const [running, setRunning] = useState("");
  const [runIssue, setRunIssue] = useState<{ agent: string; message: string }>();
  const [runResult, setRunResult] = useState<{ id: string; reused: boolean }>();
  const [operation, setBusy] = useState("");
  const busy = operation || running;
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Agent | "new">();
  const [addMarket, setAddMarket] = useState(false);
  const [funding, setFunding] = useState<Agent>();
  const [unlock, setUnlock] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<{ question: string; answer: string }[]>([]);

  const request = useCallback(async (action?: Action, secret = token): Promise<Payload> => {
    const headers: Record<string, string> = {};
    if (secret) headers.authorization = "Bearer " + secret;
    if (action) headers["content-type"] = "application/json";
    const response = await fetch("/api/desk", { headers, cache: "no-store", method: action ? "POST" : "GET", body: action && JSON.stringify(action) });
    const payload = await response.json() as Payload;
    if (!response.ok) throw new Error(payload.error || "AgentDesk could not complete the request.");
    if (payload.desk) setDesk(payload.desk);
    if (payload.auth !== undefined) setAuth(payload.auth);
    if (payload.model !== undefined) setModel(payload.model);
    if (payload.voice !== undefined) setVoiceAvailable(payload.voice);
    return payload;
  }, [token]);

  useEffect(() => {
    const timer = window.setTimeout(() => request().catch(err => setError(err.message)), 0);
    return () => window.clearTimeout(timer);
  }, [request]);

  async function perform(label: string, operation: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try { await operation(); }
    catch (err) { setError(err instanceof Error ? err.message : "The request failed."); }
    finally { setBusy(""); }
  }
  const act = (label: string, action: Action) => perform(label, () => request(action));

  async function run(agent: Agent) {
    setRunning(agent.id);
    setRunIssue(undefined);
    setRunResult(undefined);
    try {
      const result = await request({ kind: "run", id: agent.id });
      if (!result.decision) throw new Error("No decision was returned. Refresh and try again.");
      setRunResult({ id: result.decision.id, reused: !!result.reused });
    } catch (err) {
      setRunIssue({ agent: agent.id, message: err instanceof Error ? err.message : "Run failed. Try again." });
    } finally {
      setRunning("");
    }
  }

  const voice = useConversation({
    onError: () => setError("ElevenLabs could not continue the session. Check microphone and agent setup."),
    clientTools: {
      desk_query: async ({ question }: { question: string }) => (await request({ kind: "ask", question })).answer ?? "No records.",
      propose_budget: async ({ agent_name, per_purchase_usdc, total_usdc }: { agent_name: string; per_purchase_usdc: number; total_usdc: number }) => {
        const agent = desk?.agents.find(a => latest(a).name.toLowerCase() === agent_name.trim().toLowerCase());
        if (!agent) return "Agent name not found.";
        await request({ kind: "propose", id: agent.id, cap: Math.round(per_purchase_usdc * 1_000_000), budget: Math.round(total_usdc * 1_000_000) });
        return "Proposal displayed. The operator must confirm it in AgentDesk.";
      },
    },
  });
  const talking = voice.status === "connected";
  const snapshot = desk && currentSnapshot(desk);
  const markets = desk ? [...new Map(desk.snapshots.filter(s => s.mode === desk.mode).map(s => [s.symbol, s])).values()] : [];
  const series = desk?.snapshots.filter(s => s.symbol === desk.selected && s.mode === desk.mode).slice(-16) ?? [];
  const points = series.map((s, i) => `${series.length === 1 ? 400 : 12 + 776 * i / (series.length - 1)},${165 - (s.bid + s.ask) * .75}`).join(" ");
  const valuation = (a: Agent) => a.cash + Object.entries(a.positions).reduce((sum, [symbol, qty]) => {
    const mark = desk?.snapshots.findLast(s => s.symbol === symbol);
    return sum + (mark ? qty * (mark.bid + mark.ask) / 2 : 0);
  }, 0);
  const active = desk?.agents.filter(a => latest(a).active).length ?? 0;
  const settled = desk?.purchases.filter(p => p.status === (auth ? "confirmed" : "simulated")).reduce((s, p) => s + p.amount, 0) ?? 0;
  const eligible = desk?.agents.filter(a => latest(a).active && snapshot && latest(a).markets.includes(snapshot.symbol)) ?? [];
  const reviewDecision = desk?.decisions.findLast(d => d.resource && d.snapshot.id === snapshot?.id &&
    eligible.some(a => a.id === d.agent && latest(a).number === d.version));
  const demoPurchase = desk?.purchases.findLast(p => p.decision === reviewDecision?.id);
  const demoProposal = desk?.changes.find(c => c.agent === reviewDecision?.agent);
  const reviewAgent = eligible.find(a => a.id === reviewDecision?.agent);
  const requiredBudget = desk && reviewAgent ? reserved(desk, reviewAgent.id) + PRICE : PRICE;
  const needsBudget = !!reviewAgent && (reviewAgent.cap < PRICE || reviewAgent.budget < requiredBudget);
  const applied = desk?.decisions.find(d => d.researchPurchase && d.researchPurchase === demoPurchase?.id);
  const reviewed = demoPurchase?.status === "simulated";
  const demoStage = reviewed ? applied || demoPurchase.after === "hold" ? 4 : 3 : demoPurchase ? 2 : reviewDecision ? 1 : 0;

  function nextDemoStep() {
    if (!reviewDecision) return act("Running replay strategies", { kind: "demo-run" });
    if (reviewed && demoPurchase) {
      if (applied || demoPurchase.after === "hold") {
        location.hash = "supervisor";
        return ask("Did the quote review change the recommendation?");
      }
      return act("Applying paper recommendation", { kind: "apply-review", id: demoPurchase.id });
    }
    const agent = eligible.find(a => a.id === reviewDecision.agent);
    if (!agent) return;
    if (demoProposal) return act("Confirming demo budget", { kind: "confirm", id: demoProposal.id });
    if (demoPurchase?.status === "blocked" && needsBudget) {
      if (requiredBudget > 10_000_000) { setFunding(agent); return; }
      return act("Proposing a new demo cap", { kind: "propose", id: agent.id, cap: Math.max(agent.cap, PRICE), budget: Math.max(agent.budget, requiredBudget) });
    }
    return act("Running quote review", { kind: "buy", id: agent.id, decision: reviewDecision.id, requestId: crypto.randomUUID() });
  }

  const demoLabel = demoStage === 0 ? "Run replay agents" : demoStage === 1 ? "Request quote review"
    : demoStage === 3 ? "Apply paper order" : demoStage === 4 ? "Ask the supervisor"
    : demoProposal ? "Confirm demo budget" : needsBudget
      ? "Propose higher limit" : "Retry quote review";

  const demoDetail = demoProposal ? `Proposed cap ${usdc(demoProposal.cap)} · Total budget ${usdc(demoProposal.budget)}`
    : applied?.fill ? `Paper fill recorded · ${applied.fill.quantity} YES at ${applied.fill.price}¢`
    : applied ? applied.policy
    : reviewed ? `Quote review complete · Recommendation: ${demoPurchase.before} → ${demoPurchase.after}`
    : demoPurchase?.status === "blocked" && !needsBudget ? "Budget approved. Retry the quote review to continue."
    : demoPurchase ? demoPurchase.reason
    : reviewDecision ? "Agent decisions saved. A quote review is ready to request."
    : "Paper trades and research payments are simulated.";

  function ask(text: string) {
    setQuestion("");
    return perform("Asking supervisor", async () => {
      const response = await request({ kind: "ask", question: text });
      setMessages(old => [...old, { question: text, answer: response.answer ?? "No matching records." }]);
    });
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const config = { name: data.get("name"), strategy: data.get("strategy"), instructions: data.get("instructions"),
      threshold: Number(data.get("threshold")), positionLimit: Number(data.get("limit")),
      markets: String(data.get("markets")).split(",").map(s => s.trim()).filter(Boolean), active: data.has("active") };
    return perform("Saving strategy", async () => {
      await request({ kind: "save", config, id: editing === "new" ? undefined : editing?.id });
      setEditing(undefined);
    });
  }
  const initial: Partial<Config> = editing && editing !== "new" ? latest(editing) : {};
  return <div className="shell">
    <aside className="rail">
      <a className="brand" href="#overview"><span className="brandmark" aria-hidden="true"><span className="trend-glyph" /></span><span>AgentDesk<small>Trading workspace</small></span></a>
      <nav aria-label="Workspace"><a href="#overview"><span>◫</span> Overview</a><a href="#agents"><span>◇</span> Agents</a><a href="#activity"><span>≋</span> Decisions</a><a href="#research"><span>◈</span> Research</a><a href="#supervisor"><span>◉</span> Supervisor</a></nav>
      <div className="rail-note"><span className="pulse" /> Paper trading<br /><small>{auth ? "Solana devnet · Test USDC" : "Simulated research payments"}</small></div>
    </aside>
    <main id="overview">
      <header className="topbar"><span className="workspace-label"><span className="pulse" />{auth ? "Operator workspace" : "Demo workspace"} <small>{model ? "· Model available" : "· Rules mode"}</small></span><button className="quiet" disabled={!!busy} onClick={() => auth ? perform("Locking workspace", async () => {
        if (talking) await voice.endSession();
        setMessages([]);
        setRunResult(undefined);
        setRunIssue(undefined);
        setToken("");
        await request(undefined, "");
      }) : setUnlock(true)}>{auth ? "Return to demo" : "Operator access"}</button></header>
      <div className="canvas">
        <section className="headline"><div><h1>Trading desk</h1><p>Compare strategies, inspect paper fills, and review research decisions.</p></div><div className="modes" aria-label="Data mode">
          <button aria-pressed={desk?.mode === "replay"} disabled={!desk || !!busy} onClick={() => act("Opening replay", { kind: "mode", mode: "replay" })}>Replay</button>
          <button aria-pressed={desk?.mode === "live"} disabled={!desk || !!busy} onClick={() => act("Loading Gemini", { kind: "mode", mode: "live" })}>Live Gemini</button>
        </div></section>
        {error && <div role="alert" className="alert">{error} <button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
        {operation && <div role="status" className="status">{operation}…</div>}
        {!desk && <div className="panel loading">{error ? <button onClick={() => perform("Loading workspace", () => request())}>Retry loading workspace</button> : "Loading your workspace…"}</div>}
        {desk && <>
          {!auth && desk.mode === "replay" && <section className="demo-hero" aria-labelledby="demo-title">
            <div className="demo-copy">
              <p className="demo-kicker"><span className="pulse" /> Interactive demo</p>
              <h2 id="demo-title">From market signal<br />to paper trade.</h2>
              <p>Run the agents on the same quote, see a research budget block a purchase, then approve a new limit and compare the result.</p>
              <div className="demo-actions">
                <button className="primary" disabled={!!busy} onClick={nextDemoStep}>{demoLabel} <span aria-hidden="true">→</span></button>
                <a href="#agents">Explore agents</a>
              </div>
              <small aria-live="polite">{demoDetail}</small>
            </div>
            <ol className="demo-steps" aria-label="Demo progress">
              {["Evaluate the market", "Request research", "Review the spending limit", "Apply the paper decision"].map((label, index) =>
                <li key={label} aria-current={demoStage === index ? "step" : undefined}>
                  <span aria-hidden="true">{demoStage > index ? "✓" : index + 1}</span>
                  <strong>{label}</strong>
                  <small>{demoStage > index ? "Done" : demoStage === index ? "Up next" : ""}</small>
                </li>
              )}
            </ol>
          </section>}

          <section className="metrics" aria-label="Portfolio summary">
            <div className="panel metric"><span>Paper equity</span><strong>{dollars(desk.agents.reduce((sum, a) => sum + valuation(a), 0))}</strong><small>Across {desk.agents.length} independent portfolios</small></div>
            <div className="panel metric"><span>Active agents</span><strong>{active}<em> / {desk.agents.length}</em></strong><small>{desk.decisions.length} recorded decisions</small></div>
            <div className="panel metric"><span>{auth ? "Settled research" : "Demo research spend"}</span><strong>{usdc(settled)}</strong><small>{auth ? "Confirmed devnet test payments" : "Simulated USDC"}</small></div>
          </section>
          <section className="panel market">
            <div className="section-head"><div><span className="eyebrow">{desk.mode === "replay" ? "SYNTHETIC REPLAY" : "GEMINI PREDICTION MARKETS"}</span><h2>{snapshot?.title || "Market snapshot"}</h2></div>
              {desk.mode === "replay" ? <button className="quiet" disabled={!!busy || desk.replay >= 5} onClick={() => act("Advancing replay", { kind: "advance" })}>{desk.replay >= 5 ? "Replay complete" : "Next snapshot →"}</button>
                : <button className="quiet" disabled={!!busy} onClick={() => act("Refreshing Gemini", { kind: "mode", mode: "live" })}>Refresh quotes</button>}</div>
            {desk.mode === "live" && <label className="select-market">Market<select disabled={!!busy} value={desk.selected} onChange={e => act("Selecting market", { kind: "select", symbol: e.target.value })}>{markets.map(s => <option key={s.symbol} value={s.symbol}>{s.title}</option>)}</select></label>}
            {snapshot && <><div className="quote"><strong>{((snapshot.bid + snapshot.ask) / 2).toFixed(1)}¢</strong><span>YES midpoint</span><span>Bid {snapshot.bid}¢</span><span>Ask {snapshot.ask}¢</span></div>
              <svg className="chart" viewBox="0 0 800 175" preserveAspectRatio="none" role="img" aria-label="Observed YES midpoint history">
                <defs><linearGradient id="chart-fill" x2="0" y2="1" gradientUnits="objectBoundingBox"><stop stopColor="#206650" stopOpacity=".65"/><stop offset="1" stopColor="#206650" stopOpacity=".05"/></linearGradient></defs>
                {[24, 60, 96, 132, 168].map(y => <path key={y} d={`M 0 ${y} H 800`} stroke="#263638" strokeDasharray="4 5" />)}
                {series.length > 1 ? <><polygon points={`12,168 ${points} 788,168`} fill="url(#chart-fill)" /><polyline points={points} fill="none" stroke="#73efbd" strokeWidth="3" vectorEffect="non-scaling-stroke" /></> : <circle cx="400" cy={165 - (snapshot.bid + snapshot.ask) * .75} r="5" fill="#73efbd" />}
              </svg>
              <div className="market-foot"><span>{snapshot.symbol}</span><span>Observed {date(snapshot.at)}</span></div>
            </>}
          </section>
          <section id="agents"><div className="section-head"><h2>Agents</h2><button className="primary" onClick={() => { setAddMarket(true); setEditing("new"); }}>+ New agent</button></div>
            <div className="agents">{desk.agents.map((agent, i) => {
              const config = latest(agent);
              const decision = desk.decisions.findLast(d => d.agent === agent.id);
              const currentDecision = desk.decisions.findLast(d => d.agent === agent.id && d.snapshot.id === snapshot?.id && d.version === config.number && !d.researchPurchase);
              const latestRun = decision?.id === runResult?.id ? decision : currentDecision;
              const needsMarket = snapshot && !config.markets.includes(snapshot.symbol);
              const runSource = latestRun?.tools.at(-1)?.name;
              const sourceLabel = runSource === "model_interpretation" ? "AI interpretation" : runSource === "saved_instruction" ? "Saved instruction" : runSource === "strategy_rule" ? "Strategy rule" : runSource === "confirmed_research" || runSource === "simulated_research" ? "Quote review" : "Safety hold";
              return <article className="panel agent" key={agent.id}>
                <div className="agent-top"><span className={`agent-icon tone-${i % 3}`}>{i % 3 === 0 ? <span className="trend-glyph" /> : ["⇄", "◇"][i % 3 - 1]}</span><span className={`pill ${config.active ? "good" : ""}`}>{config.active ? "Active" : "Paused"}</span></div>
                <h3>{config.name}</h3><p>{config.strategy} · v{config.number}</p>
                <dl><div><dt>Paper equity</dt><dd>{dollars(valuation(agent))}</dd></div><div><dt>Research cap</dt><dd>{usdc(agent.cap)}</dd></div><div><dt>Open contracts</dt><dd>{Object.values(agent.positions).reduce((a, b) => a + b, 0)}</dd></div></dl>
                <div className="agent-actions">
                  <button className="primary" disabled={!!busy || !config.active || !snapshot || !!needsMarket} onClick={() => currentDecision ? (location.hash = "decision-" + currentDecision.id) : void run(agent)}>
                    {running === agent.id ? "Evaluating…" : currentDecision ? "View current run" : "Run agent"}
                  </button>
                  <button className="quiet" disabled={!!busy} onClick={() => { setAddMarket(!!needsMarket); setEditing(agent); }}>{needsMarket ? "Edit allowed markets" : "Edit"}</button>
                  <button className="quiet" disabled={!!busy} onClick={() => setFunding(agent)}>Budget</button>
                </div>
                {needsMarket && <p className="run-note">Add {snapshot.symbol} to this agent’s allowed markets.</p>}
                {runIssue?.agent === agent.id && <p className="run-note run-error" role="alert">{runIssue.message}</p>}
                {latestRun && <div className="run-result" aria-live="polite">
                  <div className="entry-head"><span className={`pill action-${latestRun.action}`}>{latestRun.action}</span><small>{sourceLabel}</small></div>
                  <p>{latestRun.reason}</p>
                  <small>{latestRun.fill ? `Filled ${latestRun.fill.quantity} YES at ${latestRun.fill.price}¢` : latestRun.policy}</small>
                  <a href={"#decision-" + latestRun.id}>{runResult?.id === latestRun.id && runResult.reused ? "Open saved decision" : "View decision"} →</a>
                </div>}
                {decision?.resource && <button className="research-link" disabled={!!busy} title={auth ? "Requests 0.25 devnet USDC" : "Simulates spending 0.25 USDC"} onClick={() => act("Requesting quote review", { kind: "buy", id: agent.id, decision: decision.id, requestId: crypto.randomUUID() })}>{auth ? "Buy quote review" : "Simulate quote review"} · 0.25 USDC</button>}
              </article>;
            })}</div>
          </section>
          <div className="details">
            <section className="panel feed" id="activity"><h2>Decision log</h2>
              {!desk.decisions.length && <p className="empty">Run an agent to record its signal, recommendation and simulated fill.</p>}
              {[...desk.decisions].reverse().map(d => <article id={"decision-" + d.id} key={d.id}><div className="entry-head"><strong>{desk.agents.find(a => a.id === d.agent)?.versions.find(v => v.number === d.version)?.name}</strong><span className="pill">{d.action}</span></div><small>{d.snapshot.symbol} · v{d.version} · {date(d.at)}</small><p>{d.reason} {d.policy}</p>{d.fill && <small>{d.fill.quantity} YES at {d.fill.price}¢ · {d.fill.fee}¢ simulated fee</small>}</article>)}
            </section>
            <section className="panel feed" id="research"><h2>Research payments</h2>
              <p className="empty">{auth ? "Verified quote reviews use Solana devnet test USDC." : "Simulated payments allow you to test budgets, review quotes, and apply paper orders."}</p>
              {desk.changes.map(c => <article key={c.id}><strong>Budget change pending</strong><p>{desk.agents.find(a => a.id === c.agent)?.versions.at(-1)?.name} · cap {usdc(c.cap)} · total {usdc(c.budget)}</p><button className="primary" disabled={!!busy} onClick={() => act("Confirming spending authority", { kind: "confirm", id: c.id })}>Confirm budget change</button></article>)}
              {[...desk.purchases].reverse().map(p => <article id={"purchase-" + p.id} key={p.id}><div className="entry-head"><strong>Quote quality review</strong><span className={`pill ${["confirmed", "simulated"].includes(p.status) ? "good" : ""}`}>{p.status}</span></div><small>{usdc(p.amount)} · {date(p.at)} · <a href={"#decision-" + p.decision}>Decision</a></small><p>{p.reason}</p>{p.after && <p>Recommendation: {p.before} → {p.after}. {p.evidence}</p>}
                {(p.status === "confirmed" || p.status === "simulated") && p.after && p.after !== "hold" &&
                  (desk.decisions.find(d => d.researchPurchase === p.id)
                    ? <p><a href={"#decision-" + desk.decisions.find(d => d.researchPurchase === p.id)?.id}>Applied paper decision</a></p>
                    : <button className="quiet" disabled={!!busy} onClick={() => act("Applying paper recommendation", { kind: "apply-review", id: p.id })}>Apply as paper order</button>)}
                {p.signature && <a href={`https://explorer.solana.com/tx/${p.signature}?cluster=devnet`} target="_blank" rel="noreferrer">View Solana devnet receipt ↗</a>}
                {["uncertain","pending"].includes(p.status) && <button className="quiet" disabled={!!busy || !auth} onClick={() => act("Checking Solana", { kind: "reconcile", id: p.id })}>Check settlement</button>}</article>)}
            </section>
          </div>
          <section className="panel feed" id="supervisor"><div className="section-head"><div><h2>Supervisor</h2><p className="empty">Answers are generated from saved decisions, positions and research records.</p></div>
            <button className="quiet" disabled={!!busy || (!talking && (!auth || !voiceAvailable))} onClick={() => perform(talking ? "Ending call" : "Connecting ElevenLabs", async () => {
              if (talking) await voice.endSession();
              else {
                const { signedUrl } = await request({ kind: "voice" });
                if (!signedUrl) throw new Error("No signed session was returned.");
                await voice.startSession({ signedUrl, connectionType: "websocket" });
              }
            })}>{talking ? (voice.isSpeaking ? "Speaking · End call" : "Listening · End call") : "◉ Start voice"}</button></div>
            {!talking && (!auth || !voiceAvailable) && <small className="empty">{auth ? "ElevenLabs voice requires server configuration." : "Text supervisor is available in the demo. Connect ElevenLabs in the operator workspace."}</small>}
            <div className="suggestions">{suggestions.map(s => <button className="quiet" key={s} disabled={!!busy} onClick={() => ask(s)}>{s}</button>)}</div>
            <div className="messages" aria-live="polite">{messages.map((m, i) => <article key={i}><strong>{m.question}</strong><p>{m.answer.split(/(\[(?:[0-9a-f]{8}-){1}[0-9a-f-]{27}\])/g).map((part, j) => {
              if (!part.startsWith("[") || !part.endsWith("]")) return part;
              const id = part.slice(1, -1);
              const kind = desk.purchases.some(p => p.id === id) ? "purchase" : "decision";
              return <a key={j} href={`#${kind}-${id}`}>[{id.slice(0, 8)}]</a>;
            })}</p></article>)}</div>
            <form className="chat" onSubmit={e => { e.preventDefault(); if (question.trim()) void ask(question); }}><input value={question} maxLength={600} onChange={e => setQuestion(e.target.value)} placeholder="Ask the supervisor…" aria-label="Question" /><button className="primary" disabled={!question.trim() || !!busy}>Send</button></form>
          </section>
        </>}
      </div>
    </main>
    {unlock && <div className="overlay"><form className="panel dialog" onSubmit={e => {
      e.preventDefault();
      const secret = String(new FormData(e.currentTarget).get("secret")).trim();
      void perform("Checking operator access", async () => { await request(undefined, secret); setMessages([]); setToken(secret); setUnlock(false); });
    }}><h2>Unlock operator workspace</h2><p>Use the operator token configured on your server to access budget confirmations, devnet spending and voice.</p>
      {error && <p role="alert" className="alert">{error}</p>}
      <label>Operator token<input name="secret" type="password" autoComplete="off" required /></label><div className="dialog-actions"><button type="button" className="quiet" onClick={() => setUnlock(false)}>Cancel</button><button className="primary" disabled={!!busy}>Unlock</button></div></form></div>}
    {editing && <div className="overlay"><form className="panel dialog" onSubmit={save}><h2>{editing === "new" ? "New trading agent" : "Edit strategy"}</h2>
      {error && <p role="alert" className="alert">{error}</p>}
      <label>Name<input name="name" defaultValue={initial.name} maxLength={60} required /></label>
      <label>Strategy<select name="strategy" defaultValue={initial.strategy}>{strategies.map(s => <option key={s}>{s}</option>)}</select></label>
      <label>Strategy instructions<textarea name="instructions" defaultValue={initial.instructions} maxLength={2000} rows={3} placeholder={"Hold if spread exceeds 5¢\nBuy when ask is below 40¢"} /></label>
      <small>Use one rule per line. Examples include “Always hold” and “Buy when YES falls below 40¢.” Matching holds take priority. Other instructions require AI.</small>
      <label>Allowed market symbols<input name="markets" defaultValue={[...new Set([...(initial.markets ?? []), ...(addMarket && snapshot ? [snapshot.symbol] : [])])].join(", ")} required /></label>
      {snapshot && <small className="empty">Selected market: {snapshot.symbol}</small>}
      <div className="form-grid"><label>Signal threshold (¢)<input name="threshold" type="number" min={1} max={40} defaultValue={initial.threshold ?? 3} required /></label><label>Position limit<input name="limit" type="number" min={1} max={1000} defaultValue={initial.positionLimit ?? 25} required /></label></div>
      <label className="check"><input name="active" type="checkbox" defaultChecked={initial.active ?? true} /> Active</label>
      <div className="dialog-actions"><button type="button" className="quiet" onClick={() => setEditing(undefined)}>Cancel</button><button className="primary" disabled={!!busy}>Save strategy</button></div></form></div>}
    {funding && <div className="overlay"><form className="panel dialog" onSubmit={e => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      void perform("Proposing budget", async () => {
        await request({ kind: "propose", id: funding.id, cap: money(data.get("cap")), budget: money(data.get("budget")) });
        setFunding(undefined);
        location.hash = "research";
      });
    }}><h2>{latest(funding).name} research budget</h2><p>Devnet test USDC. Review the proposed change in Research before confirming it.</p>
      {error && <p role="alert" className="alert">{error}</p>}
      <label>Per-purchase cap<input type="number" name="cap" step=".01" min="0" max="10" defaultValue={funding.cap / 1e6} required /></label>
      <label>Total budget<input type="number" name="budget" step=".01" min="0" max="10" defaultValue={funding.budget / 1e6} required /></label>
      <div className="dialog-actions"><button type="button" className="quiet" onClick={() => setFunding(undefined)}>Cancel</button><button className="primary" disabled={!!busy}>Propose change</button></div></form></div>}
  </div>;
}
