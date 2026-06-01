import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSchema, upsertAgent } from "../lib/db.js";
import { realOrderAuthorized, resolveLeader } from "./finale.js";
import type { AgentConfig } from "../lib/types.js";

const agent = (id: string): AgentConfig => ({
  id, name: id, strategy: "momentum", venue: "spot", allowedSymbols: ["BTCUSD"],
  maxPositionPct: 0.5, maxLeverage: 1, startingBalance: 10000, startingCurrency: "USD",
  maxDrawdownPct: 10, maxExposurePct: 60, maxOrdersPerMin: 4,
});

describe("realOrderAuthorized — defense in depth (the safety gate)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.ARENA_FINALE_ARMED;
    delete process.env.KRAKEN_API_KEY;
    delete process.env.KRAKEN_API_SECRET;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("refuses when not live (rehearsal)", () => {
    expect(realOrderAuthorized(false).ok).toBe(false);
  });
  it("refuses when live but ARENA_FINALE_ARMED is not YES", () => {
    process.env.KRAKEN_API_KEY = "k";
    process.env.KRAKEN_API_SECRET = "s";
    expect(realOrderAuthorized(true).ok).toBe(false);
  });
  it("refuses when live + armed but no credentials", () => {
    process.env.ARENA_FINALE_ARMED = "YES";
    expect(realOrderAuthorized(true).ok).toBe(false);
  });
  it("authorizes ONLY when live + armed + credentials all present", () => {
    process.env.ARENA_FINALE_ARMED = "YES";
    process.env.KRAKEN_API_KEY = "k";
    process.env.KRAKEN_API_SECRET = "s";
    expect(realOrderAuthorized(true).ok).toBe(true);
  });
});

describe("resolveLeader", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initSchema(db);
  });

  it("returns null when there are no agents", () => {
    expect(resolveLeader(db)).toBeNull();
  });

  it("picks the highest-equity non-benched agent", () => {
    for (const id of ["a", "b", "c"]) upsertAgent(db, agent(id));
    const snap = (aid: string, eq: number) =>
      db.prepare(`INSERT INTO equity_snapshots (agent_id, ts, equity, pnl_pct, peak_equity, drawdown_pct, positions_json) VALUES (?,?,?,?,?,?,?)`).run(aid, Date.now(), eq, 0, eq, 0, "{}");
    snap("a", 10500);
    snap("b", 12000); // highest…
    snap("c", 9000);
    db.prepare(`UPDATE agents SET status='BENCHED' WHERE id='b'`).run(); // …but benched
    expect(resolveLeader(db)?.id).toBe("a");
  });
});
