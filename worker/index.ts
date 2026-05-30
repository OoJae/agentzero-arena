/**
 * AgentZero Arena — agent runtime (long-lived worker).
 *
 * Phase 0: boot cleanly, open the DB, and emit a heartbeat so we can prove the
 * process supervises correctly. Phase 1 replaces the heartbeat with the Momentum
 * agent tick loop (features → claudeDecide → isolated paper trade → snapshot).
 *
 * This is NOT serverless — agent loops are long-lived. Run via `tsx worker/index.ts`.
 */
import { getDb } from "../lib/db.js";

// Load .env if present (Node 22+ builtin; no dotenv dependency).
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file — fine. Paper mode needs no secrets.
}

const TICK_SECONDS = Number(process.env.ARENA_TICK_SECONDS ?? 20);

function log(msg: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  console.log(`[worker ${ts}] ${msg}`, extra ? JSON.stringify(extra) : "");
}

async function main() {
  log("booting AgentZero Arena worker", {
    node: process.version,
    isolation: process.env.ARENA_ISOLATION_PROVIDER ?? "paper-cli",
    priceFeed: process.env.ARENA_PRICE_FEED ?? "live",
    anthropicKey: process.env.ANTHROPIC_API_KEY ? "set" : "absent (deterministic fallback)",
  });

  // Open + migrate the arena DB so the dashboard has something to read.
  getDb();
  log("database ready (WAL)");

  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    log(`heartbeat #${tick} — Phase 0 placeholder (Momentum agent lands in Phase 1)`);
  }, TICK_SECONDS * 1000);

  const shutdown = (sig: string) => {
    log(`received ${sig}, shutting down`);
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log(`worker online — ticking every ${TICK_SECONDS}s`);
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
