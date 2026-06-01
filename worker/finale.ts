/**
 * worker/finale.ts — the live-money finale orchestrator (BUILD.md §10).
 *
 * Promotes the tournament leader to a tiny REAL crypto spot fill, behind `--validate`
 * first and the real `cancel-after` dead-man's switch + heartbeat.
 *
 * SAFETY (non-negotiable, defense in depth):
 *  - REHEARSAL BY DEFAULT. A real order requires ALL of: opts.live === true, the env
 *    flag ARENA_FINALE_ARMED === "YES", and non-empty KRAKEN_API_KEY/SECRET. Missing
 *    any ⇒ it hard-refuses the real order and runs a local rehearsal (no funds touched).
 *  - Notional is hard-capped (MAX_NOTIONAL_USD). Crypto spot only (never xStocks).
 *  - `--validate` dry-run always runs first. `cancel-after` is armed immediately after a
 *    real fill and re-armed on a heartbeat; on completion it is disabled (cancel-after 0).
 *  - Withdrawals must be OFF on the key (operator's responsibility; least-privilege).
 */
import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "../lib/audit.js";
import { insertRiskEvent, insertTrade, saveFinaleState, setAgentStatus } from "../lib/db.js";
import { cancelAfter, orderBuyLive, ticker } from "../lib/kraken.js";
import type { AgentEnv, FinaleState } from "../lib/types.js";

const MAX_NOTIONAL_USD = 50; // hard cap regardless of input
const DEFAULT_NOTIONAL_USD = 20;
const CANCEL_AFTER_SECS = 60;
const HEARTBEAT_MS = 30_000; // re-arm well inside the 60s window

export interface FinaleOpts {
  live?: boolean;
  asset?: string; // crypto spot pair, default BTCUSD
  notionalUsd?: number;
}

export interface LeaderInfo {
  id: string;
  name: string;
  equity: number;
}

/** Highest-equity agent that is not benched. */
export function resolveLeader(db: DatabaseSync): LeaderInfo | null {
  const row = db
    .prepare(
      `SELECT a.id, a.name,
              (SELECT equity FROM equity_snapshots e WHERE e.agent_id = a.id ORDER BY e.ts DESC LIMIT 1) AS equity
       FROM agents a
       WHERE a.status != 'BENCHED'
       ORDER BY equity DESC NULLS LAST
       LIMIT 1`,
    )
    .get() as { id: string; name: string; equity: number | null } | undefined;
  if (!row) return null;
  return { id: row.id, name: row.name, equity: row.equity ?? 0 };
}

/** True only when a real order is fully authorized (defense in depth). */
export function realOrderAuthorized(live: boolean): { ok: boolean; reason: string } {
  if (!live) return { ok: false, reason: "rehearsal (no --live)" };
  if (process.env.ARENA_FINALE_ARMED !== "YES") return { ok: false, reason: "ARENA_FINALE_ARMED!=YES" };
  if (!process.env.KRAKEN_API_KEY || !process.env.KRAKEN_API_SECRET) return { ok: false, reason: "no Kraken credentials" };
  return { ok: true, reason: "armed" };
}

function publish(db: DatabaseSync, s: FinaleState): FinaleState {
  s.updatedAt = Date.now();
  saveFinaleState(db, s);
  return s;
}

export async function runFinale(db: DatabaseSync, opts: FinaleOpts = {}): Promise<FinaleState> {
  const live = opts.live === true;
  const asset = opts.asset ?? "BTCUSD";
  const notionalUsd = Math.min(opts.notionalUsd ?? DEFAULT_NOTIONAL_USD, MAX_NOTIONAL_USD);
  const env: AgentEnv = { home: `${process.env.ARENA_DATA_DIR ?? "./data"}/finale-home` };
  const auth = realOrderAuthorized(live);

  const state: FinaleState = {
    phase: "resolving",
    live: auth.ok,
    leader: null,
    asset,
    size: 0,
    notionalUsd,
    validateAccepted: null,
    fill: null,
    balanceDelta: null,
    cancelAfterArmed: false,
    secondsRemaining: null,
    message: auth.ok ? "LIVE finale armed" : `REHEARSAL — ${auth.reason}; no real order will be placed`,
    updatedAt: Date.now(),
  };
  publish(db, state);
  appendAudit(db, "finale_start", { live: auth.ok, asset, notionalUsd, authReason: auth.reason });

  // 1) resolve leader
  const leader = resolveLeader(db);
  if (!leader) {
    state.phase = "error";
    state.message = "no eligible leader (all benched or no agents)";
    return publish(db, state);
  }
  state.leader = leader.name;

  // 2) size from live price (tiny)
  let price: number;
  try {
    price = (await ticker(asset)).last;
  } catch (err) {
    state.phase = "error";
    state.message = `could not fetch ${asset} price: ${(err as Error).message}`;
    return publish(db, state);
  }
  if (!Number.isFinite(price) || price <= 0) {
    state.phase = "error";
    state.message = `invalid ${asset} price`;
    return publish(db, state);
  }
  state.size = Number((notionalUsd / price).toFixed(8));
  state.phase = "validating";
  publish(db, state);

  // 3) --validate dry-run (safe even without auth; will simply report)
  try {
    const out = await orderBuyLive(env, asset, state.size, { type: "market", validate: true });
    state.validateAccepted = true;
    state.phase = "validated";
    state.message = `--validate accepted: buy ${state.size} ${asset} (~$${notionalUsd})`;
    appendAudit(db, "finale_validate", { asset, size: state.size, accepted: true, raw: out });
  } catch (err) {
    // In rehearsal without creds, validate may fail on auth — treat as "rehearsed".
    state.validateAccepted = auth.ok ? false : null;
    state.phase = auth.ok ? "error" : "validated";
    state.message = auth.ok
      ? `--validate failed: ${(err as Error).message}`
      : `rehearsal: --validate skipped (${(err as Error).message.slice(0, 60)})`;
    appendAudit(db, "finale_validate", { asset, size: state.size, accepted: false, error: (err as Error).message });
    if (auth.ok) return publish(db, state); // a real run must not proceed past a failed validate
  }
  publish(db, state);

  // 4) execute — REAL only if fully authorized; otherwise simulate locally
  if (auth.ok) {
    try {
      const raw = await orderBuyLive(env, asset, state.size, { type: "market", validate: false });
      const fill = parseLiveFill(raw, price, state.size);
      state.fill = fill;
      state.balanceDelta = -(fill.price * fill.size + fill.fee);
      state.phase = "live";
      insertTrade(db, leader.id, null, Date.now(), "buy", asset, fill.price, fill.size, fill.fee, "live", null, JSON.stringify(raw));
      appendAudit(db, "finale_fill", { agentId: leader.id, asset, ...fill, mode: "live" });
    } catch (err) {
      state.phase = "error";
      state.message = `LIVE order failed: ${(err as Error).message}`;
      appendAudit(db, "finale_fill_error", { error: (err as Error).message });
      return publish(db, state);
    }

    // 5) arm the dead-man's switch + heartbeat
    try {
      await cancelAfter(env, CANCEL_AFTER_SECS);
      state.cancelAfterArmed = true;
      state.secondsRemaining = CANCEL_AFTER_SECS;
      state.phase = "armed";
      appendAudit(db, "finale_cancel_after", { seconds: CANCEL_AFTER_SECS, armed: true });
      startHeartbeat(db, env, state);
    } catch (err) {
      state.message = `cancel-after arm failed: ${(err as Error).message}`;
      appendAudit(db, "finale_cancel_after_error", { error: (err as Error).message });
    }
  } else {
    // rehearsal fill (no funds touched)
    const fee = price * state.size * 0.0026;
    state.fill = { price, size: state.size, fee };
    state.balanceDelta = -(price * state.size + fee);
    state.cancelAfterArmed = true; // simulated
    state.secondsRemaining = CANCEL_AFTER_SECS;
    state.phase = "armed";
    state.message = `REHEARSAL complete — simulated buy ${state.size} ${asset}; dead-man's switch (simulated) armed`;
    appendAudit(db, "finale_fill", { agentId: leader.id, asset, ...state.fill, mode: "rehearsal" });
    startRehearsalCountdown(db, state);
  }

  setAgentStatus(db, leader.id, "LIVE");
  insertRiskEvent(
    db,
    leader.id,
    Date.now(),
    "LIVE_FINALE",
    `${leader.name} promoted to LIVE — ${auth.ok ? "real" : "rehearsal"} buy ${state.size} ${asset} (~$${notionalUsd}); kill-switch armed`,
    "promote+killswitch",
  );
  return publish(db, state);
}

function parseLiveFill(raw: unknown, refPrice: number, size: number): { price: number; size: number; fee: number } {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const price = Number(o.price ?? o.avg_price ?? o.fill_price ?? refPrice);
    const fee = Number(o.fee ?? o.fees ?? (Number.isFinite(price) ? price : refPrice) * size * 0.0026);
    return { price: Number.isFinite(price) ? price : refPrice, size, fee: Number.isFinite(fee) ? fee : refPrice * size * 0.0026 };
  }
  return { price: refPrice, size, fee: refPrice * size * 0.0026 };
}

/** Re-arm cancel-after on a heartbeat; tick down the UI countdown. Live only. */
function startHeartbeat(db: DatabaseSync, env: AgentEnv, state: FinaleState): void {
  const heartbeat = setInterval(() => {
    cancelAfter(env, CANCEL_AFTER_SECS)
      .then(() => {
        state.secondsRemaining = CANCEL_AFTER_SECS;
        appendAudit(db, "finale_heartbeat", { reArmed: CANCEL_AFTER_SECS });
        publish(db, state);
      })
      .catch(() => {});
  }, HEARTBEAT_MS);
  const tick = setInterval(() => {
    if (state.secondsRemaining != null) state.secondsRemaining = Math.max(0, state.secondsRemaining - 1);
    publish(db, state);
  }, 1000);
  // Auto-stop the demo segment after 3 minutes: disable the switch cleanly.
  setTimeout(() => {
    clearInterval(heartbeat);
    clearInterval(tick);
    cancelAfter(env, 0).catch(() => {});
    state.phase = "done";
    state.cancelAfterArmed = false;
    state.secondsRemaining = null;
    state.message = `${state.leader} live segment complete; dead-man's switch disabled (cancel-after 0)`;
    appendAudit(db, "finale_done", { cancelAfter: 0 });
    publish(db, state);
  }, 180_000);
}

function startRehearsalCountdown(db: DatabaseSync, state: FinaleState): void {
  const tick = setInterval(() => {
    if (state.secondsRemaining != null) state.secondsRemaining = Math.max(0, state.secondsRemaining - 1);
    publish(db, state);
  }, 1000);
  setTimeout(() => {
    clearInterval(tick);
    state.phase = "done";
    state.cancelAfterArmed = false;
    state.secondsRemaining = null;
    state.message = `${state.leader} REHEARSAL segment complete (no funds were touched)`;
    publish(db, state);
  }, 75_000);
}
