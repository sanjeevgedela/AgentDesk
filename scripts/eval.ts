import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { confidence, datasetHash, metrics, rng, simulate, syntheticSeries, walkForward } from "../lib/backtest";
import { INITIAL_CASH, newDesk, latest } from "../lib/engine";
import { loadBars } from "../lib/history";
import { sql } from "../lib/store";

const { values } = parseArgs({ options: {
  synthetic: { type: "boolean" }, symbol: { type: "string" }, seed: { type: "string" },
  "train-len": { type: "string" }, "test-len": { type: "string" },
} });
const seed = z.coerce.number().int().min(0).max(0xffffffff).parse(values.seed ?? 17);
const trainLen = z.coerce.number().int().min(120).max(5000).parse(values["train-len"] ?? 160);
const testLen = z.coerce.number().int().min(1).max(5000).parse(values["test-len"] ?? 40);
try {
  if (!values.synthetic && !values.symbol) throw new Error("Provide --symbol or --synthetic.");
  const symbol = values.synthetic ? "SYNTHETIC" : values.symbol!;
  const history = values.synthetic ? undefined : await loadBars(symbol);
  const bars = history?.bars ?? syntheticSeries(seed, 600);
  const hash = history?.hash ?? datasetHash(bars);
  if (bars.length < trainLen + testLen) throw new Error("Insufficient observations for one fold.");
  const config = latest(newDesk().agents[0]);
  const variants = [0, 1].map(slippage => {
    const folds = walkForward(bars, config, seed, trainLen, testLen, slippage);
    const series = folds.map(fold => bars.slice(fold.testStart, fold.testEnd));
    const aggregate = (key: "trained" | "default") => {
      let equity = INITIAL_CASH;
      const returns = folds.flatMap(fold => fold[key].returns);
      const { returns: _, ...summary } = metrics(returns.map(delta => equity += delta),
        folds.reduce((sum, fold) => sum + fold[key].trades, 0), folds.reduce((sum, fold) => sum + fold[key].fees, 0));
      void _;
      return summary;
    };
    const defaultResult = aggregate("default");
    const trained = aggregate("trained");
    const buyAndHold = series.reduce((total, test) => {
      const final = test.at(-1)!;
      return total + (final.bid + final.ask) / 2 - Math.min(100, test[0].ask + slippage) - 1;
    }, 0);
    const random = rng(seed);
    const randomPnls = Array.from({ length: 200 }, () => series.reduce((total, test) =>
      total + simulate(test, config, slippage, () => (["buy", "sell", "hold"] as const)[Math.floor(random() * 3)]).pnl, 0))
      .sort((a, b) => a - b);
    const randomBaseline = { runs: 200, mean: randomPnls.reduce((sum, pnl) => sum + pnl, 0) / 200, p95: randomPnls[189] };
    const deltas = folds.flatMap(fold => fold.trained.returns.map((value, i) => value - fold.default.returns[i]));
    return {
      slippage, trained, untrained: defaultResult, buyAndHold, random: randomBaseline, deltaCi90: confidence(deltas, seed, 10),
      comparisons: { beatsUntrained: trained.pnl > defaultResult.pnl, beatsBuyAndHold: trained.pnl > buyAndHold, beatsRandomMean: trained.pnl > randomBaseline.mean },
      folds: folds.map(fold => ({ trainStart: fold.trainStart, trainEnd: fold.trainEnd, testStart: fold.testStart, testEnd: fold.testEnd,
        used: fold.used, promoted: fold.promoted, trainedPnl: fold.trained.pnl, untrainedPnl: fold.default.pnl })),
    };
  });
  const report = { symbol, synthetic: !!values.synthetic, hash, observations: bars.length, first: bars[0].at, last: bars.at(-1)!.at,
    seed, trainLen, testLen, variants };
  const markdown = [
    `# AgentDesk walk-forward evaluation — ${symbol}`, "",
    `Dataset SHA-256: \`${hash}\`. Observations: ${bars.length}. Seed: ${seed}. Window: ${trainLen}/${testLen} train/test.`, "",
    `Observation span: ${report.first} to ${report.last}.`, "",
    values.synthetic ? "SYNTHETIC prices. These results do not establish market performance." : "Recorded Gemini top-of-book observations. All fills are simulated.", "",
    "P&L, drawdown and fees are in cents. Each fold starts flat. Buy-and-hold marks one contract at the end of each fold. Sharpe is unannualized per-bar mean divided by standard deviation. CI uses 1,000 seeded block-bootstrap resamples.", "",
    ...variants.flatMap(variant => [
      `## ${variant.slippage}¢ adverse slippage per fill`, "",
      `Trained P&L: ${variant.trained.pnl}. Untrained: ${variant.untrained.pnl}. Buy-and-hold: ${variant.buyAndHold}. Random mean: ${variant.random.mean}. Random p95: ${variant.random.p95}.`,
      `Paired P&L delta 90% CI: [${variant.deltaCi90.join(", ")}]. Trained Sharpe: ${variant.trained.sharpe.toFixed(4)}. Maximum drawdown: ${variant.trained.maxDrawdown}. Trades: ${variant.trained.trades}. Fees: ${variant.trained.fees}.`, "",
      ...Object.entries(variant.comparisons).filter(([, beats]) => !beats).map(([baseline]) =>
        "Training did not beat the " + ({ beatsUntrained: "untrained baseline", beatsBuyAndHold: "buy-and-hold baseline", beatsRandomMean: "random baseline mean" }[baseline]) + "."), "",
      "| Train | Test | Threshold | Position limit | Promoted | Trained OOS P&L | Untrained OOS P&L |",
      "| --- | --- | ---: | ---: | --- | ---: | ---: |",
      ...variant.folds.map(fold => `| ${fold.trainStart}–${fold.trainEnd} | ${fold.testStart}–${fold.testEnd} | ${fold.used.threshold} | ${fold.used.positionLimit} | ${fold.promoted ? "Yes" : "No"} | ${fold.trainedPnl} | ${fold.untrainedPnl} |`), "",
    ]),
  ].join("\n");
  await mkdir("reports", { recursive: true });
  const base = `reports/eval-${hash.slice(0, 8)}`;
  await writeFile(base + ".json", JSON.stringify(report, null, 2) + "\n");
  await writeFile(base + ".md", markdown);
  console.log(base + ".json");
} finally { await sql?.end(); }
