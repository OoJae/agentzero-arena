/**
 * lib/isolation.ts — per-agent capital isolation (BUILD.md §4), venue-aware.
 *
 * `PaperCliProvider` (default): each agent gets its own `HOME`, relocating the CLI's
 * paper state — VERIFIED for BOTH spot (`kraken paper`) and futures (`kraken futures
 * paper`). Exercises the real CLI; needs *.kraken.com reachable.
 *
 * `VirtualProvider` (fallback): simulates fills/PnL from a PriceFeed; works offline.
 * Spot is long-only (cash model); futures supports shorts (signed-position PnL model).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  futuresPaperBuy,
  futuresPaperInit,
  futuresPaperPositions,
  futuresPaperSell,
  futuresPaperStatus,
  paperBalance,
  paperBuy,
  paperInit,
  paperSell,
  paperStatus,
} from "./kraken.js";
import type { PriceFeed } from "./priceFeed.js";
import type {
  AgentConfig,
  AgentEnv,
  Fill,
  FuturesPaperStatus,
  PaperStatus,
  Proposal,
} from "./types.js";

export interface PortfolioStatus {
  equity: number;
  startingBalance: number;
  trades: number;
  positions: Record<string, number>; // symbol → signed units (spot ≥0; futures signed)
  cash?: number;
}

export interface IsolationProvider {
  readonly kind: "paper-cli" | "virtual";
  init(agent: AgentConfig): Promise<void>;
  /** Execute a non-hold proposal at/around refPrice. Returns the fill, or null if skipped. */
  execute(agent: AgentConfig, proposal: Proposal, refPrice: number): Promise<Fill | null>;
  status(agent: AgentConfig): Promise<PortfolioStatus>;
}

const SPOT_FEE_RATE = 0.0026; // Kraken Starter taker (spot paper default)
const FUTURES_FEE_RATE = 0.0005; // futures paper default

// ─── PaperCliProvider (real `kraken paper` / `kraken futures paper`) ──────────
export class PaperCliProvider implements IsolationProvider {
  readonly kind = "paper-cli" as const;
  constructor(private dataDir: string) {}

  private homeFor(agent: AgentConfig): string {
    return resolve(this.dataDir, "agents", agent.id, "home");
  }
  private envFor(agent: AgentConfig): AgentEnv {
    return { home: this.homeFor(agent) };
  }

  async init(agent: AgentConfig): Promise<void> {
    mkdirSync(this.homeFor(agent), { recursive: true });
    const marker = resolve(this.dataDir, "agents", agent.id, ".initialized");
    if (existsSync(marker)) return; // idempotent across restarts
    const env = this.envFor(agent);
    if (agent.venue === "futures") {
      await futuresPaperInit(env, agent.startingBalance, agent.startingCurrency);
    } else {
      await paperInit(env, agent.startingBalance, agent.startingCurrency);
    }
    writeFileSync(marker, new Date().toISOString());
  }

  async execute(agent: AgentConfig, proposal: Proposal, refPrice: number): Promise<Fill | null> {
    if (proposal.action === "hold") return null;
    const env = this.envFor(agent);
    const feeRate = agent.venue === "futures" ? FUTURES_FEE_RATE : SPOT_FEE_RATE;

    let raw: unknown;
    if (agent.venue === "futures") {
      const opts = { leverage: agent.maxLeverage, type: "market" as const };
      raw =
        proposal.action === "buy"
          ? await futuresPaperBuy(env, proposal.symbol, proposal.size, opts)
          : await futuresPaperSell(env, proposal.symbol, proposal.size, opts);
    } else {
      raw =
        proposal.action === "buy"
          ? await paperBuy(env, proposal.symbol, proposal.size, { type: "market" })
          : await paperSell(env, proposal.symbol, proposal.size, { type: "market" });
    }
    const { price, fee } = parseFill(raw, refPrice, proposal.size, feeRate);
    return { side: proposal.action, symbol: proposal.symbol, price, size: proposal.size, fee, mode: "paper", raw };
  }

  async status(agent: AgentConfig): Promise<PortfolioStatus> {
    const env = this.envFor(agent);
    if (agent.venue === "futures") {
      const s: FuturesPaperStatus = await futuresPaperStatus(env);
      let positions: Record<string, number> = {};
      try {
        positions = await parseFuturesPositions(futuresPaperPositions(env));
      } catch {
        positions = {};
      }
      return {
        equity: Number(s.equity ?? s.collateral ?? agent.startingBalance),
        startingBalance: Number(s.starting_collateral ?? agent.startingBalance),
        trades: Number(s.total_fills ?? 0),
        positions,
      };
    }
    const s: PaperStatus = await paperStatus(env);
    let positions: Record<string, number> = {};
    try {
      positions = await paperBalance(env);
    } catch {
      positions = {};
    }
    return {
      equity: s.current_value,
      startingBalance: s.starting_balance ?? agent.startingBalance,
      trades: s.total_trades ?? 0,
      positions,
    };
  }
}

async function parseFuturesPositions(p: Promise<unknown>): Promise<Record<string, number>> {
  const raw = await p;
  const out: Record<string, number> = {};
  const arr = (raw && typeof raw === "object" ? (raw as Record<string, unknown>).positions : null) as unknown;
  if (Array.isArray(arr)) {
    for (const r of arr) {
      if (r && typeof r === "object") {
        const o = r as Record<string, unknown>;
        const sym = String(o.symbol ?? o.instrument ?? "");
        let size = Number(o.size ?? o.quantity ?? o.contracts ?? 0);
        const side = String(o.side ?? "").toLowerCase();
        if (side === "short" || side === "sell") size = -Math.abs(size);
        if (sym && Number.isFinite(size)) out[sym] = size;
      }
    }
  }
  return out;
}

/** Best-effort fill extraction (verified spot shape: {price, fee, volume, cost}). */
function parseFill(raw: unknown, refPrice: number, size: number, feeRate: number): { price: number; fee: number } {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const price = Number(o.price ?? o.fill_price ?? o.avg_price ?? o.markPrice ?? refPrice);
    const fee = Number(o.fee ?? o.fees ?? (Number.isFinite(price) ? price : refPrice) * size * feeRate);
    return {
      price: Number.isFinite(price) ? price : refPrice,
      fee: Number.isFinite(fee) ? fee : refPrice * size * feeRate,
    };
  }
  return { price: refPrice, fee: refPrice * size * feeRate };
}

// ─── VirtualProvider (offline simulation) ────────────────────────────────────
interface SpotAccount {
  kind: "spot";
  cash: number;
  startingBalance: number;
  positions: Map<string, number>; // symbol → base units (≥0)
  trades: number;
  feeRate: number;
}
interface FuturesAccount {
  kind: "futures";
  startingBalance: number;
  realized: number; // realized PnL net of fees
  positions: Map<string, { size: number; entry: number }>; // signed size + avg entry
  trades: number;
  feeRate: number;
}
type VAccount = SpotAccount | FuturesAccount;

export class VirtualProvider implements IsolationProvider {
  readonly kind = "virtual" as const;
  private accounts = new Map<string, VAccount>();
  constructor(private feed: PriceFeed) {}

  async init(agent: AgentConfig): Promise<void> {
    if (this.accounts.has(agent.id)) return;
    if (agent.venue === "futures") {
      this.accounts.set(agent.id, {
        kind: "futures",
        startingBalance: agent.startingBalance,
        realized: 0,
        positions: new Map(),
        trades: 0,
        feeRate: FUTURES_FEE_RATE,
      });
    } else {
      this.accounts.set(agent.id, {
        kind: "spot",
        cash: agent.startingBalance,
        startingBalance: agent.startingBalance,
        positions: new Map(),
        trades: 0,
        feeRate: SPOT_FEE_RATE,
      });
    }
  }

  private acct(agent: AgentConfig): VAccount {
    const a = this.accounts.get(agent.id);
    if (!a) throw new Error(`VirtualProvider: agent ${agent.id} not initialized`);
    return a;
  }

  async execute(agent: AgentConfig, proposal: Proposal, refPrice: number): Promise<Fill | null> {
    if (proposal.action === "hold" || proposal.size <= 0 || !Number.isFinite(refPrice)) return null;
    const a = this.acct(agent);
    const price = refPrice;

    if (a.kind === "spot") {
      if (proposal.action === "buy") {
        const maxAffordable = a.cash / (price * (1 + a.feeRate));
        const size = Math.min(proposal.size, maxAffordable);
        if (size <= 1e-12) return null;
        const cost = size * price;
        const fee = cost * a.feeRate;
        a.cash -= cost + fee;
        a.positions.set(proposal.symbol, (a.positions.get(proposal.symbol) ?? 0) + size);
        a.trades += 1;
        return { side: "buy", symbol: proposal.symbol, price, size, fee, mode: "paper", raw: { simulated: true } };
      }
      const held = a.positions.get(proposal.symbol) ?? 0;
      const size = Math.min(proposal.size, held);
      if (size <= 1e-12) return null;
      const proceeds = size * price;
      const fee = proceeds * a.feeRate;
      a.cash += proceeds - fee;
      a.positions.set(proposal.symbol, held - size);
      a.trades += 1;
      return { side: "sell", symbol: proposal.symbol, price, size, fee, mode: "paper", raw: { simulated: true } };
    }

    // futures: signed position with average entry; shorts allowed.
    const signed = proposal.action === "buy" ? proposal.size : -proposal.size;
    const fee = Math.abs(proposal.size) * price * a.feeRate;
    a.realized -= fee;
    const cur = a.positions.get(proposal.symbol) ?? { size: 0, entry: price };
    const newSize = cur.size + signed;
    if (Math.sign(cur.size) === Math.sign(signed) || cur.size === 0) {
      // adding to / opening the position → weighted-average entry
      const entry = cur.size === 0 ? price : (cur.entry * Math.abs(cur.size) + price * Math.abs(signed)) / (Math.abs(cur.size) + Math.abs(signed));
      a.positions.set(proposal.symbol, { size: newSize, entry });
    } else {
      // reducing / flipping → realize PnL on the closed portion
      const closed = Math.min(Math.abs(signed), Math.abs(cur.size));
      a.realized += closed * (price - cur.entry) * Math.sign(cur.size);
      a.positions.set(proposal.symbol, { size: newSize, entry: Math.sign(newSize) === Math.sign(cur.size) ? cur.entry : price });
    }
    a.trades += 1;
    return { side: proposal.action, symbol: proposal.symbol, price, size: proposal.size, fee, mode: "paper", raw: { simulated: true } };
  }

  async status(agent: AgentConfig): Promise<PortfolioStatus> {
    const a = this.acct(agent);
    if (a.kind === "spot") {
      let positionsValue = 0;
      const positions: Record<string, number> = {};
      for (const [symbol, qty] of a.positions) {
        if (qty <= 1e-12) continue;
        positions[symbol] = qty;
        const px = await this.feed.getPrice(symbol);
        if (Number.isFinite(px)) positionsValue += qty * px;
      }
      return { equity: a.cash + positionsValue, startingBalance: a.startingBalance, trades: a.trades, positions, cash: a.cash };
    }
    // futures: equity = starting + realized + unrealized(mark)
    let unrealized = 0;
    const positions: Record<string, number> = {};
    for (const [symbol, pos] of a.positions) {
      if (Math.abs(pos.size) <= 1e-12) continue;
      positions[symbol] = pos.size;
      const px = await this.feed.getPrice(symbol);
      if (Number.isFinite(px)) unrealized += pos.size * (px - pos.entry);
    }
    return { equity: a.startingBalance + a.realized + unrealized, startingBalance: a.startingBalance, trades: a.trades, positions };
  }
}

export function createIsolation(feed: PriceFeed, kind?: string, dataDir = "./data"): IsolationProvider {
  const k = (kind ?? process.env.ARENA_ISOLATION_PROVIDER ?? "paper-cli").toLowerCase();
  if (k === "virtual") return new VirtualProvider(feed);
  return new PaperCliProvider(dataDir);
}
