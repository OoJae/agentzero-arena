/**
 * lib/isolation.ts — per-agent capital isolation (BUILD.md §4).
 *
 * `PaperCliProvider` (default): each agent gets its OWN `HOME`, which relocates the
 * Kraken CLI's paper state — VERIFIED isolation. Exercises the real `kraken paper`
 * surface; needs *.kraken.com reachable (paper buy/sell fetch the live ticker).
 *
 * `VirtualProvider` (fallback): simulates fills/fees/PnL internally from a PriceFeed.
 * Works fully offline; used when Kraken egress is blocked or isolation can't be trusted.
 *
 * Both honor the same interface so the agent loop is provider-agnostic.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { paperBuy, paperInit, paperSell, paperStatus } from "./kraken.js";
import type { PriceFeed } from "./priceFeed.js";
import type { AgentConfig, AgentEnv, Fill, PaperStatus, Proposal } from "./types.js";

export interface PortfolioStatus {
  equity: number;
  startingBalance: number;
  trades: number;
  positions: Record<string, number>; // symbol → base units held
  cash?: number;
}

export interface IsolationProvider {
  readonly kind: "paper-cli" | "virtual";
  init(agent: AgentConfig): Promise<void>;
  /** Execute a non-hold proposal at/around refPrice. Returns the fill, or null if skipped. */
  execute(agent: AgentConfig, proposal: Proposal, refPrice: number): Promise<Fill | null>;
  status(agent: AgentConfig): Promise<PortfolioStatus>;
}

const DEFAULT_FEE_RATE = 0.0026; // Kraken Starter taker (verified default)

// ─── PaperCliProvider (real `kraken paper`, isolated via HOME) ────────────────
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
    const home = this.homeFor(agent);
    mkdirSync(home, { recursive: true });
    const marker = resolve(this.dataDir, "agents", agent.id, ".initialized");
    if (existsSync(marker)) return; // idempotent across restarts
    await paperInit(this.envFor(agent), agent.startingBalance, agent.startingCurrency);
    writeFileSync(marker, new Date().toISOString());
  }

  async execute(agent: AgentConfig, proposal: Proposal, refPrice: number): Promise<Fill | null> {
    if (proposal.action === "hold") return null;
    const env = this.envFor(agent);
    const raw =
      proposal.action === "buy"
        ? await paperBuy(env, proposal.symbol, proposal.size, { type: "market" })
        : await paperSell(env, proposal.symbol, proposal.size, { type: "market" });
    const { price, fee } = parsePaperFill(raw, refPrice, proposal.size);
    return {
      side: proposal.action,
      symbol: proposal.symbol,
      price,
      size: proposal.size,
      fee,
      mode: "paper",
      raw,
    };
  }

  async status(agent: AgentConfig): Promise<PortfolioStatus> {
    const s: PaperStatus = await paperStatus(this.envFor(agent));
    return {
      equity: s.current_value,
      startingBalance: s.starting_balance ?? agent.startingBalance,
      trades: s.total_trades ?? 0,
      positions: {}, // detailed positions parsed in a later phase
    };
  }
}

/** Best-effort fill extraction from a paper buy/sell envelope (shape unverified offline). */
function parsePaperFill(raw: unknown, refPrice: number, size: number): { price: number; fee: number } {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const price = Number(o.price ?? o.fill_price ?? o.avg_price ?? refPrice);
    const fee = Number(o.fee ?? o.fees ?? price * size * DEFAULT_FEE_RATE);
    return {
      price: Number.isFinite(price) ? price : refPrice,
      fee: Number.isFinite(fee) ? fee : refPrice * size * DEFAULT_FEE_RATE,
    };
  }
  return { price: refPrice, fee: refPrice * size * DEFAULT_FEE_RATE };
}

// ─── VirtualProvider (offline simulation) ────────────────────────────────────
interface VirtualAccount {
  cash: number;
  startingBalance: number;
  positions: Map<string, number>; // symbol → base units
  trades: number;
  feeRate: number;
}

export class VirtualProvider implements IsolationProvider {
  readonly kind = "virtual" as const;
  private accounts = new Map<string, VirtualAccount>();
  constructor(private feed: PriceFeed) {}

  async init(agent: AgentConfig): Promise<void> {
    if (this.accounts.has(agent.id)) return;
    this.accounts.set(agent.id, {
      cash: agent.startingBalance,
      startingBalance: agent.startingBalance,
      positions: new Map(),
      trades: 0,
      feeRate: DEFAULT_FEE_RATE,
    });
  }

  private acct(agent: AgentConfig): VirtualAccount {
    const a = this.accounts.get(agent.id);
    if (!a) throw new Error(`VirtualProvider: agent ${agent.id} not initialized`);
    return a;
  }

  async execute(agent: AgentConfig, proposal: Proposal, refPrice: number): Promise<Fill | null> {
    if (proposal.action === "hold" || proposal.size <= 0 || !Number.isFinite(refPrice)) return null;
    const a = this.acct(agent);
    const price = refPrice;

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

    // sell — clamp to held quantity (no shorting in Phase 1)
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

  async status(agent: AgentConfig): Promise<PortfolioStatus> {
    const a = this.acct(agent);
    let positionsValue = 0;
    const positions: Record<string, number> = {};
    for (const [symbol, qty] of a.positions) {
      if (qty <= 1e-12) continue;
      positions[symbol] = qty;
      const px = await this.feed.getPrice(symbol);
      if (Number.isFinite(px)) positionsValue += qty * px;
    }
    return {
      equity: a.cash + positionsValue,
      startingBalance: a.startingBalance,
      trades: a.trades,
      positions,
      cash: a.cash,
    };
  }
}

export function createIsolation(feed: PriceFeed, kind?: string, dataDir = "./data"): IsolationProvider {
  const k = (kind ?? process.env.ARENA_ISOLATION_PROVIDER ?? "paper-cli").toLowerCase();
  if (k === "virtual") return new VirtualProvider(feed);
  return new PaperCliProvider(dataDir);
}
