import { describe, expect, it } from "vitest";
import { computeMetrics, periodsPerYear, runStrategyBacktest, splitTrainTest } from "./backtest.js";
import type { Candle } from "./types.js";

function series(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ time: 1_700_000_000 + i * 86400, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 1 }));
}

describe("splitTrainTest", () => {
  it("splits chronologically at the fraction (held-out future)", () => {
    const { train, test } = splitTrainTest([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.7);
    expect(train).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(test).toEqual([8, 9, 10]);
  });
});

describe("periodsPerYear", () => {
  it("daily ≈ 365, hourly ≈ 8760", () => {
    expect(Math.round(periodsPerYear(1440))).toBe(365);
    expect(Math.round(periodsPerYear(60))).toBe(8760);
  });
});

describe("runStrategyBacktest — determinism & behavior", () => {
  // Flat base (clears WARMUP=26), then an ACCELERATING rally (returnSpread>0 ⇒ momentum
  // entry fires), then a drop (forces the exit) — long enough to realize a round-trip.
  const flat = Array.from({ length: 30 }, () => 100);
  const accel = [101, 103, 106, 111, 118, 127, 138];
  const down = [130, 120, 110, 100];
  const candles = { BTCUSD: series([...flat, ...accel, ...down]) };

  it("is deterministic (same candles ⇒ identical metrics)", () => {
    const a = runStrategyBacktest("momentum", candles, { interval: 1440 });
    const b = runStrategyBacktest("momentum", candles, { interval: 1440 });
    expect(a.metrics).toEqual(b.metrics);
    expect(a.equityCurve.length).toEqual(b.equityCurve.length);
  });

  it("momentum takes at least one round-trip on a trend+reversal", () => {
    const r = runStrategyBacktest("momentum", candles, { interval: 1440 });
    expect(r.roundTrips.length).toBeGreaterThanOrEqual(1);
    expect(r.equityCurve.length).toBeGreaterThan(0);
  });

  it("never goes cash-negative (affordability clamp holds)", () => {
    const r = runStrategyBacktest("mean-reversion", candles, { interval: 1440 });
    for (const p of r.equityCurve) expect(p.equity).toBeGreaterThan(0);
  });
});

describe("computeMetrics", () => {
  it("computes win rate, drawdown sign, and total return on a known curve", () => {
    const curve = [
      { t: 1, equity: 10000 },
      { t: 2, equity: 10500 },
      { t: 3, equity: 9975 }, // dip ⇒ drawdown < 0
      { t: 4, equity: 11000 },
    ];
    const rts = [
      { symbol: "BTCUSD", entryTs: 1, exitTs: 2, entryPrice: 100, exitPrice: 110, size: 1, pnl: 10, returnPct: 10 },
      { symbol: "BTCUSD", entryTs: 2, exitTs: 3, entryPrice: 110, exitPrice: 105, size: 1, pnl: -5, returnPct: -4.5 },
    ];
    const m = computeMetrics(curve, rts, 10000, 1440);
    expect(m.trades).toBe(2);
    expect(m.winRate).toBeCloseTo(0.5, 5);
    expect(m.maxDrawdownPct).toBeLessThan(0);
    expect(m.totalReturnPct).toBeCloseTo(10, 5);
    expect(m.profitFactor).toBeCloseTo(2, 5); // 10 / 5
  });

  it("empty inputs are safe", () => {
    const m = computeMetrics([], [], 10000, 1440);
    expect(m.trades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.sharpe).toBe(0);
  });
});
