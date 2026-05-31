/**
 * AgentZero Arena — agent runtime (long-lived worker).
 *
 * Phase 1: boot one isolated Momentum agent and run its decision loop on a staggered
 * tick. Each tick writes decisions/trades/equity to SQLite + the hash-chained audit
 * log; the Next.js dashboard reads that DB over SSE. Phase 2 adds the other three
 * agents to the `AGENTS` array — the scheduler already fans out generically.
 *
 * Not serverless. Run via `tsx worker/index.ts` (or `pnpm dev` for web+worker).
 */
import { appendAudit } from "../lib/audit.js";
import { getDb, setAgentStatus, upsertAgent } from "../lib/db.js";
import { createIsolation } from "../lib/isolation.js";
import { createPriceFeed } from "../lib/priceFeed.js";
import { runTick, type AgentDefinition, type RunDeps } from "./agentRunner.js";
import { claudeDecide } from "./decide.js";
import { momentumAgent } from "./agents/momentum.js";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env — paper mode needs no secrets */
}

const TICK_SECONDS = Number(process.env.ARENA_TICK_SECONDS ?? 20);
const OHLC_INTERVAL_MIN = Number(process.env.ARENA_OHLC_INTERVAL ?? 60);
const CANDLE_COUNT = Number(process.env.ARENA_CANDLE_COUNT ?? 50);
const DATA_DIR = process.env.ARENA_DATA_DIR ?? "./data";

// Phase 1: Momentum only. Phase 2 appends meanReversion, fundingCarry, macroHedge.
const AGENTS: AgentDefinition[] = [momentumAgent];

function log(msg: string, extra?: Record<string, unknown>) {
  console.log(`[worker ${new Date().toISOString()}] ${msg}`, extra ? JSON.stringify(extra) : "");
}

async function main() {
  const feed = createPriceFeed();
  const isolation = createIsolation(feed, undefined, DATA_DIR);

  log("booting AgentZero Arena worker", {
    node: process.version,
    isolation: isolation.kind,
    priceFeed: feed.kind,
    anthropicKey: process.env.ANTHROPIC_API_KEY ? "set" : "absent (deterministic fallback)",
    tickSeconds: TICK_SECONDS,
  });

  const db = getDb();
  log("database ready (WAL)");

  const deps: RunDeps = {
    db,
    feed,
    isolation,
    intervalMinutes: OHLC_INTERVAL_MIN,
    candleCount: CANDLE_COUNT,
    decide: claudeDecide,
  };

  // Register + isolate each agent before its first tick.
  for (const def of AGENTS) {
    upsertAgent(db, def.config);
    setAgentStatus(db, def.config.id, "ACTIVE");
    await isolation.init(def.config);
    log(`agent ready: ${def.config.name} (${def.config.strategy})`, {
      symbols: def.config.allowedSymbols,
      startingBalance: def.config.startingBalance,
    });
  }
  appendAudit(db, "arena_start", {
    agents: AGENTS.map((a) => a.config.id),
    isolation: isolation.kind,
    priceFeed: feed.kind,
  });

  const timers: NodeJS.Timeout[] = [];
  let running = true;

  async function tickAgent(def: AgentDefinition) {
    if (!running) return;
    try {
      const r = await runTick(def, deps);
      log(
        `${def.config.name}: ${r.action}${r.filled ? " (filled)" : ""} ${r.size > 0 ? r.size.toFixed(6) + " " + r.symbol : ""} | equity $${r.equity.toFixed(2)} (${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(2)}%) dd ${r.drawdownPct.toFixed(2)}%`,
      );
    } catch (err) {
      log(`${def.config.name}: tick error — ${(err as Error).message}`);
    }
  }

  // Stagger agents across the tick window to respect rate limits.
  AGENTS.forEach((def, i) => {
    const stagger = AGENTS.length > 1 ? (i * (TICK_SECONDS * 1000)) / AGENTS.length : 0;
    setTimeout(() => {
      void tickAgent(def); // fire first tick promptly
      timers.push(setInterval(() => void tickAgent(def), TICK_SECONDS * 1000));
    }, stagger);
  });

  log(`arena online — ${AGENTS.length} agent(s), tick every ${TICK_SECONDS}s`);

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
