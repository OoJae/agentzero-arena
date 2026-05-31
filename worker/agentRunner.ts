/**
 * worker/agentRunner.ts — the shared agent tick loop (BUILD.md §5.2), strategy-agnostic.
 *
 *   marketData → features → portfolio → decide → pre-trade check
 *   → isolated execute → equity snapshot → SQLite + hash-chained audit log
 *
 * Each agent's `gather()` does all strategy-specific work (compute features, pick a
 * candidate symbol, build the LLM context, and a deterministic fallback closure that
 * captures those features). `runTick` stays generic: it sizes/executes from a price
 * map and writes the snapshot. Phase 1 ships a MINIMAL pre-trade check (size clamp);
 * the full deterministic Risk Marshal lands in Phase 3.
 */
import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "../lib/audit.js";
import { getPeakEquity, insertDecision, insertEquitySnapshot, insertTrade } from "../lib/db.js";
import type { IsolationProvider, PortfolioStatus } from "../lib/isolation.js";
import type { PriceFeed } from "../lib/priceFeed.js";
import type { AgentConfig, Proposal, Verdict } from "../lib/types.js";

/** What an agent assembles each tick. `fallback` captures the strategy features. */
export interface TickContext {
  /** Current price per candidate symbol — used generically for sizing + execution. */
  priceBySymbol: Record<string, number>;
  /** The symbol the agent is most interested in this tick. */
  primarySymbol: string;
  /** Compact object serialized into the LLM user turn (strategy-specific features). */
  llmContext: Record<string, unknown>;
  /** Serialized features for the decisions.features_json column. */
  featuresJson: string;
  /** Deterministic decision (no API key / on LLM error), given the resolved limits. */
  fallback: (maxSize: number, status: PortfolioStatus) => Proposal;
}

export interface AgentDefinition {
  config: AgentConfig;
  systemPrompt: string;
  gather(feed: PriceFeed, intervalMinutes: number, candleCount: number): Promise<TickContext>;
}

export interface RunDeps {
  db: DatabaseSync;
  feed: PriceFeed;
  isolation: IsolationProvider;
  intervalMinutes: number;
  candleCount: number;
  decide: (args: {
    agent: AgentConfig;
    systemPrompt: string;
    context: Record<string, unknown>;
    maxSize: number;
    fallback: () => Proposal;
  }) => Promise<Proposal>;
}

export interface TickResult {
  agentId: string;
  action: string;
  symbol: string;
  size: number;
  equity: number;
  pnlPct: number;
  drawdownPct: number;
  filled: boolean;
}

export async function runTick(def: AgentDefinition, deps: RunDeps): Promise<TickResult> {
  const { db, feed, isolation, intervalMinutes, candleCount, decide } = deps;
  const config = def.config;
  const ts = Date.now();

  const ctx = await def.gather(feed, intervalMinutes, candleCount);
  const status = await isolation.status(config);

  const primaryPrice = ctx.priceBySymbol[ctx.primarySymbol] ?? NaN;
  const maxSize =
    Number.isFinite(primaryPrice) && primaryPrice > 0
      ? (config.maxPositionPct * status.equity) / primaryPrice
      : 0;

  const proposal = await decide({
    agent: config,
    systemPrompt: def.systemPrompt,
    context: { ...ctx.llmContext, portfolio: status },
    maxSize,
    fallback: () => ctx.fallback(maxSize, status),
  });

  // ── Phase 1/2 pre-trade check: size clamp only (full Risk Marshal = Phase 3) ──
  const clampedSize = Math.min(proposal.size, maxSize);
  const verdict: Verdict = {
    approved: proposal.action !== "hold" && clampedSize > 0,
    reason:
      proposal.action === "hold" ? "agent chose to hold" : clampedSize > 0 ? "pre-trade size clamp ok" : "size clamped to zero",
    clampedSize,
  };

  const decisionId = insertDecision(db, config.id, ts, ctx.featuresJson, proposal, verdict);
  appendAudit(db, "decision", { agentId: config.id, ts, features: safeJson(ctx.featuresJson), proposal, verdict }, ts);

  let filled = false;
  if (verdict.approved) {
    const execPrice = ctx.priceBySymbol[proposal.symbol] ?? primaryPrice;
    const fill = await isolation.execute(config, { ...proposal, size: clampedSize }, execPrice);
    if (fill) {
      filled = true;
      insertTrade(
        db,
        config.id,
        decisionId,
        Date.now(),
        fill.side,
        fill.symbol,
        fill.price,
        fill.size,
        fill.fee,
        fill.mode,
        fill.cliOrderId ?? null,
        JSON.stringify(fill.raw ?? null),
      );
      appendAudit(db, "fill", { agentId: config.id, ...fill }, Date.now());
    }
  }

  // ── Equity snapshot ──
  const snap = await recordSnapshot(db, isolation, config);

  return {
    agentId: config.id,
    action: proposal.action,
    symbol: proposal.symbol,
    size: clampedSize,
    equity: snap.equity,
    pnlPct: snap.pnlPct,
    drawdownPct: snap.drawdownPct,
    filled,
  };
}

/**
 * Fast equity snapshot (NO LLM): mark-to-market + drawdown, written to the DB + audit.
 * Runs on a frequent cadence so the leaderboard stays live even while slow LLM
 * decisions are in flight. Returns the computed snapshot.
 */
export async function recordSnapshot(
  db: DatabaseSync,
  isolation: IsolationProvider,
  config: AgentConfig,
): Promise<{ equity: number; pnlPct: number; drawdownPct: number }> {
  const post = await isolation.status(config);
  const peak = Math.max(getPeakEquity(db, config.id, post.startingBalance), post.equity);
  const pnlPct = post.startingBalance > 0 ? (post.equity / post.startingBalance - 1) * 100 : 0;
  const drawdownPct = peak > 0 ? (post.equity / peak - 1) * 100 : 0;
  const ts = Date.now();
  insertEquitySnapshot(db, {
    agentId: config.id,
    ts,
    equity: post.equity,
    pnlPct,
    peakEquity: peak,
    drawdownPct,
    positions: post.positions,
  });
  appendAudit(db, "equity", { agentId: config.id, ts, equity: post.equity, pnlPct, drawdownPct }, ts);
  return { equity: post.equity, pnlPct, drawdownPct };
}

export async function snapshotAgent(config: AgentConfig, deps: Pick<RunDeps, "db" | "isolation">): Promise<void> {
  await recordSnapshot(deps.db, deps.isolation, config);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
