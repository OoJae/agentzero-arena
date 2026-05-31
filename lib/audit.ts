/**
 * lib/audit.ts — tamper-evident, hash-chained audit log (BUILD.md §7).
 *
 *   hash_n = sha256( hash_{n-1} + canonical_json(event_n) )
 *
 * Append every material event (decision, fill, risk action). `verifyChain()`
 * recomputes the chain and confirms nothing was altered or removed — the rigor
 * that separates 1st from 5th, for ~30 lines.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const GENESIS_HASH = "0".repeat(64);

/** Deterministic JSON: object keys sorted recursively so hashing is stable. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function hashEntry(prevHash: string, canonical: string): string {
  return createHash("sha256").update(prevHash + canonical).digest("hex");
}

export interface AuditRow {
  id: number;
  ts: number;
  event_type: string;
  payload_json: string;
  prev_hash: string;
  hash: string;
}

/** Append one event, chaining off the latest row. Returns the new hash. */
export function appendAudit(
  db: DatabaseSync,
  eventType: string,
  payload: unknown,
  ts: number = Date.now(),
): string {
  const last = db
    .prepare(`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`)
    .get() as { hash: string } | undefined;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const canonical = canonicalJson({ ts, event_type: eventType, payload });
  const hash = hashEntry(prevHash, canonical);
  db.prepare(
    `INSERT INTO audit_log (ts, event_type, payload_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?)`,
  ).run(ts, eventType, JSON.stringify(payload), prevHash, hash);
  return hash;
}

export interface VerifyResult {
  ok: boolean;
  rows: number;
  brokenAt?: number; // id of the first bad row
  reason?: string;
}

/** Recompute the chain over all rows and confirm integrity. */
export function verifyChain(db: DatabaseSync): VerifyResult {
  const rows = db
    .prepare(
      `SELECT id, ts, event_type, payload_json, prev_hash, hash FROM audit_log ORDER BY id ASC`,
    )
    .all() as unknown as AuditRow[];

  let prevHash = GENESIS_HASH;
  for (const row of rows) {
    if (row.prev_hash !== prevHash) {
      return { ok: false, rows: rows.length, brokenAt: row.id, reason: "prev_hash mismatch (row removed or reordered)" };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      return { ok: false, rows: rows.length, brokenAt: row.id, reason: "payload not parseable" };
    }
    const canonical = canonicalJson({ ts: row.ts, event_type: row.event_type, payload });
    const expected = hashEntry(prevHash, canonical);
    if (expected !== row.hash) {
      return { ok: false, rows: rows.length, brokenAt: row.id, reason: "hash mismatch (row altered)" };
    }
    prevHash = row.hash;
  }
  return { ok: true, rows: rows.length };
}
