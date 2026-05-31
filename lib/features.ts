/**
 * lib/features.ts — deterministic feature computation.
 *
 * GOLDEN RULE: the LLM must NOT predict prices. This module turns raw OHLC into
 * real, explainable features (momentum/trend/breakout/volatility). The agent then
 * reasons over THESE numbers — never over imagined future prices. Pure functions,
 * fully unit-tested.
 */
import type { Candle, MomentumFeatures } from "./types.js";

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Simple period-over-period returns from a close series. */
export function periodReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    const cur = closes[i]!;
    if (prev !== 0) out.push(cur / prev - 1);
  }
  return out;
}

/** Return over `window` candles ending at the last close. */
export function lookbackReturn(closes: number[], window: number): number {
  if (closes.length <= window) return 0;
  const last = closes[closes.length - 1]!;
  const past = closes[closes.length - 1 - window]!;
  if (past === 0) return 0;
  return last / past - 1;
}

export interface MomentumParams {
  shortWindow: number; // candles for short-term return
  longWindow: number; // candles for long-term return
  rangeWindow: number; // candles for breakout/range
  volWindow: number; // candles for realized vol
}

export const DEFAULT_MOMENTUM_PARAMS: MomentumParams = {
  shortWindow: 6,
  longWindow: 24,
  rangeWindow: 24,
  volWindow: 24,
};

/**
 * Compute momentum features for a symbol from its candles (oldest→newest).
 * Robust to short series: windows clamp to available data.
 */
export function computeMomentumFeatures(
  symbol: string,
  candles: Candle[],
  params: MomentumParams = DEFAULT_MOMENTUM_PARAMS,
): MomentumFeatures {
  const closes = candles.map((c) => c.close).filter((c) => Number.isFinite(c));
  const highs = candles.map((c) => c.high).filter((c) => Number.isFinite(c));
  const price = closes.length ? closes[closes.length - 1]! : NaN;

  const shortW = Math.min(params.shortWindow, Math.max(1, closes.length - 1));
  const longW = Math.min(params.longWindow, Math.max(1, closes.length - 1));

  const shortReturn = lookbackReturn(closes, shortW);
  const longReturn = lookbackReturn(closes, longW);
  // Per-period RATE difference: positive ⇒ recent pace exceeds the longer-term
  // pace (acceleration); ~0 ⇒ steady trend; negative ⇒ deceleration. Comparing
  // raw cumulative returns would be dominated by the longer window.
  const shortRate = shortW > 0 ? shortReturn / shortW : 0;
  const longRate = longW > 0 ? longReturn / longW : 0;
  const returnSpread = shortRate - longRate;

  const rangeSlice = highs.slice(-params.rangeWindow);
  const rangeHigh = rangeSlice.length ? Math.max(...rangeSlice) : price;
  const breakout = rangeHigh !== 0 ? (price - rangeHigh) / rangeHigh : 0;

  const closeSlice = closes.slice(-params.longWindow);
  const recentHigh = closeSlice.length ? Math.max(...closeSlice) : price;
  const drawdownFromHigh = recentHigh !== 0 ? (price - recentHigh) / recentHigh : 0;

  const rets = periodReturns(closes.slice(-(params.volWindow + 1)));
  const realizedVol = stdev(rets);

  return {
    symbol,
    price,
    shortReturn,
    longReturn,
    returnSpread,
    breakout,
    drawdownFromHigh,
    realizedVol,
  };
}
