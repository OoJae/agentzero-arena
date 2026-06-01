/**
 * scripts/validate.ts — out-of-sample validation harness (BUILD.md §9).
 *
 * The rigor flex: pull REAL historical OHLC, split chronologically into train / held-out
 * test, run each spot strategy's EXACT deterministic signal logic (lib/backtest.ts, which
 * reuses worker/agents/*Fallback), and report OUT-OF-SAMPLE metrics. Persists to
 * `validation_runs` so the dashboard's Validation tab can render them.
 *
 * Honest by design: futures strategies (Funding-Carry, Macro-Hedge) have no historical
 * OHLC via the CLI and are validated live in-tournament — see the limitations footer.
 *
 * Run: pnpm validate   (ARENA_VALIDATE_INTERVAL=1440 default = daily; ~720 candles)
 */
import { runStrategyBacktest, splitTrainTest, type BacktestStrategy } from "../lib/backtest.js";
import { getDb, insertValidationRun } from "../lib/db.js";
import { ohlc } from "../lib/kraken.js";
import { ReplayPriceFeed } from "../lib/priceFeed.js";
import type { BacktestMetrics, Candle, ValidationView } from "../lib/types.js";

for (const f of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* optional */
  }
}

const INTERVAL = Number(process.env.ARENA_VALIDATE_INTERVAL ?? 1440); // daily ⇒ ~720d history
const SYMBOLS = ["BTCUSD", "ETHUSD", "SOLUSD"];
const STRATEGIES: BacktestStrategy[] = ["momentum", "mean-reversion"];
const TRAIN_FRACTION = 0.7;

async function loadCandles(): Promise<{ bySymbol: Record<string, Candle[]>; source: "real" | "synthetic" }> {
  try {
    const bySymbol: Record<string, Candle[]> = {};
    for (const sym of SYMBOLS) bySymbol[sym] = await ohlc(sym, INTERVAL);
    const minLen = Math.min(...SYMBOLS.map((s) => bySymbol[s]!.length));
    if (minLen < 60) throw new Error(`too few candles (${minLen})`);
    return { bySymbol, source: "real" };
  } catch (err) {
    console.warn(`\n⚠️  Real OHLC unavailable (${(err as Error).message}); using SYNTHETIC ReplayPriceFeed candles.`);
    const feed = new ReplayPriceFeed();
    const bySymbol: Record<string, Candle[]> = {};
    for (const sym of SYMBOLS) bySymbol[sym] = await feed.getCandles(sym, INTERVAL, 720);
    return { bySymbol, source: "synthetic" };
  }
}

/** Align all symbol series to the same length (trim oldest) so steps line up. */
function alignByTime(bySymbol: Record<string, Candle[]>): Record<string, Candle[]> {
  const minLen = Math.min(...Object.values(bySymbol).map((c) => c.length));
  const out: Record<string, Candle[]> = {};
  for (const [sym, c] of Object.entries(bySymbol)) out[sym] = c.slice(c.length - minLen);
  return out;
}

function fmt(m: BacktestMetrics): string {
  const pf = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
  return [
    `trades ${String(m.trades).padStart(3)}`,
    `win ${(m.winRate * 100).toFixed(0).padStart(3)}%`,
    `ret ${(m.totalReturnPct >= 0 ? "+" : "") + m.totalReturnPct.toFixed(1)}%`,
    `Sharpe ${m.sharpe.toFixed(2)}`,
    `maxDD ${m.maxDrawdownPct.toFixed(1)}%`,
    `PF ${pf}`,
  ].join("  ");
}

async function main() {
  const { bySymbol, source } = await loadCandles();
  const aligned = alignByTime(bySymbol);

  console.log("\n══════════════════════════════════════════════════════════════════════");
  console.log("  AgentZero Arena — Out-of-Sample Validation");
  console.log(`  source=${source}  interval=${INTERVAL}m  split=${Math.round(TRAIN_FRACTION * 100)}/${Math.round((1 - TRAIN_FRACTION) * 100)} (train/test)`);
  console.log("══════════════════════════════════════════════════════════════════════\n");

  const db = getDb();
  const ts = Date.now();

  for (const strategy of STRATEGIES) {
    console.log(`■ ${strategy.toUpperCase()}`);
    // Whole-basket split, then per-symbol single-asset OOS for legible per-symbol numbers.
    for (const sym of SYMBOLS) {
      const { train, test } = splitTrainTest(aligned[sym]!, TRAIN_FRACTION);
      const trainRes = runStrategyBacktest(strategy, { [sym]: train }, { interval: INTERVAL });
      const testRes = runStrategyBacktest(strategy, { [sym]: test }, { interval: INTERVAL });
      const view: ValidationView = {
        ts,
        strategy,
        symbol: sym,
        interval: INTERVAL,
        source,
        train: trainRes.metrics,
        test: testRes.metrics,
        trainCandles: train.length,
        testCandles: test.length,
      };
      insertValidationRun(db, view);
      console.log(`  ${sym.padEnd(7)} TRAIN  ${fmt(trainRes.metrics)}`);
      console.log(`  ${sym.padEnd(7)} TEST*  ${fmt(testRes.metrics)}   ← out-of-sample`);
    }
    console.log("");
  }

  console.log("──────────────────────────────────────────────────────────────────────");
  console.log("  Limitations (stated plainly — honesty is the credibility signal):");
  console.log("   • Kraken OHLC is capped at ~721 candles per interval; daily ⇒ ~2yr history.");
  console.log("   • Backtest uses daily candles; the live agents trade a 15m cadence (regime/lag differ).");
  console.log("   • Paper model: no slippage, no partial fills; Starter taker fee 0.26%; long-only spot.");
  console.log("   • Funding-Carry & Macro-Hedge (perps) have NO historical OHLC via the CLI →");
  console.log("     they are validated LIVE in the tournament, not here.");
  if (source === "synthetic") console.log("   • ⚠️  THIS RUN USED SYNTHETIC candles (Kraken unreachable) — not real-data validation.");
  console.log("──────────────────────────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error("[validate] fatal:", err);
  process.exit(1);
});
