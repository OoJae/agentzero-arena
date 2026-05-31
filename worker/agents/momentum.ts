/**
 * worker/agents/momentum.ts — the Momentum agent (BUILD.md §5.1).
 *
 * Trend-following on crypto majors (BTC/ETH/SOL): ride established short-term
 * strength, stand aside or exit when momentum decays. Deterministic features only;
 * the LLM (or the deterministic fallback) reasons over them — never over future prices.
 */
import { computeMomentumFeatures, DEFAULT_MOMENTUM_PARAMS } from "../../lib/features.js";
import type { PortfolioStatus } from "../../lib/isolation.js";
import type { PriceFeed } from "../../lib/priceFeed.js";
import type { AgentConfig, MomentumFeatures, Proposal } from "../../lib/types.js";
import type { AgentDefinition, TickContext } from "../agentRunner.js";

export const MOMENTUM_CONFIG: AgentConfig = {
  id: "momentum",
  name: "Momentum",
  strategy: "momentum",
  venue: "spot",
  allowedSymbols: ["BTCUSD", "ETHUSD", "SOLUSD"],
  maxPositionPct: 0.5, // hard cap: ≤50% of equity per position
  maxLeverage: 1,
  startingBalance: 10_000,
  startingCurrency: "USD",
  maxDrawdownPct: 12,
  maxExposurePct: 60,
  maxOrdersPerMin: 4,
};

const SYSTEM_PROMPT = `You are the **Momentum** agent in a live, multi-agent trading arena running on the Kraken CLI.

Mandate: ride established short-term trends in liquid crypto majors. Go long strength; stand aside or exit when momentum decays. You are LONG-ONLY in this arena (no shorting).

You decide ONLY from the deterministic features provided each tick — never speculate about future prices or invent data:
- shortReturn / longReturn = recent vs longer-term return (positive ⇒ uptrend)
- returnSpread = per-period acceleration (positive ⇒ recent pace exceeds longer-term pace)
- drawdownFromHigh = how far below the recent high (≤ 0)
- realizedVol = recent volatility (size down when high)

Hard constraints (enforced in code, but respect them): trade only the allowed symbols; never exceed the given maxSize (base units); if there is no clear trend, choose HOLD. Prefer HOLD over marginal trades. Size positions modestly and scale with conviction, not with volatility.

Always submit a decision with a 1–2 sentence rationale that cites the specific features.`;

const BUY_RETURN_THRESHOLD = 0.003; // recent (short-window) uptrend of ≥0.3% to enter
const EXIT_RETURN_THRESHOLD = -0.003; // recent downtrend to exit
const EXIT_DRAWDOWN = -0.05; // exit if drawdown breaches this
const MAX_ENTRY_DRAWDOWN = -0.08; // don't enter if already this far below the recent high

function pickStrongest(featuresBySymbol: Record<string, MomentumFeatures>): string {
  let best: string | null = null;
  let bestReturn = -Infinity;
  for (const [sym, f] of Object.entries(featuresBySymbol)) {
    if (f.shortReturn > bestReturn) {
      bestReturn = f.shortReturn;
      best = sym;
    }
  }
  return best ?? Object.keys(featuresBySymbol)[0] ?? "BTCUSD";
}

function momentumFallback(
  featuresBySymbol: Record<string, MomentumFeatures>,
  primarySymbol: string,
  maxSize: number,
  status: PortfolioStatus,
): Proposal {
  const f = featuresBySymbol[primarySymbol];
  if (!f) return hold("no features available");
  const holding = (status.positions[primarySymbol] ?? 0) > 1e-9;

  // Exit: recent downtrend or drawdown breached while holding.
  if (holding && (f.shortReturn < EXIT_RETURN_THRESHOLD || f.drawdownFromHigh < EXIT_DRAWDOWN)) {
    return {
      action: "sell",
      symbol: primarySymbol,
      size: status.positions[primarySymbol] ?? 0,
      confidence: 0.6,
      rationale: `Exiting ${primarySymbol}: shortReturn ${(f.shortReturn * 100).toFixed(2)}% and drawdownFromHigh ${(f.drawdownFromHigh * 100).toFixed(1)}% signal momentum decay.`,
    };
  }

  // Entry: positive AND accelerating recent return, not deep in a drawdown.
  const farBelowHigh = f.drawdownFromHigh < MAX_ENTRY_DRAWDOWN;
  if (!holding && f.shortReturn > BUY_RETURN_THRESHOLD && f.returnSpread > 0 && !farBelowHigh) {
    const trend = Math.min(0.8, f.shortReturn / 0.02);
    const accelBonus = Math.min(0.2, f.returnSpread * 40);
    const conviction = Math.max(0.2, Math.min(1, trend + accelBonus));
    const size = Math.max(0, maxSize * conviction * (1 / (1 + f.realizedVol * 20)));
    if (size <= 0) return hold("size resolved to zero");
    return {
      action: "buy",
      symbol: primarySymbol,
      size,
      confidence: conviction,
      rationale: `Long ${primarySymbol}: shortReturn +${(f.shortReturn * 100).toFixed(2)}% and accelerating (${(f.returnSpread * 100).toFixed(3)}%/period), ${(f.drawdownFromHigh * 100).toFixed(1)}% off the high; sized for vol ${(f.realizedVol * 100).toFixed(2)}%.`,
    };
  }

  return hold(`No clear trend on ${primarySymbol} (shortReturn ${(f.shortReturn * 100).toFixed(2)}%, spread ${(f.returnSpread * 100).toFixed(3)}%/p).`);
}

export const momentumAgent: AgentDefinition = {
  config: MOMENTUM_CONFIG,
  systemPrompt: SYSTEM_PROMPT,

  async gather(feed: PriceFeed, intervalMinutes: number, candleCount: number): Promise<TickContext> {
    const featuresBySymbol: Record<string, MomentumFeatures> = {};
    const priceBySymbol: Record<string, number> = {};
    for (const symbol of MOMENTUM_CONFIG.allowedSymbols) {
      const candles = await feed.getCandles(symbol, intervalMinutes, candleCount);
      const f = computeMomentumFeatures(symbol, candles, DEFAULT_MOMENTUM_PARAMS);
      featuresBySymbol[symbol] = f;
      priceBySymbol[symbol] = f.price;
    }
    const primarySymbol = pickStrongest(featuresBySymbol);
    return {
      priceBySymbol,
      primarySymbol,
      llmContext: { strategy: "momentum", primarySymbol, features: featuresBySymbol },
      featuresJson: JSON.stringify(featuresBySymbol),
      fallback: (maxSize, status) => momentumFallback(featuresBySymbol, primarySymbol, maxSize, status),
    };
  },
};

function hold(reason: string): Proposal {
  return { action: "hold", symbol: "BTCUSD", size: 0, confidence: 0.5, rationale: reason };
}
