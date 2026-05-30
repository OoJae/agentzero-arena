/**
 * SQLite persistence for AgentZero Arena (schema = BUILD.md §11).
 *
 * Engine: Node's built-in `node:sqlite` (stable on Node 22+; verified on Node 26).
 * We deliberately avoid `better-sqlite3` to dodge native-build risk on Node 26.
 * The surface here is intentionally narrow so a swap to better-sqlite3 (same
 * synchronous .prepare/.run/.get/.all shape) would be mechanical.
 *
 * WAL mode lets the long-lived worker (sole writer) and the Next.js SSE route
 * (reader) share one DB file safely.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  AgentConfig,
  AgentSnapshot,
  EquitySnapshot,
  Proposal,
  RiskEventView,
  Verdict,
} from "./types.js";

const DEFAULT_DB_PATH = resolve(
  process.env.ARENA_DATA_DIR ?? "./data",
  "arena.db",
);

let _db: DatabaseSync | null = null;

export function getDb(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  if (_db) return _db;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  initSchema(db);
  _db = db;
  return db;
}

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      strategy          TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'ACTIVE',
      max_position_pct  REAL NOT NULL,
      max_leverage      REAL NOT NULL,
      allowed_symbols   TEXT NOT NULL,
      starting_balance  REAL NOT NULL,
      created_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id      TEXT NOT NULL REFERENCES agents(id),
      ts            INTEGER NOT NULL,
      features_json TEXT NOT NULL,
      llm_rationale TEXT,
      action        TEXT NOT NULL,
      symbol        TEXT,
      size          REAL,
      confidence    REAL,
      approved      INTEGER NOT NULL,
      veto_reason   TEXT
    );

    CREATE TABLE IF NOT EXISTS trades (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT NOT NULL REFERENCES agents(id),
      decision_id  INTEGER REFERENCES decisions(id),
      ts           INTEGER NOT NULL,
      side         TEXT NOT NULL,
      symbol       TEXT NOT NULL,
      price        REAL NOT NULL,
      size         REAL NOT NULL,
      fee          REAL NOT NULL,
      mode         TEXT NOT NULL,
      cli_order_id TEXT,
      raw_json     TEXT
    );

    CREATE TABLE IF NOT EXISTS equity_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id      TEXT NOT NULL REFERENCES agents(id),
      ts            INTEGER NOT NULL,
      equity        REAL NOT NULL,
      pnl_pct       REAL NOT NULL,
      peak_equity   REAL NOT NULL,
      drawdown_pct  REAL NOT NULL,
      positions_json TEXT
    );

    CREATE TABLE IF NOT EXISTS risk_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT REFERENCES agents(id),
      ts           INTEGER NOT NULL,
      type         TEXT NOT NULL,
      detail       TEXT NOT NULL,
      action_taken TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      prev_hash  TEXT NOT NULL,
      hash       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_equity_agent_ts ON equity_snapshots(agent_id, ts);
    CREATE INDEX IF NOT EXISTS idx_decisions_agent_ts ON decisions(agent_id, ts);
    CREATE INDEX IF NOT EXISTS idx_risk_ts ON risk_events(ts);
  `);
}

// ─── Agents ──────────────────────────────────────────────────────────────────
export function upsertAgent(db: DatabaseSync, a: AgentConfig): void {
  db.prepare(
    `INSERT INTO agents (id, name, strategy, status, max_position_pct, max_leverage, allowed_symbols, starting_balance, created_at)
     VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, strategy=excluded.strategy,
       max_position_pct=excluded.max_position_pct, max_leverage=excluded.max_leverage,
       allowed_symbols=excluded.allowed_symbols, starting_balance=excluded.starting_balance`,
  ).run(
    a.id,
    a.name,
    a.strategy,
    a.maxPositionPct,
    a.maxLeverage,
    JSON.stringify(a.allowedSymbols),
    a.startingBalance,
    Date.now(),
  );
}

export function setAgentStatus(
  db: DatabaseSync,
  agentId: string,
  status: string,
): void {
  db.prepare(`UPDATE agents SET status = ? WHERE id = ?`).run(status, agentId);
}

// ─── Decisions ───────────────────────────────────────────────────────────────
export function insertDecision(
  db: DatabaseSync,
  agentId: string,
  ts: number,
  featuresJson: string,
  proposal: Proposal,
  verdict: Verdict,
): number {
  const info = db
    .prepare(
      `INSERT INTO decisions (agent_id, ts, features_json, llm_rationale, action, symbol, size, confidence, approved, veto_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      agentId,
      ts,
      featuresJson,
      proposal.rationale,
      proposal.action,
      proposal.symbol,
      proposal.size,
      proposal.confidence,
      verdict.approved ? 1 : 0,
      verdict.approved ? null : verdict.reason,
    );
  return Number(info.lastInsertRowid);
}

// ─── Trades ──────────────────────────────────────────────────────────────────
export function insertTrade(
  db: DatabaseSync,
  agentId: string,
  decisionId: number | null,
  ts: number,
  side: string,
  symbol: string,
  price: number,
  size: number,
  fee: number,
  mode: string,
  cliOrderId: string | null,
  rawJson: string | null,
): void {
  db.prepare(
    `INSERT INTO trades (agent_id, decision_id, ts, side, symbol, price, size, fee, mode, cli_order_id, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(agentId, decisionId, ts, side, symbol, price, size, fee, mode, cliOrderId, rawJson);
}

// ─── Equity snapshots ────────────────────────────────────────────────────────
export function insertEquitySnapshot(db: DatabaseSync, s: EquitySnapshot): void {
  db.prepare(
    `INSERT INTO equity_snapshots (agent_id, ts, equity, pnl_pct, peak_equity, drawdown_pct, positions_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.agentId,
    s.ts,
    s.equity,
    s.pnlPct,
    s.peakEquity,
    s.drawdownPct,
    JSON.stringify(s.positions ?? null),
  );
}

export function getPeakEquity(
  db: DatabaseSync,
  agentId: string,
  fallback: number,
): number {
  const row = db
    .prepare(`SELECT MAX(peak_equity) AS peak FROM equity_snapshots WHERE agent_id = ?`)
    .get(agentId) as { peak: number | null } | undefined;
  return row?.peak ?? fallback;
}

// ─── Risk events ─────────────────────────────────────────────────────────────
export function insertRiskEvent(
  db: DatabaseSync,
  agentId: string | null,
  ts: number,
  type: string,
  detail: string,
  actionTaken: string | null,
): void {
  db.prepare(
    `INSERT INTO risk_events (agent_id, ts, type, detail, action_taken) VALUES (?, ?, ?, ?, ?)`,
  ).run(agentId, ts, type, detail, actionTaken);
}

// ─── Read models for the dashboard ──────────────────────────────────────────
export function getAgentSnapshots(db: DatabaseSync): AgentSnapshot[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.strategy, a.status,
              (SELECT equity FROM equity_snapshots e WHERE e.agent_id = a.id ORDER BY e.ts DESC LIMIT 1) AS equity,
              (SELECT pnl_pct FROM equity_snapshots e WHERE e.agent_id = a.id ORDER BY e.ts DESC LIMIT 1) AS pnl_pct,
              (SELECT drawdown_pct FROM equity_snapshots e WHERE e.agent_id = a.id ORDER BY e.ts DESC LIMIT 1) AS drawdown_pct,
              (SELECT ts FROM equity_snapshots e WHERE e.agent_id = a.id ORDER BY e.ts DESC LIMIT 1) AS updated_at,
              (SELECT COUNT(*) FROM trades t WHERE t.agent_id = a.id) AS trades,
              (SELECT llm_rationale FROM decisions d WHERE d.agent_id = a.id ORDER BY d.ts DESC LIMIT 1) AS last_rationale,
              (SELECT action FROM decisions d WHERE d.agent_id = a.id ORDER BY d.ts DESC LIMIT 1) AS last_action,
              a.starting_balance
       FROM agents a
       ORDER BY equity DESC NULLS LAST, a.name ASC`,
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const startingBalance = Number(r.starting_balance);
    const equity = r.equity == null ? startingBalance : Number(r.equity);
    const pnlPct = r.pnl_pct == null ? 0 : Number(r.pnl_pct);
    const drawdownPct = r.drawdown_pct == null ? 0 : Number(r.drawdown_pct);
    return {
      id: String(r.id),
      name: String(r.name),
      strategy: r.strategy as AgentSnapshot["strategy"],
      status: r.status as AgentSnapshot["status"],
      equity,
      pnlPct,
      drawdownPct,
      trades: Number(r.trades ?? 0),
      lastRationale: r.last_rationale == null ? null : String(r.last_rationale),
      lastAction: r.last_action == null ? null : (String(r.last_action) as AgentSnapshot["lastAction"]),
      updatedAt: r.updated_at == null ? 0 : Number(r.updated_at),
    };
  });
}

export function getRecentRiskEvents(db: DatabaseSync, limit = 20): RiskEventView[] {
  const rows = db
    .prepare(
      `SELECT id, agent_id, ts, type, detail, action_taken
       FROM risk_events ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    agentId: String(r.agent_id ?? ""),
    ts: Number(r.ts),
    type: String(r.type),
    detail: String(r.detail),
    actionTaken: r.action_taken == null ? null : String(r.action_taken),
  }));
}
