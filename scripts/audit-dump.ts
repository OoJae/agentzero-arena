/**
 * scripts/audit-dump.ts — print + verify the tamper-evident audit chain.
 *
 * Run: pnpm audit-dump
 */
import { getDb } from "../lib/db.js";
import { verifyChain, type AuditRow } from "../lib/audit.js";

function main() {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, ts, event_type, payload_json, prev_hash, hash FROM audit_log ORDER BY id ASC`)
    .all() as unknown as AuditRow[];

  console.log(`\nAudit log — ${rows.length} entries\n${"─".repeat(70)}`);
  for (const r of rows) {
    const when = new Date(r.ts).toISOString();
    console.log(`#${String(r.id).padStart(4)} ${when}  ${r.event_type.padEnd(12)} ${r.hash.slice(0, 12)}…`);
  }

  const result = verifyChain(db);
  console.log("─".repeat(70));
  if (result.ok) {
    console.log(`✅ audit verified — ${result.rows} entries form an unbroken hash chain.\n`);
    process.exit(0);
  } else {
    console.log(`❌ audit BROKEN at row ${result.brokenAt}: ${result.reason}\n`);
    process.exit(1);
  }
}

main();
