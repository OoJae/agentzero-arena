/**
 * scripts/force-breach.ts — operator-triggered bench, for filming the Risk Marshal.
 *
 * Writes data/force-bench.json; the running worker reads it on its next snapshot tick
 * and benches the named agent through the REAL Marshal path (flatten + loud event +
 * audit). Honest (operator-labelled) and reliable on camera.
 *
 * Usage: pnpm tsx scripts/force-breach.ts <agentId> [reason...]
 *   e.g. pnpm tsx scripts/force-breach.ts macro-hedge "drawdown breach (demo)"
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const AGENT_IDS = ["momentum", "mean-reversion", "funding-carry", "macro-hedge"];

const [, , agentId, ...reasonParts] = process.argv;
if (!agentId) {
  console.error(`usage: pnpm tsx scripts/force-breach.ts <agentId> [reason...]\n  agentId one of: ${AGENT_IDS.join(", ")}`);
  process.exit(1);
}
if (!AGENT_IDS.includes(agentId)) {
  console.error(`unknown agent "${agentId}". Known: ${AGENT_IDS.join(", ")}`);
  process.exit(1);
}

const reason = reasonParts.join(" ") || "manual breach (demo)";
const dataDir = process.env.ARENA_DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true });
const file = resolve(dataDir, "force-bench.json");
writeFileSync(file, JSON.stringify({ agentId, reason, ts: Date.now() }));
console.log(`⛔ force-bench queued for "${agentId}" (reason: ${reason}).`);
console.log("   The running worker will bench it on its next snapshot tick.");
