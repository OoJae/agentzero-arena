import { describe, expect, it } from "vitest";
import {
  computeMeanReversionFeatures,
  computeMomentumFeatures,
  lookbackReturn,
  mean,
  periodReturns,
  rsi,
  stdev,
} from "./features.js";
import type { Candle } from "./types.js";

function candle(close: number, high = close, low = close): Candle {
  return { time: 0, open: close, high, low, close, volume: 1 };
}

describe("math helpers", () => {
  it("mean and stdev", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(mean([])).toBe(0);
    expect(stdev([1, 1, 1])).toBe(0);
    expect(stdev([2, 4, 6])).toBeCloseTo(2, 6);
  });

  it("periodReturns", () => {
    const r = periodReturns([100, 110, 99]);
    expect(r[0]).toBeCloseTo(0.1, 6);
    expect(r[1]).toBeCloseTo(-0.1, 6);
  });

  it("lookbackReturn clamps when window exceeds data", () => {
    expect(lookbackReturn([100, 110], 5)).toBe(0);
    expect(lookbackReturn([100, 105, 110], 2)).toBeCloseTo(0.1, 6);
  });
});

describe("computeMomentumFeatures", () => {
  it("detects an uptrend with positive returns and breakout at the high", () => {
    // steadily rising series → price == range high → breakout ~ 0, positive returns
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const candles = closes.map((c) => candle(c));
    const f = computeMomentumFeatures("BTCUSD", candles);
    expect(f.price).toBe(129);
    expect(f.shortReturn).toBeGreaterThan(0);
    expect(f.longReturn).toBeGreaterThan(0);
    expect(f.breakout).toBeCloseTo(0, 6); // last close is the range high
    expect(f.drawdownFromHigh).toBeCloseTo(0, 6);
  });

  it("flags drawdown when price falls from a recent high", () => {
    const closes = [...Array.from({ length: 20 }, (_, i) => 100 + i * 2), 110]; // rise then drop
    const candles = closes.map((c) => candle(c));
    const f = computeMomentumFeatures("ETHUSD", candles);
    expect(f.drawdownFromHigh).toBeLessThan(0);
    expect(f.breakout).toBeLessThan(0);
  });

  it("returnSpread (per-period rate) is positive when accelerating", () => {
    // flat, then sharp recent gains ⇒ recent pace > longer-term pace
    const accel = [100, 100, 100, 100, 100, 100, 100, 102, 105, 109, 114];
    const params = { shortWindow: 3, longWindow: 8, rangeWindow: 8, volWindow: 8 };
    const fa = computeMomentumFeatures("SOLUSD", accel.map((c) => candle(c)), params);
    expect(fa.returnSpread).toBeGreaterThan(0);
  });

  it("returnSpread is negative when decelerating", () => {
    // fast early gains, then flat ⇒ recent pace < longer-term pace
    const decel = [100, 105, 110, 114, 117, 119, 120, 120, 120, 120, 120];
    const params = { shortWindow: 3, longWindow: 8, rangeWindow: 8, volWindow: 8 };
    const fd = computeMomentumFeatures("SOLUSD", decel.map((c) => candle(c)), params);
    expect(fd.returnSpread).toBeLessThan(0);
  });

  it("is robust to short/empty series", () => {
    expect(() => computeMomentumFeatures("BTCUSD", [])).not.toThrow();
    const f = computeMomentumFeatures("BTCUSD", [candle(100)]);
    expect(Number.isFinite(f.price)).toBe(true);
  });
});

describe("rsi", () => {
  it("is high for a steady uptrend and low for a steady downtrend", () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(up, 14)).toBeGreaterThan(95);
    expect(rsi(down, 14)).toBeLessThan(5);
  });
  it("returns 50 for too-short input", () => {
    expect(rsi([100, 101], 14)).toBe(50);
  });
});

describe("computeMeanReversionFeatures", () => {
  function candle(close: number): Candle {
    return { time: 0, open: close, high: close, low: close, close, volume: 1 };
  }
  it("flags oversold when price dips well below the moving average", () => {
    const closes = [...Array.from({ length: 24 }, () => 100), 90]; // flat then sharp dip
    const f = computeMeanReversionFeatures("BTCUSD", closes.map(candle));
    expect(f.zScore).toBeLessThan(-1);
    expect(f.percentB).toBeLessThan(0.5);
    expect(f.smaDeviation).toBeLessThan(0);
    expect(f.rsi).toBeLessThan(50);
  });
  it("flags overbought when price spikes above the moving average", () => {
    const closes = [...Array.from({ length: 24 }, () => 100), 112];
    const f = computeMeanReversionFeatures("ETHUSD", closes.map(candle));
    expect(f.zScore).toBeGreaterThan(1);
    expect(f.percentB).toBeGreaterThan(0.5);
  });
  it("is near-neutral on a flat series", () => {
    const f = computeMeanReversionFeatures("SOLUSD", Array.from({ length: 25 }, () => candle(100)));
    expect(Math.abs(f.zScore)).toBeLessThan(0.5);
    expect(f.rsi).toBe(50);
  });
});
