import { createHash } from "node:crypto";
import { INITIAL_CASH, newDesk, record, type Config, type Snapshot } from "./engine";
import { evaluateRun } from "./runner";

export type Bar = { bid: number; ask: number; at: string };
export type Arm = Pick<Config, "threshold" | "positionLimit">;

export function datasetHash(rows: unknown) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
export function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
}
export function syntheticSeries(seed: number, length: number): Bar[] {
  const random = rng(seed);
  let mid = 45;
  return Array.from({ length }, (_, i) => {
    const drift = Math.floor(i / 20) % 4 < 2 ? 2 : -2;
    mid = Math.max(3, Math.min(97, mid + drift + Math.floor(random() * 11) - 5));
    const spread = 1 + Math.floor(random() * 3);
    return { bid: mid - 1, ask: mid + spread, at: new Date(Date.UTC(2026, 0, 1, 0, i * 5)).toISOString() };
  });
}
export function metrics(equity: number[], trades: number, fees: number) {
  let high = INITIAL_CASH;
  let maxDrawdown = 0;
  const returns = equity.map((value, i) => {
    high = Math.max(high, value);
    maxDrawdown = Math.max(maxDrawdown, high - value);
    return value - (equity[i - 1] ?? INITIAL_CASH);
  });
  const pnl = (equity.at(-1) ?? INITIAL_CASH) - INITIAL_CASH;
  const mean = returns.length ? pnl / returns.length : 0;
  const deviation = Math.sqrt(returns.reduce((total, item) => total + (item - mean) ** 2, 0) / Math.max(1, returns.length));
  return { pnl, maxDrawdown, trades, fees, sharpe: deviation ? mean / deviation : 0, returns };
}
export function simulate(bars: Bar[], config: Config, slippageCents = 0, choose?: (i: number) => "buy" | "sell" | "hold") {
  const desk = newDesk();
  const agent = desk.agents[0];
  const symbol = "BACKTEST";
  Object.assign(agent.versions[0], config, { markets: [symbol], active: true });
  desk.snapshots = [];
  const equity: number[] = [];
  const actions: string[] = [];
  let trades = 0;
  let fees = 0;
  for (const [i, bar] of bars.entries()) {
    const observation: Snapshot = { ...bar, id: String(i), symbol, mode: "replay", title: symbol, source: "Backtest input" };
    const change = i > 0 ? (bar.bid + bar.ask - bars[i - 1].bid - bars[i - 1].ask) / 2 : null;
    const quote = { ...observation, bid: Math.max(0, bar.bid - slippageCents), ask: Math.min(100, bar.ask + slippageCents) };
    desk.snapshots = i ? [{ ...observation, ...bars[i - 1], id: String(i - 1) }, observation] : [observation];
    const proposal = choose ? { action: choose(i), reason: "Evaluation baseline" } : evaluateRun(agent.versions[0], observation, change).proposal;
    const decision = record(desk, agent, quote, proposal, []);
    desk.decisions = [];
    actions.push(decision.action);
    if (decision.fill) { trades++; fees += decision.fill.fee; }
    equity.push(agent.cash + (agent.positions[symbol] ?? 0) * (bar.bid + bar.ask) / 2);
  }
  return { ...metrics(equity, trades, fees), actions, equity };
}
export function confidence(deltas: number[], seed: number, block = 1): [number, number] {
  if (!deltas.length) return [0, 0];
  const random = rng(seed);
  const samples = Array.from({ length: 1000 }, () => {
    let total = 0;
    for (let i = 0; i < deltas.length;) {
      const start = Math.floor(random() * deltas.length);
      for (let j = 0; j < block && i < deltas.length; j++, i++) total += deltas[(start + j) % deltas.length];
    }
    return total;
  }).sort((a, b) => a - b);
  return [samples[49], samples[949]];
}

export function train(bars: Bar[], config: Config, seed: number, window = 10) {
  if (bars.length < 120) throw new Error("Training needs at least 120 chronological observations.");
  const testStart = Math.floor(bars.length * .75);
  const fit = bars.slice(0, testStart - window);
  const holdout = bars.slice(testStart);
  const random = rng(seed);
  const arms = [1, 2, 3, 4, 6, 8, 12].flatMap(threshold => [5, 10, 25].map(positionLimit =>
    ({ threshold, positionLimit, wins: 1, losses: 1, runs: 0, reward: 0 })));
  const beta = (a: number, b: number) => {
    let wins = 0;
    let losses = 0;
    for (let i = 0; i < a; i++) wins -= Math.log(random());
    for (let i = 0; i < b; i++) losses -= Math.log(random());
    return wins / (wins + losses);
  };
  const learning = [];
  for (let episode = 0; episode < 200; episode++) {
    const arm = arms.map(item => ({ item, sample: beta(item.wins, item.losses) }))
      .reduce((a, b) => a.sample >= b.sample ? a : b).item;
    const length = Math.min(40, fit.length);
    const start = Math.floor(random() * (fit.length - length + 1));
    const { pnl } = simulate(fit.slice(start, start + length), { ...config, ...arm });
    arm.runs++;
    arm.reward += pnl;
    if (pnl > 0) arm.wins++; else arm.losses++;
    learning.push(pnl);
  }
  const scores = arms.filter(a => a.runs > 0).map(a => ({ ...a, mean: a.wins / (a.wins + a.losses) }));
  const best = scores.reduce((a, b) => a.mean >= b.mean ? a : b);
  const candidate = { threshold: best.threshold, positionLimit: best.positionLimit };
  const incumbent = simulate(holdout, config);
  const trial = simulate(holdout, { ...config, ...candidate });
  const margin = INITIAL_CASH / 100;
  const ci = confidence(trial.returns.map((value, i) => value - incumbent.returns[i]), seed, window);
  const promoted = trial.pnl > incumbent.pnl + margin && trial.maxDrawdown <= incumbent.maxDrawdown * 1.25
    && trial.trades >= 3 && ci[0] > -margin;
  return { seed, hash: datasetHash(bars), bars: bars.length, fitEnd: testStart - window, testStart, candidate, promoted, margin, ci,
    incumbent: { pnl: incumbent.pnl, maxDrawdown: incumbent.maxDrawdown, trades: incumbent.trades },
    trial: { pnl: trial.pnl, maxDrawdown: trial.maxDrawdown, trades: trial.trades }, learning, arms: scores };
}
export type TrainReport = ReturnType<typeof train>;
export function walkForward(bars: Bar[], config: Config, seed: number, trainLen = 160, testLen = 40, slippage = 0) {
  if (trainLen < 120 || testLen < 1) throw new Error("Use at least 120 training and 1 test observation.");
  const folds = [];
  for (let end = trainLen; end + testLen <= bars.length; end += testLen) {
    const report = train(bars.slice(end - trainLen, end), config, seed + end);
    const test = bars.slice(end, end + testLen);
    const used = report.promoted ? report.candidate : { threshold: config.threshold, positionLimit: config.positionLimit };
    folds.push({ trainStart: end - trainLen, trainEnd: end, testStart: end, testEnd: end + testLen, used, promoted: report.promoted,
      trained: simulate(test, { ...config, ...used }, slippage), default: simulate(test, config, slippage) });
  }
  return folds;
}
