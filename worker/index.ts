/**
 * AgentZero Arena — agent runtime (long-lived worker).
 *
 * Decoupled scheduler: a fast snapshot loop (mark-to-market equity, NO LLM) keeps the
 * leaderboard live while a slower, non-overlapping decision loop runs the LLM. A
 * per-agent CLI mutex (`busy`) serializes ALL CLI access for an agent — decision,
 * snapshot, and bench — because `futures paper` locks its state file. The Risk Marshal
 * vetoes orders pre-trade and benches agents that breach their drawdown profile; an
 * operator can also force a bench on cue via `data/force-bench.json` (scripts/force-breach.ts).
 *
 * Not serverless. Run via `tsx worker/index.ts` (or `pnpm dev` for web+worker). Run ONE worker.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { appendAudit } from "../lib/audit.js";
import { clearFinaleState, clearRiskEvents, getDb, setAgentStatus, upsertAgent } from "../lib/db.js";
import { createIsolation } from "../lib/isolation.js";
import { createPriceFeed } from "../lib/priceFeed.js";
import { runTick, snapshotAgent, type AgentDefinition, type RunDeps } from "./agentRunner.js";
import { claudeDecide, narrateRiskEvent } from "./decide.js";
import { runFinale } from "./finale.js";
import { RiskMarshal } from "./riskMarshal.js";
import { momentumAgent } from "./agents/momentum.js";
import { meanReversionAgent } from "./agents/meanReversion.js";
import { fundingCarryAgent } from "./agents/fundingCarry.js";
import { macroHedgeAgent } from "./agents/macroHedge.js";

// Load .env then .env.local (local overrides). Paper mode needs no secrets.
for (const f of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* file absent — ignore */
  }
}

const TICK_SECONDS = Number(process.env.ARENA_TICK_SECONDS ?? 20); // LLM decision cadence
const SNAPSHOT_SECONDS = Number(process.env.ARENA_SNAPSHOT_SECONDS ?? 5); // fast equity cadence
const OHLC_INTERVAL_MIN = Number(process.env.ARENA_OHLC_INTERVAL ?? 60);
const CANDLE_COUNT = Number(process.env.ARENA_CANDLE_COUNT ?? 50);
const DATA_DIR = process.env.ARENA_DATA_DIR ?? "./data";
const FORCE_BENCH_FILE = resolve(DATA_DIR, "force-bench.json");
const FINALE_TRIGGER_FILE = resolve(DATA_DIR, "finale-trigger.json");
// On a single-worker deployment, start each boot from a clean display state (clears
// demo residue: BENCH/VETO/LIVE_FINALE events + transient finale panel). The audit
// chain is NEVER wiped. Set to "0"/"false" to preserve events across restarts.
const RESET_EVENTS_ON_BOOT = (process.env.ARENA_RESET_EVENTS_ON_BOOT ?? "1") !== "0" &&
  (process.env.ARENA_RESET_EVENTS_ON_BOOT ?? "true").toLowerCase() !== "false";

const AGENTS: AgentDefinition[] = [momentumAgent, meanReversionAgent, fundingCarryAgent, macroHedgeAgent];

function log(msg: string, extra?: Record<string, unknown>) {
  console.log(`[worker ${new Date().toISOString()}] ${msg}`, extra ? JSON.stringify(extra) : "");
}

async function main() {
  const feed = createPriceFeed();
  const isolation = createIsolation(feed, undefined, DATA_DIR);
  const db = getDb();
  const marshal = new RiskMarshal(db, isolation, narrateRiskEvent);

  log("booting AgentZero Arena worker", {
    node: process.version,
    isolation: isolation.kind,
    priceFeed: feed.kind,
    anthropicKey: process.env.ANTHROPIC_API_KEY ? "set" : "absent (deterministic fallback)",
    tickSeconds: TICK_SECONDS,
  });
  log("database ready (WAL)");

  // Clean display state on boot (does NOT touch the audit chain).
  if (RESET_EVENTS_ON_BOOT) {
    clearRiskEvents(db);
    clearFinaleState(db);
    log("display reset: risk_events + finale state cleared (audit chain preserved)");
  }

  const deps: RunDeps = {
    db,
    feed,
    isolation,
    marshal,
    intervalMinutes: OHLC_INTERVAL_MIN,
    candleCount: CANDLE_COUNT,
    decide: claudeDecide,
  };

  // Register + isolate each agent before its first tick (fresh ACTIVE each boot).
  for (const def of AGENTS) {
    upsertAgent(db, def.config);
    setAgentStatus(db, def.config.id, "ACTIVE");
    await isolation.init(def.config);
    log(`agent ready: ${def.config.name} (${def.config.strategy})`, {
      symbols: def.config.allowedSymbols,
      risk: { ddPct: def.config.maxDrawdownPct, expPct: def.config.maxExposurePct, ordersMin: def.config.maxOrdersPerMin },
    });
  }
  appendAudit(db, "arena_start", { agents: AGENTS.map((a) => a.config.id), isolation: isolation.kind, priceFeed: feed.kind });

  const timers: NodeJS.Timeout[] = [];
  let running = true;
  const busy = new Set<string>(); // per-agent CLI mutex: decision | snapshot | bench in progress

  // Slow loop: full LLM decision + execute. Skipped if the agent's CLI is busy or benched.
  async function decisionTick(def: AgentDefinition) {
    const id = def.config.id;
    if (!running || busy.has(id) || marshal.isBenched(id)) return;
    busy.add(id);
    try {
      const r = await runTick(def, deps);
      log(
        `${def.config.name}: ${r.action}${r.filled ? " (filled)" : ""} ${r.size > 0 ? r.size.toFixed(6) + " " + r.symbol : ""} | equity $${r.equity.toFixed(2)} (${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(2)}%) dd ${r.drawdownPct.toFixed(2)}%`,
      );
    } catch (err) {
      log(`${def.config.name}: decision error — ${(err as Error).message}`);
    } finally {
      busy.delete(id);
    }
  }

  // Operator-triggered bench (scripts/force-breach.ts writes data/force-bench.json).
  async function checkForceBench() {
    if (!existsSync(FORCE_BENCH_FILE)) return;
    let payload: { agentId?: string; reason?: string };
    try {
      payload = JSON.parse(readFileSync(FORCE_BENCH_FILE, "utf8"));
    } catch {
      rmSync(FORCE_BENCH_FILE, { force: true });
      return;
    }
    const def = AGENTS.find((a) => a.config.id === payload.agentId);
    if (!def || marshal.isBenched(def.config.id)) {
      rmSync(FORCE_BENCH_FILE, { force: true });
      return;
    }
    if (busy.has(def.config.id)) return; // CLI busy — retry next tick (keep the file)
    busy.add(def.config.id);
    try {
      await marshal.bench(def.config, payload.reason || "manual breach (demo)");
      rmSync(FORCE_BENCH_FILE, { force: true });
      log(`Risk Marshal: ⛔ BENCHED ${def.config.name} — ${payload.reason || "manual breach (demo)"}`);
    } finally {
      busy.delete(def.config.id);
    }
  }

  // Operator-triggered finale REHEARSAL (the dashboard button POSTs /api/finale, which
  // drops data/finale-trigger.json). Always rehearsal — `live:false` hard-coded here, so
  // the web button can never place a real order. runFinale self-manages its countdown timers.
  let finaleInFlight = false;
  async function checkFinaleTrigger() {
    if (!existsSync(FINALE_TRIGGER_FILE)) return;
    let payload: { notionalUsd?: number; asset?: string };
    try {
      payload = JSON.parse(readFileSync(FINALE_TRIGGER_FILE, "utf8"));
    } catch {
      rmSync(FINALE_TRIGGER_FILE, { force: true });
      return;
    }
    rmSync(FINALE_TRIGGER_FILE, { force: true });
    if (finaleInFlight) return;
    finaleInFlight = true;
    log(`Finale: rehearsal triggered (~$${payload.notionalUsd ?? 20} ${payload.asset ?? "BTCUSD"})`);
    runFinale(db, { live: false, notionalUsd: payload.notionalUsd, asset: payload.asset })
      .catch((err) => log(`Finale error — ${(err as Error).message}`))
      .finally(() => {
        // allow another rehearsal after the segment self-completes (~75s)
        setTimeout(() => {
          finaleInFlight = false;
        }, 80_000);
      });
  }

  // Fast loop: equity snapshots (NO LLM) + the Marshal's drawdown monitor.
  let snapshotBusy = false;
  async function snapshotTick() {
    if (!running || snapshotBusy) return;
    snapshotBusy = true;
    try {
      await checkForceBench();
      await checkFinaleTrigger();
      for (const def of AGENTS) {
        const id = def.config.id;
        if (busy.has(id) || marshal.isBenched(id)) continue;
        busy.add(id);
        try {
          const snap = await snapshotAgent(def.config, deps);
          const benched = await marshal.postTradeMonitor(def.config, snap);
          if (benched) {
            log(`Risk Marshal: ⛔ BENCHED ${def.config.name} — drawdown ${snap.drawdownPct.toFixed(1)}% breached −${def.config.maxDrawdownPct}%`);
          }
        } catch {
          /* transient (rate limit / lock) — next tick recovers */
        } finally {
          busy.delete(id);
        }
      }
    } finally {
      snapshotBusy = false;
    }
  }
  timers.push(setInterval(() => void snapshotTick(), SNAPSHOT_SECONDS * 1000));

  // Stagger agents' decision loops across the tick window to respect rate limits.
  AGENTS.forEach((def, i) => {
    const stagger = AGENTS.length > 1 ? (i * (TICK_SECONDS * 1000)) / AGENTS.length : 0;
    setTimeout(() => {
      void decisionTick(def);
      timers.push(setInterval(() => void decisionTick(def), TICK_SECONDS * 1000));
    }, stagger);
  });

  log(`arena online — ${AGENTS.length} agent(s); decide every ${TICK_SECONDS}s, snapshot every ${SNAPSHOT_SECONDS}s`);

  const shutdown = (sig: string) => {
    log(`received ${sig}, shutting down`);
    running = false;
    timers.forEach(clearInterval);
    appendAudit(db, "arena_stop", { reason: sig });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
