/**
 * lib/priceFeed.ts — price source abstraction.
 *
 * `LiveKrakenPriceFeed` uses the real CLI (`ticker`/`ohlc`) and is the default on a
 * network-enabled host. `ReplayPriceFeed` is a deterministic, mean-reverting offline
 * market so the arena (and its demo) runs even where *.kraken.com is blocked — and
 * doubles as reproducible backup footage (BUILD.md §17).
 */
import { ohlc, ticker } from "./kraken.js";
import type { Candle } from "./types.js";

export interface PriceFeed {
  readonly kind: "live" | "replay";
  getCandles(symbol: string, intervalMinutes: number, count: number): Promise<Candle[]>;
  getPrice(symbol: string): Promise<number>;
}

// ─── Live ────────────────────────────────────────────────────────────────────
export class LiveKrakenPriceFeed implements PriceFeed {
  readonly kind = "live" as const;
  async getCandles(symbol: string, intervalMinutes: number, count: number): Promise<Candle[]> {
    const all = await ohlc(symbol, intervalMinutes);
    return all.slice(-count);
  }
  async getPrice(symbol: string): Promise<number> {
    const q = await ticker(symbol);
    return q.last;
  }
}

// ─── Deterministic offline market (Ornstein–Uhlenbeck on log-price) ──────────
function hash01(s: string): number {
  // FNV-1a → [0,1)
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

const BASE_PRICE: Record<string, number> = {
  BTCUSD: 68000,
  XBTUSD: 68000,
  ETHUSD: 3500,
  SOLUSD: 160,
};

// Anchor so series are continuous within and across runs (deterministic by clock).
const ORIGIN_MS = Date.UTC(2026, 0, 1);

export class ReplayPriceFeed implements PriceFeed {
  readonly kind = "replay" as const;
  private sigma: number;
  private theta: number; // mean-reversion strength
  constructor(opts?: { sigma?: number; theta?: number }) {
    // Lower theta ⇒ trends persist longer (more catchable momentum) in this
    // synthetic demo market. Still mean-reverting so it never runs away.
    this.sigma = opts?.sigma ?? 0.012;
    this.theta = opts?.theta ?? 0.02;
  }

  private base(symbol: string): number {
    return BASE_PRICE[symbol] ?? 100;
  }

  /** Log-deviation from base at integer step, via a seeded OU walk from ORIGIN. */
  private logDevAtStep(symbol: string, step: number): number {
    let x = 0;
    const originStep = 0;
    for (let k = originStep + 1; k <= step; k++) {
      const shock = (hash01(`${symbol}:${k}`) - 0.5) * 2 * this.sigma;
      x = x * (1 - this.theta) + shock;
    }
    return x;
  }

  private priceAt(symbol: string, ms: number, intervalMs: number): number {
    const stepF = (ms - ORIGIN_MS) / intervalMs;
    const step = Math.floor(stepF);
    const frac = stepF - step;
    const a = this.logDevAtStep(symbol, step);
    const b = this.logDevAtStep(symbol, step + 1);
    const dev = a + (b - a) * frac; // linear interp for intra-step liveliness
    return this.base(symbol) * Math.exp(dev);
  }

  async getCandles(symbol: string, intervalMinutes: number, count: number): Promise<Candle[]> {
    const intervalMs = intervalMinutes * 60_000;
    const now = Date.now();
    const nowStep = Math.floor((now - ORIGIN_MS) / intervalMs);
    const out: Candle[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const step = nowStep - i;
      const t0 = ORIGIN_MS + step * intervalMs;
      const open = this.priceAt(symbol, t0, intervalMs);
      const close = this.priceAt(symbol, t0 + intervalMs - 1, intervalMs);
      const mid = this.priceAt(symbol, t0 + intervalMs / 2, intervalMs);
      const high = Math.max(open, close, mid) * (1 + 0.0008 * hash01(`${symbol}:h:${step}`));
      const low = Math.min(open, close, mid) * (1 - 0.0008 * hash01(`${symbol}:l:${step}`));
      out.push({
        time: Math.floor(t0 / 1000),
        open,
        high,
        low,
        close,
        volume: 100 + 50 * hash01(`${symbol}:v:${step}`),
      });
    }
    return out;
  }

  async getPrice(symbol: string): Promise<number> {
    return this.priceAt(symbol, Date.now(), 60_000);
  }
}

export function createPriceFeed(kind?: string): PriceFeed {
  const k = (kind ?? process.env.ARENA_PRICE_FEED ?? "live").toLowerCase();
  return k === "replay" ? new ReplayPriceFeed() : new LiveKrakenPriceFeed();
}
