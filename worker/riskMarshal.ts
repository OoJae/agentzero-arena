/**
 * worker/riskMarshal.ts — the deterministic supervisor (BUILD.md §6).
 *
 * Enforcement is DETERMINISTIC (reliable on camera):
 *  - preTradeCheck: veto/clamp every proposed order (benched, position cap, exposure cap, order-rate).
 *  - postTradeMonitor: continuous drawdown watch; benches an agent that breaches its profile.
 *  - bench: mark BENCHED → flatten positions (recorded + audited) → loud risk event (+ kill-switch note).
 * Narration is an OPTIONAL, async LLM flavor layer — never blocks the bench (the deterministic
 * event text is the source of truth). The real `cancel-after` dead-man's switch is the live finale (Phase 4).
 */
import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "../lib/audit.js";
import { insertRiskEvent, insertTrade, setAgentStatus, updateRiskEventDetail } from "../lib/db.js";
import { SPOT_FEE_RATE, type IsolationProvider, type PortfolioStatus } from "../lib/isolation.js";
import type { AgentConfig, Proposal, Verdict } from "../lib/types.js";

export interface RiskNarration {
  (input: { agent: AgentConfig; reason: string; flattened: number }): Promise<string | null>;
}

export class RiskMarshal {
  private benched = new Set<string>();
  private orderTimes = new Map<string, number[]>(); // agentId → recent approved-order timestamps

  constructor(
    private db: DatabaseSync,
    private isolation: IsolationProvider,
    private narrate?: RiskNarration,
  ) {}

  isBenched(agentId: string): boolean {
    return this.benched.has(agentId);
  }

  // ─── Deterministic pre-trade veto ──────────────────────────────────────────
  preTradeCheck(agent: AgentConfig, proposal: Proposal, status: PortfolioStatus, price: number): Verdict {
    if (this.benched.has(agent.id)) return { approved: false, reason: "agent is benched", clampedSize: 0 };
    if (proposal.action === "hold") return { approved: false, reason: "agent chose to hold", clampedSize: 0 };
    if (!Number.isFinite(price) || price <= 0) return { approved: false, reason: "no valid price", clampedSize: 0 };

    // 1) single-position cap
    let size = Math.min(proposal.size, (agent.maxPositionPct * status.equity) / price);

    // 1b) spot-buy affordability clamp — never emit an order the CLI will reject for
    //     insufficient cash. Spot only (futures use margin/leverage, not cash).
    if (agent.venue === "spot" && proposal.action === "buy" && status.cash != null) {
      const affordable = status.cash / (price * (1 + SPOT_FEE_RATE));
      size = Math.min(size, affordable);
      if (size <= 1e-9) {
        return { approved: false, reason: `insufficient cash ($${status.cash.toFixed(2)}) for ${proposal.symbol}`, clampedSize: 0 };
      }
    }

    // 2) gross-exposure cap (per proposal symbol): only constrain orders that INCREASE exposure
    const current = status.positions[proposal.symbol] ?? 0;
    const increasing = (proposal.action === "buy" && current >= 0) || (proposal.action === "sell" && current <= 0);
    if (increasing) {
      const capNotional = (agent.maxExposurePct / 100) * status.equity;
      const room = Math.max(0, capNotional - Math.abs(current) * price);
      size = Math.min(size, room / price);
      if (size <= 1e-9) {
        return { approved: false, reason: `exposure cap ${agent.maxExposurePct}% reached on ${proposal.symbol}`, clampedSize: 0 };
      }
    }

    // 3) order-rate limit
    const now = Date.now();
    const times = (this.orderTimes.get(agent.id) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= agent.maxOrdersPerMin) {
      this.orderTimes.set(agent.id, times);
      return { approved: false, reason: `order-rate limit (${agent.maxOrdersPerMin}/min)`, clampedSize: 0 };
    }

    if (size <= 1e-9) return { approved: false, reason: "size clamped to zero", clampedSize: 0 };
    times.push(now);
    this.orderTimes.set(agent.id, times);
    return { approved: true, reason: "pre-trade ok (within limits)", clampedSize: size };
  }

  // ─── Continuous monitor (called from the fast snapshot loop) ────────────────
  async postTradeMonitor(
    agent: AgentConfig,
    snapshot: { drawdownPct: number; equity: number },
  ): Promise<boolean> {
    if (this.benched.has(agent.id)) return false;
    if (snapshot.drawdownPct < -agent.maxDrawdownPct) {
      await this.bench(
        agent,
        `drawdown ${snapshot.drawdownPct.toFixed(1)}% exceeded the −${agent.maxDrawdownPct}% limit`,
      );
      return true;
    }
    return false;
  }

  // ─── Bench: flatten + loud event + audit (+ optional async narration) ───────
  async bench(agent: AgentConfig, reason: string): Promise<void> {
    if (this.benched.has(agent.id)) return;
    this.benched.add(agent.id);
    setAgentStatus(this.db, agent.id, "BENCHED");

    let fills = 0;
    try {
      const flat = await this.isolation.flatten(agent);
      fills = flat.length;
      for (const f of flat) {
        insertTrade(this.db, agent.id, null, Date.now(), f.side, f.symbol, f.price, f.size, f.fee, f.mode, f.cliOrderId ?? null, JSON.stringify(f.raw ?? null));
        appendAudit(this.db, "fill", { agentId: agent.id, benchFlatten: true, ...f }, Date.now());
      }
    } catch (err) {
      reason += ` (flatten error: ${(err as Error).message})`;
    }

    const ts = Date.now();
    const detail = `${agent.name} benched — ${reason}; ${fills} position(s) flattened; kill-switch armed`;
    const eventId = insertRiskEvent(this.db, agent.id, ts, "BENCH", detail, "flatten+killswitch");
    appendAudit(this.db, "risk_bench", { agentId: agent.id, reason, flattened: fills }, ts);

    // Optional LLM narration — non-blocking; deterministic detail already persisted.
    if (this.narrate) {
      this.narrate({ agent, reason, flattened: fills })
        .then((text) => {
          if (text) updateRiskEventDetail(this.db, eventId, `${detail} — “${text}”`);
        })
        .catch(() => {});
    }
  }
}
