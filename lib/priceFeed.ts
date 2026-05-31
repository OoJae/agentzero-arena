/**
 * lib/priceFeed.ts — price source abstraction (spot + futures).
 *
 * `LiveKrakenPriceFeed` uses the real CLI (`ticker`/`ohlc` for spot, `futures ticker`
 * for perps) — the default on a network-enabled host. `ReplayPriceFeed` is a
 * deterministic offline market (incl. synthesized funding rates) so the arena and its
 * demo run even where *.kraken.com is blocked, and as reproducible backup footage.
 */
import { futuresTicker, ohlc, ticker } from "./kraken.js";
import type { Candle, FuturesTickerData } from "./types.js";

export function isFuturesSymbol(symbol: string): boolean {
  return /^(PF_|PI_|FI_)/.test(symbol);
}

export interface PriceFeed {
  readonly kind: "live" | "replay";
  getCandles(symbol: string, intervalMinutes: number, count: number): Promise<Candle[]>;
  getPrice(symbol: string): Promise<number>;
  getFuturesTicker(symbol: string): Promise<FuturesTickerData>;
}

// ─── Live ────────────────────────────────────────────────────────────────────
export class LiveKrakenPriceFeed implements PriceFeed {
  readonly kind = "live" as const;

  async getCandles(symbol: string, intervalMinutes: number, count: number): Promise<Candle[]> {
    if (isFuturesSymbol(symbol)) return []; // futures have no REST OHLC; agents use change24h
    const all = await ohlc(symbol, intervalMinutes);
    return all.slice(-count);
  }

  async getPrice(symbol: string): Promise<number> {
    if (isFuturesSymbol(symbol)) return (await futuresTicker(symbol)).last;
    return (await ticker(symbol)).last;
  }

  async getFuturesTicker(symbol: string): Promise<FuturesTickerData> {
    return futuresTicker(symbol);
  }
}

// ─── Deterministic offline market (Ornstein–Uhlenbeck on log-price) ──────────
function hash01(s: string): number {
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
  PF_XBTUSD: 73000,
  PF_ETHUSD: 2000,
  PF_SPXUSD: 0.32,
  PF_QQQXUSD: 0.5,
};

const ORIGIN_MS = Date.UTC(2026, 0, 1);

export class ReplayPriceFeed implements PriceFeed {
  readonly kind = "replay" as const;
  private sigma: number;
  private theta: number;
  constructor(opts?: { sigma?: number; theta?: number }) {
    this.sigma = opts?.sigma ?? 0.012;
    this.theta = opts?.theta ?? 0.02;
  }

  private base(symbol: string): number {
    return BASE_PRICE[symbol] ?? 100;
  }

  private logDevAtStep(symbol: string, step: number): number {
    let x = 0;
    for (let k = 1; k <= step; k++) {
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
    return this.base(symbol) * Math.exp(a + (b - a) * frac);
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

  async getFuturesTicker(symbol: string): Promise<FuturesTickerData> {
    const last = this.priceAt(symbol, Date.now(), 60_000);
    const dayAgo = this.priceAt(symbol, Date.now() - 86_400_000, 60_000);
    const change24h = dayAgo !== 0 ? ((last - dayAgo) / dayAgo) * 100 : 0;
    // Funding oscillates +/- so the carry agent flips sides over time (deterministic).
    const phase = (Date.now() / 3.6e6 + hash01(symbol) * 10) % (2 * Math.PI);
    const fundingRate = 0.0004 * Math.sin(phase);
    return {
      symbol,
      last,
      markPrice: last,
      indexPrice: last,
      fundingRate,
      fundingRatePrediction: 0.0004 * Math.sin(phase + 0.3),
      change24h,
    };
  }
}

export function createPriceFeed(kind?: string): PriceFeed {
  const k = (kind ?? process.env.ARENA_PRICE_FEED ?? "live").toLowerCase();
  return k === "replay" ? new ReplayPriceFeed() : new LiveKrakenPriceFeed();
}
