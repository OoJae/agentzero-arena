/**
 * worker/agentRunner.ts — the shared agent tick loop (BUILD.md §5.2).
 *
 *   marketData → features → portfolio → claudeDecide → pre-trade check
 *   → isolated execute → equity snapshot → SQLite + hash-chained audit log
 *
 * Phase 1 ships a MINIMAL pre-trade check (size clamp only). The full deterministic
 * Risk Marshal (drawdown/exposure veto + benching + dead-man's switch) lands in Phase 3.
 */
import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "../lib/audit.js";
import {
  getPeakEquity,
  insertDecision,
  insertEquitySnapshot,
  insertTrade,
} from "../lib/db.js";
import type { IsolationProvider, PortfolioStatus } from "../lib/isolation.js";
import type { PriceFeed } from "../lib/priceFeed.js";
import type {
  AgentConfig,
  MomentumFeatures,
  Proposal,
  Verdict,
} from "../lib/types.js";

/** Context an agent assembles each tick from deterministic features. */
export interface TickContext {
  /** Features keyed by symbol (the LLM/fallback reason over these). */
  featuresBySymbol: Record<string, MomentumFeatures>;
  /** The candidate symbol the agent is most interested in this tick. */
  primarySymbol: string;
  /** Compact object serialized into the LLM user turn. */
  llmContext: Record<string, unknown>;
}

export interface FallbackInput {
  featuresBySymbol: Record<string, MomentumFeatures>;
  status: PortfolioStatus;
  maxSize: number;
  primarySymbol: string;
}

export interface AgentDefinition {
  config: AgentConfig;
  systemPrompt: string;
  /** Gather deterministic features + pick a candidate symbol. */
  gather(feed: PriceFeed, intervalMinutes: number, candleCount: number): Promise<TickContext>;
  /** Deterministic decision (used when no API key / on LLM error). */
  fallback(input: FallbackInput): Proposal;
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

  const primaryPrice = ctx.featuresBySymbol[ctx.primarySymbol]?.price ?? NaN;
  const maxSize =
    Number.isFinite(primaryPrice) && primaryPrice > 0
      ? (config.maxPositionPct * status.equity) / primaryPrice
      : 0;

  const proposal = await decide({
    agent: config,
    systemPrompt: def.systemPrompt,
    context: { ...ctx.llmContext, portfolio: status },
    maxSize,
    fallback: () => def.fallback({ featuresBySymbol: ctx.featuresBySymbol, status, maxSize, primarySymbol: ctx.primarySymbol }),
  });

  // ── Phase 1 pre-trade check: size clamp only (full Risk Marshal = Phase 3) ──
  const clampedSize = Math.min(proposal.size, maxSize);
  const verdict: Verdict = {
    approved: proposal.action !== "hold" && clampedSize > 0,
    reason: proposal.action === "hold" ? "agent chose to hold" : clampedSize > 0 ? "pre-trade size clamp ok" : "size clamped to zero",
    clampedSize,
  };

  const featuresJson = JSON.stringify(ctx.featuresBySymbol);
  const decisionId = insertDecision(db, config.id, ts, featuresJson, proposal, verdict);
  appendAudit(db, "decision", { agentId: config.id, ts, features: ctx.featuresBySymbol, proposal, verdict }, ts);

  let filled = false;
  if (verdict.approved) {
    const execPrice = ctx.featuresBySymbol[proposal.symbol]?.price ?? primaryPrice;
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
  const post = await isolation.status(config);
  const peak = Math.max(getPeakEquity(db, config.id, post.startingBalance), post.equity);
  const pnlPct = post.startingBalance > 0 ? (post.equity / post.startingBalance - 1) * 100 : 0;
  const drawdownPct = peak > 0 ? (post.equity / peak - 1) * 100 : 0;
  const snapTs = Date.now();
  insertEquitySnapshot(db, {
    agentId: config.id,
    ts: snapTs,
    equity: post.equity,
    pnlPct,
    peakEquity: peak,
    drawdownPct,
    positions: post.positions,
  });
  appendAudit(db, "equity", { agentId: config.id, ts: snapTs, equity: post.equity, pnlPct, drawdownPct }, snapTs);

  return {
    agentId: config.id,
    action: proposal.action,
    symbol: proposal.symbol,
    size: clampedSize,
    equity: post.equity,
    pnlPct,
    drawdownPct,
    filled,
  };
}
