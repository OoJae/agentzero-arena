/**
 * scripts/finale.ts — trigger the live-money finale (BUILD.md §10).
 *
 * REHEARSAL BY DEFAULT. A real order requires ALL of:
 *   1) the `--live` flag here,
 *   2) env `ARENA_FINALE_ARMED=YES`,
 *   3) non-empty KRAKEN_API_KEY / KRAKEN_API_SECRET (funded, least-privilege: trading ON, withdrawals OFF).
 * Missing any ⇒ a safe rehearsal that places NO real order.
 *
 * Usage:
 *   pnpm tsx scripts/finale.ts                      # rehearsal (default)
 *   pnpm tsx scripts/finale.ts --asset BTCUSD --notional 20
 *   ARENA_FINALE_ARMED=YES pnpm tsx scripts/finale.ts --live --notional 20   # REAL (only on your go-ahead)
 *
 * The running worker shares ./data, so the dashboard's Finale panel updates live.
 */
import { getDb } from "../lib/db.js";
import { realOrderAuthorized, runFinale } from "../worker/finale.js";

for (const f of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* optional */
  }
}

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const asset = argEq("--asset") ?? "BTCUSD";
const notionalUsd = Number(argEq("--notional") ?? "20");

function argEq(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

async function main() {
  const auth = realOrderAuthorized(live);
  console.log("─".repeat(64));
  console.log("  AgentZero Arena — LIVE FINALE");
  console.log(`  mode:     ${auth.ok ? "🔴 LIVE (real order)" : "🟢 REHEARSAL (no real order)"}`);
  console.log(`  why:      ${auth.reason}`);
  console.log(`  asset:    ${asset} (crypto spot)`);
  console.log(`  notional: ~$${notionalUsd}`);
  console.log("─".repeat(64));
  if (live && !auth.ok) {
    console.log(`\n  ⚠️  --live requested but NOT authorized (${auth.reason}). Running REHEARSAL instead.`);
    console.log("     To go live: set ARENA_FINALE_ARMED=YES and provide funded KRAKEN_API_KEY/SECRET.\n");
  }

  const db = getDb();
  const state = await runFinale(db, { live, asset, notionalUsd });

  console.log(`\n  leader:    ${state.leader ?? "(none)"}`);
  console.log(`  validate:  ${state.validateAccepted === true ? "✓ accepted" : state.validateAccepted === false ? "✗ rejected" : "— (rehearsal)"}`);
  if (state.fill) console.log(`  fill:      ${state.fill.size} ${asset} @ $${state.fill.price.toFixed(2)} (fee $${state.fill.fee.toFixed(4)})`);
  if (state.balanceDelta != null) console.log(`  balance Δ: $${state.balanceDelta.toFixed(2)}`);
  console.log(`  killswitch:${state.cancelAfterArmed ? ` armed (${state.secondsRemaining}s)` : " not armed"}`);
  console.log(`  phase:     ${state.phase}`);
  console.log(`  message:   ${state.message}`);
  console.log("─".repeat(64));
  console.log("  Watch the Finale panel on the dashboard for the live countdown.");
  console.log("  (This process keeps the heartbeat alive; Ctrl-C ends the segment.)\n");
}

main().catch((err) => {
  console.error("[finale] fatal:", err);
  process.exit(1);
});
