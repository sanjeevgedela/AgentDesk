"use client";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { DecisionAudit, ValidationSteps } from "./components/audit";
import { FittedTraining } from "./components/fitted-training";
import { PagedFeed } from "./components/paged-feed";
import { MarketChart, type QuotePoint } from "./components/market-chart";
import { PolicyPreview, Sparkline, TrainingPanel } from "./components/training";
import { agentStats, currentSnapshot, INITIAL_CASH, dollars, positionMark, latest, strategies, usdc, type Agent, type Config, type Decision, type Desk } from "../lib/engine";

type Payload = { runs?: number; refreshed?: boolean; proof?: { state: string }; desk?: Desk; auth?: boolean; operatorAccess?: boolean; voice?: boolean; model?: boolean; decision?: Decision; reused?: boolean; answer?: string; signedUrl?: string; error?: string };
type Action = Record<string, unknown> & { kind: string };
const LIVE_REFRESH_MS = 500;
const money = (value: FormDataEntryValue | null) => Math.round(Number(value) * 1_000_000);
const date = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const historySchema = z.object({ backfill: z.object({ status: z.enum(["available", "unavailable", "empty"]), source: z.string(), points: z.array(z.object({ at: z.iso.datetime(), cents: z.number() })) }).optional(), bars: z.array(z.object({ bid: z.number().int(), ask: z.number().int(), at: z.iso.datetime() })), hash: z.string().regex(/^[0-9a-f]{64}$/) });
const suggestions = ["Why did the agents disagree?", "How much research did each agent buy?", "What changed between strategy versions?"];

export default function Dashboard() {
  return <ConversationProvider><DeskView /></ConversationProvider>;
}

function DeskView() {
  const [desk, setDesk] = useState<Desk>();
  const [token, setToken] = useState("");
  const [auth, setAuth] = useState(false);
  const [operatorAccess, setOperatorAccess] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [model, setModel] = useState(false);
  const [running, setRunning] = useState("");
  const [runIssue, setRunIssue] = useState<{ agent: string; message: string }>();
  const [runResult, setRunResult] = useState<{ id: string; reused: boolean }>();
  const [operation, setBusy] = useState("");
  const busy = operation || running;
  const [error, setError] = useState("");
  const [instructions, setInstructions] = useState("");
  const [history, setHistory] = useState<{ symbol: string; count: number; hash: string; quotes: QuotePoint[]; backfill?: z.infer<typeof historySchema>["backfill"] }>();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [quoteRefreshing, setQuoteRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");
  const [trainingAgent, setTrainingAgent] = useState("");
  const [editing, setEditing] = useState<Agent | "new">();
  const [addMarket, setAddMarket] = useState(false);
  const [funding, setFunding] = useState<Agent>();
  const [unlock, setUnlock] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<{ question: string; answer: string }[]>([]);

  const visibleWorkspace = useRef({ token: "", revision: -1 });
  const request = useCallback(async (action?: Action, switchTo?: string): Promise<Payload> => {
    const secret = switchTo ?? token;
    const headers: Record<string, string> = {};
    if (secret) headers.authorization = "Bearer " + secret;
    if (action) headers["content-type"] = "application/json";
    const response = await fetch("/api/desk", { headers, cache: "no-store", method: action ? "POST" : "GET", body: action && JSON.stringify(action) });
    const payload = await response.json() as Payload;
    if (!response.ok) throw new Error(payload.error || "AgentDesk could not complete the request.");

    if (switchTo !== undefined && secret !== visibleWorkspace.current.token) {
      visibleWorkspace.current = { token: secret, revision: -1 };
    }
    if (secret !== visibleWorkspace.current.token) return payload;
    if (payload.desk) {
      const revision = payload.desk.revision ?? 0;
      if (revision < visibleWorkspace.current.revision) return payload;
      visibleWorkspace.current.revision = revision;
      setDesk(payload.desk);
    }
    if (payload.auth !== undefined) setAuth(payload.auth);
    if (payload.operatorAccess !== undefined) setOperatorAccess(payload.operatorAccess);
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

  // Client tools are registered once per session, so read the latest desk and request through refs.
  const deskRef = useRef<Desk>(undefined);
  const requestRef = useRef(request);
  useEffect(() => { deskRef.current = desk; requestRef.current = request; });
  const voice = useConversation({
    onError: (message: string) => setError(`ElevenLabs session error: ${message || "check microphone and agent setup."}`),
    onDisconnect: details => {
      if (details?.reason === "error") setError(`ElevenLabs call ended: ${details.message || "connection lost."}`);
    },
    clientTools: {
      // Tool failures are returned as text so the voice agent can explain them instead of going silent.
      desk_query: async ({ question }: { question: string }) => {
        try { return (await requestRef.current({ kind: "ask", question: String(question ?? "").slice(0, 600) })).answer ?? "No records."; }
        catch (err) { return "AgentDesk could not read the records: " + (err instanceof Error ? err.message : "request failed."); }
      },
      propose_budget: async ({ agent_name, per_purchase_usdc, total_usdc }: { agent_name: string; per_purchase_usdc: number; total_usdc: number }) => {
        try {
          const agent = deskRef.current?.agents.find(a => latest(a).name.toLowerCase() === String(agent_name).trim().toLowerCase());
          if (!agent) return "Agent name not found. Known agents: " + (deskRef.current?.agents.map(a => latest(a).name).join(", ") || "none") + ".";
          await requestRef.current({ kind: "propose", id: agent.id, cap: Math.round(Number(per_purchase_usdc) * 1_000_000), budget: Math.round(Number(total_usdc) * 1_000_000) });
          return "Proposal displayed. The operator must confirm it in AgentDesk.";
        } catch (err) { return "The proposal was rejected: " + (err instanceof Error ? err.message : "invalid limits."); }
      },
    },
  });
  const talking = voice.status === "connected";
  const snapshot = desk && currentSnapshot(desk);
  const liveSymbol = snapshot?.mode === "live" ? snapshot.symbol : undefined;
  useEffect(() => {
    if (!liveSymbol) return;
    const controller = new AbortController();
    let loading = false;
    const loadHistory = () => {
      if (loading || document.visibilityState !== "visible") return;
      loading = true;
      void fetch(`/api/history?symbol=${encodeURIComponent(liveSymbol)}&limit=5000`, { signal: controller.signal })
        .then(response => response.ok ? response.json() : Promise.reject(new Error("History unavailable")))
        .then(raw => {
          const parsed = historySchema.parse(raw);
          if (!controller.signal.aborted) {
            setHistory({ symbol: liveSymbol, count: parsed.bars.length, hash: parsed.hash, quotes: parsed.bars, backfill: parsed.backfill });
          }
        }).catch(() => {}).finally(() => { loading = false; });
    };
    loadHistory();
    const timer = window.setInterval(loadHistory, 10_000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [liveSymbol]);
  const markets = desk ? [...new Map(desk.snapshots.filter(s => s.mode === desk.mode).map(s => [s.symbol, s])).values()]
    .sort((a, b) => a.title.localeCompare(b.title) || a.symbol.localeCompare(b.symbol)) : [];
  const matchingHistory = desk?.mode === "live" && history?.symbol === desk.selected ? history : undefined;
  const series = desk?.snapshots.filter(s => s.symbol === desk.selected && s.mode === desk.mode) ?? [];
  const chartQuotes = [...new Map([...(matchingHistory?.quotes ?? []), ...series].map(item => [item.at, item])).values()]
    .sort((a, b) => a.at.localeCompare(b.at));
  const selectedTrainingAgent = desk?.agents.find(agent => agent.id === trainingAgent) ?? desk?.agents[0];
  const trainingCount = matchingHistory?.count ?? 0;
  const allowedToTrain = !!snapshot && !!selectedTrainingAgent && latest(selectedTrainingAgent).markets.includes(snapshot.symbol);
  const live = desk?.mode === "live";
  const pollInFlight = useRef<Promise<void> | null>(null);

  const refreshQuotes = useCallback((manual = false) => {
    if (manual) setQuoteRefreshing(true);
    if (pollInFlight.current) return pollInFlight.current;
    const pending = request({ kind: "refresh-live" })
      .then(result => setRefreshMessage(result.refreshed ? "" : "No fresh quote for this market. Showing its last observed mark."))
      .catch(() => setRefreshMessage("Live update unavailable. Showing the last observed mark."))
      .finally(() => {
        pollInFlight.current = null;
        setQuoteRefreshing(false);
      });
    pollInFlight.current = pending;
    return pending;
  }, [request]);

  useEffect(() => {
    if (!autoRefresh || !live) return;
    let stopped = false;
    let timer: number | undefined;
    const schedule = (delay = LIVE_REFRESH_MS) => {
      window.clearTimeout(timer);
      if (!stopped && document.visibilityState === "visible") timer = window.setTimeout(refresh, delay);
    };
    const refresh = async () => {
      const started = performance.now();
      await refreshQuotes();
      schedule(Math.max(0, LIVE_REFRESH_MS - (performance.now() - started)));
    };
    const visible = () => schedule();
    schedule();
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [autoRefresh, live, refreshQuotes]);
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
  const applied = desk?.decisions.find(d => d.researchPurchase && d.researchPurchase === demoPurchase?.id);
  const reviewed = demoPurchase?.status === "simulated";
  const demoStage = reviewed ? applied || demoPurchase.after === "hold" ? 3 : 2 : reviewDecision ? 1 : 0;

  function nextDemoStep() {
    if (!reviewDecision) return act("Running replay strategies", { kind: "demo-run" });
    if (reviewed && demoPurchase) {
      if (applied || demoPurchase.after === "hold") {
        location.hash = "supervisor";
        return ask("Did the quote review change the recommendation?");
      }
      return act("Applying paper recommendation", { kind: "apply-review", id: demoPurchase.id });
    }
    return act("Running quote review", { kind: "buy", id: reviewDecision.agent, decision: reviewDecision.id, requestId: crypto.randomUUID() });
  }

  const demoLabel = ["Run replay agents", "Request quote review", "Apply paper order", "Ask the supervisor"][demoStage];
  const demoDetail = applied?.fill ? `Paper fill recorded · ${applied.fill.quantity} YES at ${applied.fill.price}¢`
    : applied ? applied.policy
    : reviewed ? `Quote review complete · Recommendation: ${demoPurchase.before} → ${demoPurchase.after}`
    : reviewDecision ? "Agent decisions saved. Request a quote review to continue."
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
    const markets = String(data.get("markets")).split(",").map(s => s.trim()).filter(Boolean);
    const previousMarkets = editing && editing !== "new" ? latest(editing).markets : undefined;
    const marketsChanged = !previousMarkets || markets.length !== previousMarkets.length || markets.some((market, i) => market !== previousMarkets[i]);
    const config = { name: data.get("name"), strategy: data.get("strategy"), instructions: data.get("instructions"),
      threshold: Number(data.get("threshold")), positionLimit: Number(data.get("limit")),
      stopLossPct: data.get("stopLoss") ? Number(data.get("stopLoss")) : undefined,
      auto: data.has("auto"), markets: marketsChanged ? markets : undefined, active: data.has("active") };
    return perform("Saving strategy", async () => {
      await request({ kind: "save", config, id: editing === "new" ? undefined : editing?.id });
      setEditing(undefined);
    });
  }
  const initial: Partial<Config> = editing && editing !== "new" ? latest(editing) : {};
  return <div className="shell">
    <aside className="rail">
      <a className="brand" href="#overview"><span className="brandmark" aria-hidden="true"><span className="trend-glyph" /></span><span>AgentDesk<small>Trading workspace</small></span></a>
      <nav aria-label="Workspace"><a href="#overview"><span>◫</span> Overview</a><a href="#agents"><span>◇</span> Agents</a><a href="#training"><span>▦</span> Training</a><a href="#activity"><span>≋</span> Decisions</a><a href="#research"><span>◈</span> Research</a><a href="#supervisor"><span>◉</span> Supervisor</a></nav>
      <div className="rail-note"><span className="pulse" /> Paper trading<br /><small>{auth ? "Solana devnet · Test USDC" : "Simulated research payments"}</small></div>
    </aside>
    <main id="overview">
      <header className="topbar"><span className="workspace-label"><span className="pulse" />{auth ? "Operator workspace" : "Demo workspace"} <small>{model ? "· Model available" : "· Rules mode"}</small></span>{(operatorAccess || auth) && <button className="quiet" disabled={!!busy} onClick={() => auth ? perform("Locking workspace", async () => {
        if (talking) await voice.endSession();
        setMessages([]);
        setRunResult(undefined);
        setRunIssue(undefined);
        setToken("");
        await request(undefined, "");
      }) : setUnlock(true)}>{auth ? "Return to demo" : "Operator access"}</button>}</header>
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
              <p>Run the agents on the same quote, request a simulated review, and see how new evidence changes the paper decision.</p>
              <div className="demo-actions">
                <button className="primary" disabled={!!busy} onClick={nextDemoStep}>{demoLabel} <span aria-hidden="true">→</span></button>
                <a href="#agents">Explore agents</a>
              </div>
              <small aria-live="polite">{demoDetail}</small>
            </div>
            <ol className="demo-steps" aria-label="Demo progress">
              {["Evaluate the market", "Request research", "Apply the paper decision"].map((label, index) =>
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
                : <button className="quiet" disabled={quoteRefreshing} onClick={() => void refreshQuotes(true)}>{quoteRefreshing ? "Refreshing quotes…" : "Refresh quotes"}</button>}</div>
            {desk.mode === "live" && <label className="select-market">Market<select disabled={!!busy} value={desk.selected} onChange={e => act("Selecting market", { kind: "select", symbol: e.target.value })}>{markets.map(s => <option key={s.symbol} value={s.symbol}>{s.title}</option>)}</select></label>}
            {snapshot && <><div className="quote"><strong>{((snapshot.bid + snapshot.ask) / 2).toFixed(1)}¢</strong><span>YES midpoint</span><span>Bid {snapshot.bid}¢</span><span>Ask {snapshot.ask}¢</span></div>
              <MarketChart key={snapshot.symbol} quotes={chartQuotes} signals={desk.decisions
                .filter(decision => decision.snapshot.symbol === snapshot.symbol && decision.snapshot.mode === snapshot.mode)
                .slice(-40).map(decision => ({ id: decision.id, at: decision.snapshot.at,
                  label: `${decision.action} ${decision.fill ? "paper fill" : "decision"}${decision.forecast ? ` · forecast ${decision.forecast.change.toFixed(2)}¢ / ${decision.forecast.horizon} observations` : ""}` }))} />
              <div className="market-foot"><span>{snapshot.symbol}</span><span>Latest observed {date(snapshot.at)}</span></div>
              {snapshot.mode === "live" && chartQuotes.length > 0 && <small>
                Chart coverage {date(chartQuotes[0].at)} – {date(chartQuotes[chartQuotes.length - 1].at)} · Gemini recorded bid/ask.
                {Date.parse(chartQuotes[chartQuotes.length - 1].at) - Date.parse(chartQuotes[0].at) < 432_000_000 && " Five-day history is not available for this chart."}
                {chartQuotes.some((quote, i) => i > 0 && Date.parse(quote.at) - Date.parse(chartQuotes[i - 1].at) > 600_000) && " Gaps over 10 minutes are present."}
              </small>}
              {snapshot.mode === "live" && <div className="history-mini live-controls">
                <label className="check"><input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} /> Refresh live quotes every 0.5 seconds</label>
                <small>Automatic runs appear when the decision changes. Configured stop-losses are checked on fresh quotes.</small>
                <small>{matchingHistory ? `${matchingHistory.count} recent recorded observations · SHA-256 ${matchingHistory.hash.slice(0, 12)}…` : "Loading recorded history…"}</small>
                {matchingHistory?.backfill && <small>
                  {matchingHistory.backfill.status === "empty" ? "Gemini returned no contract price history for backfill."
                    : matchingHistory.backfill.status === "unavailable" ? "Gemini history lookup unavailable. Any cached prices are shown below."
                    : "Gemini historical contract prices, separate from bid/ask observations."}
                </small>}
                {!!matchingHistory?.backfill?.points.length && <>
                  <small>{date(matchingHistory.backfill.points[0].at)} – {date(matchingHistory.backfill.points.at(-1)!.at)}</small>
                  <Sparkline values={matchingHistory.backfill.points.map(point => point.cents)} label="Gemini historical contract prices" />
                </>}
                {refreshMessage && <p role="status">{refreshMessage}</p>}
              </div>}
            </>}
          </section>
          <section id="agents"><div className="section-head"><h2>Agents</h2><button className="primary" onClick={() => { setAddMarket(true); setInstructions(""); setEditing("new"); }}>+ New agent</button></div>
            <div className="agents">{desk.agents.map((agent, i) => {
              const config = latest(agent);
              const decision = desk.decisions.findLast(d => d.agent === agent.id);
              const latestRun = snapshot && desk.decisions.findLast(item => item.agent === agent.id &&
                item.snapshot.mode === snapshot.mode && item.snapshot.symbol === snapshot.symbol);
              const stats = agentStats(desk, agent);
              const mark = snapshot && positionMark(desk, agent, snapshot);
              const marketDecisions = desk.decisions.filter(item => item.agent === agent.id && item.snapshot.symbol === snapshot?.symbol && item.equityAfter !== undefined);
              const firstAsk = marketDecisions[0]?.snapshot.ask;
              const baseline = firstAsk === undefined ? [] : marketDecisions.map(item => INITIAL_CASH - firstAsk - 1 + (item.snapshot.bid + item.snapshot.ask) / 2);
              const needsMarket = snapshot && !config.markets.includes(snapshot.symbol);
              const runSource = latestRun?.tools.findLast(tool => tool.name !== "policy_guard")?.name;
              const sourceLabel = runSource === "fitted_model" ? "Fitted model" : runSource === "stop_loss" ? "Stop-loss" : runSource === "model_interpretation" ? "AI interpretation" : runSource === "saved_instruction" ? "Saved instruction" : runSource === "strategy_rule" ? "Strategy rule" : runSource === "paid_research" || runSource === "confirmed_research" || runSource === "simulated_research" ? "Quote review" : "Safety hold";
              return <article className="panel agent" key={agent.id}>
                <div className="agent-top"><span className={`agent-icon tone-${i % 3}`}>{i % 3 === 0 ? <span className="trend-glyph" /> : ["⇄", "◇"][i % 3 - 1]}</span><span className={`pill ${config.active ? "good" : ""}`}>{config.active ? "Active" : "Paused"}</span></div>
                <h3>{config.name}</h3><p>{config.strategy} · v{config.number}</p>
                <dl><div><dt>Paper equity</dt><dd>{dollars(stats.equity)}</dd></div><div><dt>Paper P&L</dt><dd>{dollars(stats.pnl)}</dd></div>{auth && <div><dt>Research cap</dt><dd>{usdc(agent.cap)}</dd></div>}<div><dt>Open contracts</dt><dd>{Object.values(agent.positions).reduce((a, b) => a + b, 0)}</dd></div></dl>
                <div className="agent-actions">
                  <button className="primary" disabled={!!busy || running === agent.id || !config.active || !snapshot || !!needsMarket} onClick={() => void run(agent)}>
                    {running === agent.id ? "Evaluating…" : latestRun?.version === config.number ? "Run again" : "Run agent"}
                  </button>
                  <button className="quiet" disabled={!!busy} onClick={() => { setAddMarket(!!needsMarket); setInstructions(config.instructions); setEditing(agent); }}>{needsMarket ? "Edit allowed markets" : "Edit"}</button>
                  {auth && <button className="quiet" disabled={!!busy} onClick={() => setFunding(agent)}>Budget</button>}
                  <a className="quiet" href="#training" onClick={() => setTrainingAgent(agent.id)}>Training</a>
                </div>
                {marketDecisions.length > 1 && <div className="equity-panel">
                  <small>Paper equity · dashed: hold one YES</small>
                  <Sparkline values={marketDecisions.map(item => item.equityAfter!)} baseline={baseline} label="Paper equity versus buy-and-hold benchmark" />
                </div>}
                {mark && <dl>
                  <div><dt>Entry / current bid</dt><dd>{mark.entry.toFixed(2)}¢ / {snapshot?.bid}¢</dd></div>
                  <div><dt>P&L at bid, before fees</dt><dd>{dollars(mark.unrealized)}</dd></div>
                  {mark.stop !== undefined && <div><dt>Stop-loss trigger</dt><dd>{mark.stop.toFixed(2)}¢{mark.triggered ? " · reached" : ""}</dd></div>}
                </dl>}
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
          <section className="panel training-desk" id="training" aria-labelledby="training-heading">
            <div className="section-head">
              <div><span className="eyebrow">Strategy research</span><h2 id="training-heading">Agent training</h2><p className="empty">Tune entry thresholds and position limits, then compare the candidate with the current strategy on held-out quotes.</p></div>
              <label>Training agent<select aria-label="Training agent" value={selectedTrainingAgent?.id ?? ""} onChange={event => setTrainingAgent(event.target.value)}>
                {desk.agents.map(agent => <option key={agent.id} value={agent.id}>{latest(agent).name}</option>)}
              </select></label>
            </div>
            <div className="training-status">
              <span>{desk.mode === "replay" ? "SYNTHETIC dataset · 600 observations" : `${trainingCount} recent observations for ${desk.selected}`}</span>
              {auth && <button className="primary" disabled={!!busy || !allowedToTrain || (desk.mode === "live" && trainingCount < 120)} onClick={() => {
                if (selectedTrainingAgent) void act("Training strategy", { kind: "train", id: selectedTrainingAgent.id, symbol: snapshot?.symbol, synthetic: desk.mode === "replay" });
              }}>{desk.mode === "replay" ? "Train on SYNTHETIC" : "Train on live history"}</button>}
            </div>
            {!auth && <p className="empty">{operatorAccess ? "Open Operator access to run training." : "Training runs are available in the operator workspace. Enable operator access in the server settings."}</p>}
            {auth && !allowedToTrain && <p className="empty">Add the selected market to this agent’s allowed markets.</p>}
            {desk.mode === "live" && trainingCount < 120 && <p className="empty">Training on live history needs 120 observations for the same market.</p>}
            {selectedTrainingAgent && <FittedTraining key={"fit-" + selectedTrainingAgent.id} models={selectedTrainingAgent.fittedModels ?? []}
              active={latest(selectedTrainingAgent).modelId} busy={!!busy} canFit={allowedToTrain} operator={auth}
              fit={async (config, synthetic) => {
                if (!snapshot) throw new Error("Select a market before fitting.");
                if (synthetic && snapshot.mode !== "replay") throw new Error("Switch to Replay before fitting a SYNTHETIC model.");
                setBusy("Fitting forecast model");
                try { await request({ kind: "fit", id: selectedTrainingAgent.id, symbol: snapshot.symbol, synthetic, config }); }
                finally { setBusy(""); }
              }}
              ask={async (question, modelId) => {
                const result = await request({ kind: "ask-training", id: selectedTrainingAgent.id, question, modelId });
                return result.answer ?? "No training answer is available.";
              }}
              activate={async modelId => {
                setBusy("Activating fitted model");
                try { await request({ kind: "activate-model", id: selectedTrainingAgent.id, modelId }); }
                finally { setBusy(""); }
              }} />}
            {selectedTrainingAgent?.training?.length
              ? <TrainingPanel key={"tuning-" + selectedTrainingAgent.id} training={selectedTrainingAgent.training[selectedTrainingAgent.training.length - 1]} />
              : <p className="empty">No saved training report for this agent.</p>}
          </section>
          <div className="details">
            <section className="panel feed" id="activity"><h2>Decision log</h2>
              {!desk.decisions.length && <p className="empty">Run an agent to record its signal, recommendation and simulated fill.</p>}
              <PagedFeed entries={[...desk.decisions].reverse()} prefix="decision-" render={d => <article id={"decision-" + d.id} key={d.id}><div className="entry-head"><strong>{desk.agents.find(a => a.id === d.agent)?.versions.find(v => v.number === d.version)?.name}</strong><span className="pill">{d.action}</span></div><small>{d.snapshot.symbol} · v{d.version} · {date(d.at)}</small><p>{d.reason} {d.policy}</p>{d.forecast && <p>Model {d.forecast.modelId} · {d.forecast.change.toFixed(2)}¢ predicted midpoint change over {d.forecast.horizon} observations</p>}{d.fill && <small>{d.fill.quantity} YES at {d.fill.price}¢ · {d.fill.fee}¢ simulated fee</small>}
                <DecisionAudit decision={d} busy={!!busy} verify={() => perform("Verifying decision memo", async () => {
                  const result = await request({ kind: "verify-anchor", id: d.id });
                  if (result.proof?.state === "uncertain") throw new Error("Solana RPC has not confirmed the memo yet.");
                })} /></article>} />
            </section>
            <section className="panel feed" id="research"><h2>Research payments</h2>
              <p className="empty">{auth ? "Verified quote reviews use Solana devnet test USDC." : "Request a quote review and apply its recommendation to your paper portfolio."}</p>
              {auth && desk.changes.map(c => <article key={c.id}><strong>Budget change pending</strong><p>{desk.agents.find(a => a.id === c.agent)?.versions.at(-1)?.name} · cap {usdc(c.cap)} · total {usdc(c.budget)}</p><button className="primary" disabled={!!busy} onClick={() => act("Confirming spending authority", { kind: "confirm", id: c.id })}>Confirm budget change</button></article>)}
              <PagedFeed entries={[...desk.purchases].reverse()} prefix="purchase-" render={p => <article id={"purchase-" + p.id} key={p.id}><div className="entry-head"><strong>Quote quality review</strong><span className={`pill ${["confirmed", "simulated"].includes(p.status) ? "good" : ""}`}>{p.status}</span></div><small>{usdc(p.amount)} · {date(p.at)} · <a href={"#decision-" + p.decision}>Decision</a></small><p>{p.reason}</p>{p.after && <p>Recommendation: {p.before} → {p.after}. {p.evidence}</p>}<ValidationSteps stages={p.validation} />
                {(p.status === "confirmed" || p.status === "simulated") && p.after && p.after !== "hold" &&
                  (desk.decisions.find(d => d.researchPurchase === p.id)
                    ? <p><a href={"#decision-" + desk.decisions.find(d => d.researchPurchase === p.id)?.id}>Applied paper decision</a></p>
                    : <button className="quiet" disabled={!!busy} onClick={() => act("Applying paper recommendation", { kind: "apply-review", id: p.id })}>Apply as paper order</button>)}
                {p.signature && <a href={`https://explorer.solana.com/tx/${p.signature}?cluster=devnet`} target="_blank" rel="noreferrer">View Solana devnet receipt ↗</a>}
                {["uncertain","pending"].includes(p.status) && <button className="quiet" disabled={!!busy || !auth} onClick={() => act("Checking Solana", { kind: "reconcile", id: p.id })}>Check settlement</button>}</article>} />
            </section>
          </div>
          <section className="panel feed" id="supervisor"><div className="section-head"><div><h2>Supervisor</h2><p className="empty">Answers are generated from saved decisions, positions and research records.</p></div>
            {auth && <button className="quiet" disabled={!!busy || (!talking && !voiceAvailable)} onClick={() => perform(talking ? "Ending call" : "Connecting ElevenLabs", async () => {
              if (talking) await voice.endSession();
              else {
                if (!navigator.mediaDevices?.getUserMedia) throw new Error("Voice needs a secure (HTTPS or localhost) browser context with microphone support.");
                try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); }
                catch { throw new Error("Microphone access was denied. Allow it in the browser and try again."); }
                const { signedUrl } = await request({ kind: "voice" });
                if (!signedUrl) throw new Error("No signed session was returned.");
                voice.startSession({ signedUrl, connectionType: "websocket" });
              }
            })}>{talking ? (voice.isSpeaking ? "Speaking · End call" : "Listening · End call") : "◉ Start voice"}</button>}</div>
            {auth && !talking && !voiceAvailable && <small className="empty">ElevenLabs voice requires server configuration.</small>}
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
      <label>Strategy instructions<textarea name="instructions" value={instructions} onChange={e => setInstructions(e.target.value)} maxLength={2000} rows={3} placeholder={"Hold if spread exceeds 5¢\nBuy when ask is below 40¢"} /></label>
      <PolicyPreview instructions={instructions} />
      <small>Use one rule per line. Examples include “Always hold” and “Buy when YES falls below 40¢.” Matching holds take priority. Other instructions require AI.</small>
      <label>Allowed market symbols<input name="markets" defaultValue={[...new Set([...(initial.markets ?? []), ...(addMarket && snapshot ? [snapshot.symbol] : [])])].join(", ")} required /></label>
      {snapshot && <small className="empty">Selected market: {snapshot.symbol}</small>}
      <div className="form-grid"><label>Signal threshold (¢)<input name="threshold" type="number" min={1} max={40} defaultValue={initial.threshold ?? 3} required /></label><label>Position limit<input name="limit" type="number" min={1} max={1000} defaultValue={initial.positionLimit ?? 25} required /></label></div>
      <label>Stop-loss (% below average entry)
        <input name="stopLoss" type="number" min={1} max={99} step={1} placeholder="Off" defaultValue={initial.stopLossPct ?? ""} />
      </label>
      <small>Active agents check a configured stop-loss on fresh live quotes, even with automatic strategy runs off.</small>
      <label className="check"><input name="auto" type="checkbox" defaultChecked={initial.auto ?? true} /> Run paper strategy automatically in Live Gemini</label>
      {auth && <small>This setting also enables scheduled strategy runs when the server collector is configured.</small>}
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
