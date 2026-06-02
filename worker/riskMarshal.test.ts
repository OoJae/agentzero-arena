import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { initSchema, upsertAgent } from "../lib/db.js";
import type { IsolationProvider } from "../lib/isolation.js";
import type { AgentConfig, Proposal } from "../lib/types.js";
import { RiskMarshal } from "./riskMarshal.js";

const agent: AgentConfig = {
  id: "t", name: "T", strategy: "momentum", venue: "spot", allowedSymbols: ["BTCUSD"],
  maxPositionPct: 0.5, maxLeverage: 1, startingBalance: 10000, startingCurrency: "USD",
  maxDrawdownPct: 10, maxExposurePct: 60, maxOrdersPerMin: 3,
};
const status = { equity: 10000, startingBalance: 10000, trades: 0, positions: {} as Record<string, number> };
const buy: Proposal = { action: "buy", symbol: "BTCUSD", size: 1, confidence: 0.5, rationale: "x" };

function fakeIso(flattenFills = 1): IsolationProvider {
  return {
    kind: "virtual",
    async init() {},
    async execute() { return null; },
    async status() { return { equity: 10000, startingBalance: 10000, trades: 0, positions: {} }; },
    async flatten() {
      return Array.from({ length: flattenFills }, () => ({ side: "sell" as const, symbol: "BTCUSD", price: 100, size: 1, fee: 0, mode: "paper" as const, raw: null }));
    },
  };
}
function mkDb() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  upsertAgent(db, agent);
  return db;
}
const mk = () => new RiskMarshal(mkDb(), fakeIso());

describe("RiskMarshal.preTradeCheck", () => {
  it("rejects a hold", () => {
    expect(mk().preTradeCheck(agent, { ...buy, action: "hold" }, status, 100).approved).toBe(false);
  });
  it("clamps to the single-position cap", () => {
    const v = mk().preTradeCheck(agent, { ...buy, size: 1000 }, status, 100);
    expect(v.approved).toBe(true);
    expect(v.clampedSize).toBeLessThanOrEqual(50 + 1e-9); // 0.5 * 10000 / 100
  });
  it("rejects when the exposure cap is already reached", () => {
    const heavy = { ...status, positions: { BTCUSD: 70 } }; // 70*100 = 7000 > 60% (6000)
    expect(mk().preTradeCheck(agent, buy, heavy, 100).approved).toBe(false);
  });
  it("enforces the order-rate limit", () => {
    const m = mk();
    let approved = 0;
    for (let i = 0; i < 6; i++) if (m.preTradeCheck(agent, buy, status, 100).approved) approved++;
    expect(approved).toBe(agent.maxOrdersPerMin);
  });
  it("rejects when benched", async () => {
    const m = mk();
    await m.bench(agent, "test");
    expect(m.isBenched(agent.id)).toBe(true);
    expect(m.preTradeCheck(agent, buy, status, 100).approved).toBe(false);
  });

  it("clamps a spot buy to affordable cash (no CLI rejection)", () => {
    // cash 150 at price 100 ⇒ affordable ≈ 1.496 (after 0.26% fee), well under the position cap
    const lowCash = { ...status, cash: 150, positions: { BTCUSD: 0.142 } };
    const v = mk().preTradeCheck(agent, { ...buy, size: 50 }, lowCash, 100);
    expect(v.approved).toBe(true);
    expect(v.clampedSize).toBeLessThanOrEqual(150 / 100 + 1e-9);
    expect(v.clampedSize * 100 * 1.0026).toBeLessThanOrEqual(150 + 1e-6);
  });

  it("vetoes a spot buy when cash is effectively zero", () => {
    const noCash = { ...status, cash: 1e-12, positions: { BTCUSD: 0.142 } };
    const v = mk().preTradeCheck(agent, buy, noCash, 100);
    expect(v.approved).toBe(false);
    expect(v.reason).toMatch(/insufficient cash/);
  });

  it("buys only what little cash affords (no CLI rejection) when cash is small", () => {
    const tiny = { ...status, cash: 0.5, positions: { BTCUSD: 0.142 } };
    const v = mk().preTradeCheck(agent, buy, tiny, 100);
    expect(v.approved).toBe(true);
    expect(v.clampedSize * 100 * 1.0026).toBeLessThanOrEqual(0.5 + 1e-9); // ≤ available cash
  });

  it("does NOT apply the cash clamp to futures buys (margin, not cash)", () => {
    const fut: AgentConfig = { ...agent, id: "f", venue: "futures", allowedSymbols: ["PF_XBTUSD"], maxLeverage: 3 };
    const db = mkDb();
    upsertAgent(db, fut);
    const m = new RiskMarshal(db, fakeIso());
    // cash tiny but irrelevant for futures; should approve within the position cap
    const v = m.preTradeCheck(fut, { action: "buy", symbol: "PF_XBTUSD", size: 0.01, confidence: 0.5, rationale: "x" }, { ...status, cash: 1 }, 70000);
    expect(v.approved).toBe(true);
  });
});

describe("RiskMarshal.postTradeMonitor", () => {
  it("benches on a drawdown breach, flattens, and logs", async () => {
    const db = mkDb();
    const m = new RiskMarshal(db, fakeIso(2));
    const benched = await m.postTradeMonitor(agent, { drawdownPct: -12, equity: 8800 });
    expect(benched).toBe(true);
    expect(m.isBenched(agent.id)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) c FROM risk_events WHERE type='BENCH'").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM trades").get() as { c: number }).c).toBe(2); // 2 flatten fills
  });
  it("does not bench within the limit", async () => {
    expect(await mk().postTradeMonitor(agent, { drawdownPct: -5, equity: 9500 })).toBe(false);
  });
});
