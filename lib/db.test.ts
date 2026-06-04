import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { getEquitySeries, initSchema, insertEquitySnapshot, upsertAgent } from "./db.js";
import type { AgentConfig } from "./types.js";

function agent(id: string): AgentConfig {
  return {
    id, name: id, strategy: "momentum", venue: "spot", allowedSymbols: ["BTCUSD"],
    maxPositionPct: 0.5, maxLeverage: 1, startingBalance: 10000, startingCurrency: "USD",
    maxDrawdownPct: 10, maxExposurePct: 60, maxOrdersPerMin: 4,
  };
}

describe("getEquitySeries — per-agent windowing (the 2-day-soak chart regression)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initSchema(db);
  });

  it("includes EVERY agent even when snapshot rates differ wildly", () => {
    for (const id of ["fast", "slow"]) upsertAgent(db, agent(id));
    const now = Date.now();
    // "fast" snapshots every second for the last hour (3600 rows);
    // "slow" snapshots once every 5 min (12 rows) — the old global LIMIT 800 dropped it.
    for (let i = 0; i < 3600; i++) insertEquitySnapshot(db, { agentId: "fast", ts: now - i * 1000, equity: 10000 + i, pnlPct: 0, peakEquity: 13600, drawdownPct: 0, positions: {} });
    for (let i = 0; i < 12; i++) insertEquitySnapshot(db, { agentId: "slow", ts: now - i * 300_000, equity: 9000 - i, pnlPct: 0, peakEquity: 9000, drawdownPct: 0, positions: {} });

    const series = getEquitySeries(db, 80, 6);
    expect(series.length).toBeGreaterThan(0);
    // BOTH agents are represented in the series (the old global LIMIT 800 dropped "slow").
    expect(series.some((p) => p.fast != null)).toBe(true);
    expect(series.some((p) => p.slow != null)).toBe(true);
    // latest point carries both agents' latest values (newest snapshot = i=0:
    // fast→10000, slow→9000). The key guarantee: slow is present at the latest point.
    const last = series[series.length - 1]!;
    expect(last.fast).toBe(10000);
    expect(last.slow).toBe(9000);
  });

  it("seeds an agent whose snapshots are all older than the window (frozen agent still charts)", () => {
    for (const id of ["live", "frozen"]) upsertAgent(db, agent(id));
    const now = Date.now();
    for (let i = 0; i < 100; i++) insertEquitySnapshot(db, { agentId: "live", ts: now - i * 1000, equity: 10500, pnlPct: 0, peakEquity: 10500, drawdownPct: 0, positions: {} });
    // frozen: last snapshot 2 days ago (well outside a 6h window)
    insertEquitySnapshot(db, { agentId: "frozen", ts: now - 48 * 3_600_000, equity: 9800, pnlPct: 0, peakEquity: 9800, drawdownPct: 0, positions: {} });

    const series = getEquitySeries(db, 80, 6);
    expect(series.length).toBeGreaterThan(0);
    // the frozen agent is forward-filled from its last-known value across the window
    expect(series[series.length - 1]!.frozen).toBe(9800);
    expect(series[series.length - 1]!.live).toBe(10500);
  });

  it("returns [] when there are no snapshots", () => {
    upsertAgent(db, agent("a"));
    expect(getEquitySeries(db, 80, 6)).toEqual([]);
  });

  it("downsamples to <= maxPoints, keeping the latest", () => {
    upsertAgent(db, agent("a"));
    const now = Date.now();
    for (let i = 0; i < 1000; i++) insertEquitySnapshot(db, { agentId: "a", ts: now - i * 1000, equity: 10000 + i, pnlPct: 0, peakEquity: 11000, drawdownPct: 0, positions: {} });
    const series = getEquitySeries(db, 50, 6);
    expect(series.length).toBeLessThanOrEqual(51);
    // newest snapshot is i=0 (ts=now, equity=10000); the series ends on it after sort.
    expect(series[series.length - 1]!.a).toBe(10000);
  });
});
