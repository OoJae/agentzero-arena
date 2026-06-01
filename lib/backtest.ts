/**
 * lib/backtest.ts — offline, deterministic walk-forward backtester (BUILD.md §9).
 *
 * The rigor flex: it reuses the agents' EXACT deterministic signal logic
 * (`momentumFallback` / `meanReversionFallback` from worker/agents/*) over historical
 * candles — NEVER the LLM — and simulates spot, long-only fills with the same cash
 * model as VirtualProvider (fee 0.0026, no slippage). Out-of-sample (held-out test)
 * metrics are what we report; honesty about limitations is the point.
 *
 * Pure + unit-tested. No I/O here — scripts/validate.ts feeds it candles.
 */
import { computeMeanReversionFeatures, computeMomentumFeatures, mean, stdev, DEFAULT_MEAN_REVERSION_PARAMS, DEFAULT_MOMENTUM_PARAMS } from "./features.js";
import type { PortfolioStatus } from "./isolation.js";
import { meanReversionFallback, mostOversold } from "../worker/agents/meanReversion.js";
import { momentumFallback, pickStrongest } from "../worker/agents/momentum.js";
import type { Candle, Proposal } from "./types.js";

const FEE_RATE = 0.0026; // Kraken Starter taker (same as the spot paper engine)
const MAX_POSITION_PCT = 0.5; // mirrors the spot agents' single-position cap
const WARMUP = 26; // candles needed before features are meaningful (≈ longWindow/SMA window)

export type BacktestStrategy = "momentum" | "mean-reversion";

export interface RoundTrip {
  symbol: string;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number; // net of fees
  returnPct: number;
}

export interface Metrics {
  trades: number;
  winRate: number; // 0..1
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number; // gross win / gross loss
  sharpe: number; // annualized, from per-step equity returns
  maxDrawdownPct: number; // ≤ 0
  totalReturnPct: number;
}

export interface BacktestResult {
  strategy: BacktestStrategy;
  symbols: string[];
  interval: number;
  startingBalance: number;
  metrics: Metrics;
  equityCurve: Array<{ t: number; equity: number }>;
  roundTrips: RoundTrip[];
}

interface SimAccount {
  cash: number;
  startingBalance: number;
  positions: Map<string, number>; // symbol → base units (≥ 0)
  entry: Map<string, { price: number; ts: number }>; // for round-trip PnL
}

/** Periods per year for annualizing Sharpe, by candle interval (minutes). */
export function periodsPerYear(intervalMinutes: number): number {
  return (365 * 24 * 60) / intervalMinutes;
}

function signal(
  strategy: BacktestStrategy,
  windowBySymbol: Record<string, Candle[]>,
  maxSize: number,
  status: PortfolioStatus,
): Proposal {
  if (strategy === "momentum") {
    const features: Record<string, ReturnType<typeof computeMomentumFeatures>> = {};
    for (const [sym, candles] of Object.entries(windowBySymbol)) {
      features[sym] = computeMomentumFeatures(sym, candles, DEFAULT_MOMENTUM_PARAMS);
    }
    return momentumFallback(features, pickStrongest(features), maxSize, status);
  }
  const features: Record<string, ReturnType<typeof computeMeanReversionFeatures>> = {};
  for (const [sym, candles] of Object.entries(windowBySymbol)) {
    features[sym] = computeMeanReversionFeatures(sym, candles, DEFAULT_MEAN_REVERSION_PARAMS);
  }
  return meanReversionFallback(features, mostOversold(features), maxSize, status);
}

/**
 * Walk-forward backtest over aligned candle series. All symbols must share the same
 * length/timestamps (validate.ts trims them). Steps one candle at a time; at each step
 * the strategy sees only candles up to `i` (no look-ahead), trades at that close.
 */
export function runStrategyBacktest(
  strategy: BacktestStrategy,
  candlesBySymbol: Record<string, Candle[]>,
  opts: { startingBalance?: number; interval: number } ,
): BacktestResult {
  const symbols = Object.keys(candlesBySymbol);
  const startingBalance = opts.startingBalance ?? 10_000;
  const n = Math.min(...symbols.map((s) => candlesBySymbol[s]!.length));

  const acct: SimAccount = { cash: startingBalance, startingBalance, positions: new Map(), entry: new Map() };
  const equityCurve: Array<{ t: number; equity: number }> = [];
  const roundTrips: RoundTrip[] = [];

  const priceAt = (sym: string, i: number) => candlesBySymbol[sym]![i]!.close;
  const equityAt = (i: number) => {
    let v = acct.cash;
    for (const [sym, qty] of acct.positions) if (qty > 1e-12) v += qty * priceAt(sym, i);
    return v;
  };

  for (let i = WARMUP; i < n; i++) {
    const ts = candlesBySymbol[symbols[0]!]![i]!.time * 1000;
    const equity = equityAt(i);

    // Build the per-symbol window (oldest→i) and current portfolio status.
    const windowBySymbol: Record<string, Candle[]> = {};
    const positions: Record<string, number> = {};
    for (const sym of symbols) {
      windowBySymbol[sym] = candlesBySymbol[sym]!.slice(0, i + 1);
      const q = acct.positions.get(sym) ?? 0;
      if (q > 1e-12) positions[sym] = q;
    }
    const status: PortfolioStatus = { equity, startingBalance, trades: roundTrips.length, positions, cash: acct.cash };

    const primarySymbol = pickPrimaryForSizing(windowBySymbol, strategy);
    const primaryPrice = priceAt(primarySymbol, i);
    const maxSize = primaryPrice > 0 ? (MAX_POSITION_PCT * equity) / primaryPrice : 0;

    const proposal = signal(strategy, windowBySymbol, maxSize, status);
    applyFill(acct, proposal, i, candlesBySymbol, roundTrips, ts);

    equityCurve.push({ t: ts, equity: equityAt(i) });
  }

  // Close any open position at the last close (so metrics are realized).
  const lastI = n - 1;
  for (const [sym, qty] of [...acct.positions]) {
    if (qty <= 1e-12) continue;
    closePosition(acct, sym, qty, lastI, candlesBySymbol, roundTrips, candlesBySymbol[sym]![lastI]!.time * 1000);
  }

  return {
    strategy,
    symbols,
    interval: opts.interval,
    startingBalance,
    metrics: computeMetrics(equityCurve, roundTrips, startingBalance, opts.interval),
    equityCurve,
    roundTrips,
  };
}

function pickPrimaryForSizing(windowBySymbol: Record<string, Candle[]>, strategy: BacktestStrategy): string {
  if (strategy === "momentum") {
    const f: Record<string, ReturnType<typeof computeMomentumFeatures>> = {};
    for (const [s, c] of Object.entries(windowBySymbol)) f[s] = computeMomentumFeatures(s, c);
    return pickStrongest(f);
  }
  const f: Record<string, ReturnType<typeof computeMeanReversionFeatures>> = {};
  for (const [s, c] of Object.entries(windowBySymbol)) f[s] = computeMeanReversionFeatures(s, c);
  return mostOversold(f);
}

function applyFill(
  acct: SimAccount,
  proposal: Proposal,
  i: number,
  candlesBySymbol: Record<string, Candle[]>,
  roundTrips: RoundTrip[],
  ts: number,
): void {
  if (proposal.action === "hold" || proposal.size <= 0) return;
  const price = candlesBySymbol[proposal.symbol]?.[i]?.close;
  if (price == null || !Number.isFinite(price)) return;

  if (proposal.action === "buy") {
    const affordable = acct.cash / (price * (1 + FEE_RATE));
    const size = Math.min(proposal.size, affordable);
    if (size <= 1e-12) return;
    const cost = size * price;
    acct.cash -= cost + cost * FEE_RATE;
    const prevQty = acct.positions.get(proposal.symbol) ?? 0;
    // weighted-average entry across adds
    const prev = acct.entry.get(proposal.symbol);
    const newQty = prevQty + size;
    const avgPrice = prev && prevQty > 0 ? (prev.price * prevQty + price * size) / newQty : price;
    acct.positions.set(proposal.symbol, newQty);
    acct.entry.set(proposal.symbol, { price: avgPrice, ts: prev?.ts ?? ts });
    return;
  }
  // sell — close up to held
  const held = acct.positions.get(proposal.symbol) ?? 0;
  const size = Math.min(proposal.size, held);
  if (size <= 1e-12) return;
  closePosition(acct, proposal.symbol, size, i, candlesBySymbol, roundTrips, ts);
}

function closePosition(
  acct: SimAccount,
  symbol: string,
  size: number,
  i: number,
  candlesBySymbol: Record<string, Candle[]>,
  roundTrips: RoundTrip[],
  ts: number,
): void {
  const price = candlesBySymbol[symbol]![i]!.close;
  const proceeds = size * price;
  acct.cash += proceeds - proceeds * FEE_RATE;
  const held = acct.positions.get(symbol) ?? 0;
  const remaining = held - size;
  const entry = acct.entry.get(symbol);
  if (entry) {
    const grossPnl = (price - entry.price) * size;
    const fees = entry.price * size * FEE_RATE + proceeds * FEE_RATE;
    const pnl = grossPnl - fees;
    roundTrips.push({
      symbol,
      entryTs: entry.ts,
      exitTs: ts,
      entryPrice: entry.price,
      exitPrice: price,
      size,
      pnl,
      returnPct: entry.price > 0 ? (pnl / (entry.price * size)) * 100 : 0,
    });
  }
  if (remaining <= 1e-12) {
    acct.positions.delete(symbol);
    acct.entry.delete(symbol);
  } else {
    acct.positions.set(symbol, remaining);
  }
}

export function computeMetrics(
  equityCurve: Array<{ t: number; equity: number }>,
  roundTrips: RoundTrip[],
  startingBalance: number,
  intervalMinutes: number,
): Metrics {
  const wins = roundTrips.filter((r) => r.pnl > 0);
  const losses = roundTrips.filter((r) => r.pnl < 0);
  const grossWin = wins.reduce((a, r) => a + r.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, r) => a + r.pnl, 0));

  // per-step equity returns → Sharpe
  const rets: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1]!.equity;
    if (prev > 0) rets.push(equityCurve[i]!.equity / prev - 1);
  }
  const sd = stdev(rets);
  const sharpe = sd > 0 ? (mean(rets) / sd) * Math.sqrt(periodsPerYear(intervalMinutes)) : 0;

  // max drawdown over the equity curve
  let peak = startingBalance;
  let maxDd = 0;
  for (const p of equityCurve) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDd = Math.min(maxDd, p.equity / peak - 1);
  }

  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1]!.equity : startingBalance;

  return {
    trades: roundTrips.length,
    winRate: roundTrips.length ? wins.length / roundTrips.length : 0,
    avgWinPct: wins.length ? mean(wins.map((r) => r.returnPct)) : 0,
    avgLossPct: losses.length ? mean(losses.map((r) => r.returnPct)) : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    sharpe,
    maxDrawdownPct: maxDd * 100,
    totalReturnPct: startingBalance > 0 ? (finalEquity / startingBalance - 1) * 100 : 0,
  };
}

/** Chronological train/test split (no shuffling — held-out future). */
export function splitTrainTest<T>(series: T[], trainFraction = 0.7): { train: T[]; test: T[] } {
  const cut = Math.floor(series.length * trainFraction);
  return { train: series.slice(0, cut), test: series.slice(cut) };
}
