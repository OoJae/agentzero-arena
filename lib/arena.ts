/**
 * lib/arena.ts — assemble the ArenaState the dashboard renders.
 *
 * Read-only over the SQLite DB (the worker is the sole writer). Used by the SSE
 * endpoint. Ranking + audit verification happen here so the client stays dumb.
 */
import { getAgentSnapshots, getDb, getEquitySeries, getRecentRiskEvents } from "./db.js";
import { verifyChain } from "./audit.js";
import type { ArenaState, EquityPoint } from "./types.js";

export function readArenaState(): ArenaState {
  const db = getDb();
  const agents = getAgentSnapshots(db);
  const events = getRecentRiskEvents(db, 20);
  const equitySeries = getEquitySeries(db, 80) as EquityPoint[];
  let auditVerified: boolean | null = null;
  try {
    auditVerified = verifyChain(db).ok;
  } catch {
    auditVerified = null;
  }
  return { ts: Date.now(), agents, events, auditVerified, equitySeries };
}
