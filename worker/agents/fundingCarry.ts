/**
 * worker/agents/fundingCarry.ts — the Funding-Carry agent (BUILD.md §5.1).
 *
 * Plays funding rates on perpetual futures: position to RECEIVE funding while keeping
 * directional exposure modest. Convention: positive funding ⇒ longs pay shorts ⇒ go
 * SHORT to receive; negative funding ⇒ go LONG to receive. Uses the live `futures
 * ticker` (fundingRate + prediction) — a distinctive, rare CLI surface.
 */
import { computeFundingFeatures } from "../../lib/features.js";
import type { PortfolioStatus } from "../../lib/isolation.js";
import type { PriceFeed } from "../../lib/priceFeed.js";
import type { AgentConfig, FundingFeatures, Proposal } from "../../lib/types.js";
import type { AgentDefinition, TickContext } from "../agentRunner.js";

export const FUNDING_CARRY_CONFIG: AgentConfig = {
  id: "funding-carry",
  name: "Funding-Carry",
  strategy: "funding-carry",
  venue: "futures",
  allowedSymbols: ["PF_XBTUSD", "PF_ETHUSD"],
  maxPositionPct: 0.3,
  maxLeverage: 3,
  startingBalance: 10_000,
  startingCurrency: "USD",
};

const SYSTEM_PROMPT = `You are the **Funding-Carry** agent in a live, multi-agent trading arena on the Kraken CLI, trading perpetual futures.

Mandate: harvest funding. Positive funding means longs pay shorts, so you SHORT to receive it; negative funding means shorts pay longs, so you go LONG to receive it. Keep directional exposure modest — the edge is the carry, not a price bet.

Decide ONLY from the deterministic features each tick — never predict prices:
- fundingRate = current funding (sign tells you which side receives)
- fundingPrediction = next expected funding
- change24h = 24h price move (context for directional risk)

Hard constraints (also enforced in code): trade only allowed symbols; never exceed maxSize; size modestly; if funding is negligible, HOLD. To receive funding, BUY (long) when funding is clearly negative and SELL (short) when funding is clearly positive.

Submit a decision with a 1–2 sentence rationale citing the funding rate and the side you take to receive it.`;

const FUNDING_EPS = 1e-6; // ignore funding noise around zero

function pickBestCarry(featuresBySymbol: Record<string, FundingFeatures>): string {
  let best: string | null = null;
  let bestMag = -Infinity;
  for (const [sym, f] of Object.entries(featuresBySymbol)) {
    const mag = Math.abs(f.fundingRate);
    if (mag > bestMag) {
      bestMag = mag;
      best = sym;
    }
  }
  return best ?? Object.keys(featuresBySymbol)[0] ?? "PF_XBTUSD";
}

function fundingFallback(
  featuresBySymbol: Record<string, FundingFeatures>,
  primarySymbol: string,
  maxSize: number,
  status: PortfolioStatus,
): Proposal {
  const f = featuresBySymbol[primarySymbol];
  if (!f) return hold("no features available");
  const current = status.positions[primarySymbol] ?? 0;

  // desiredSign: +1 long (funding<0), -1 short (funding>0), 0 flat.
  const desiredSign = f.fundingRate > FUNDING_EPS ? -1 : f.fundingRate < -FUNDING_EPS ? 1 : 0;
  const conviction = Math.max(0.3, Math.min(1, Math.abs(f.fundingRate) * 20 + 0.3));
  const targetSize = Math.max(0, maxSize * conviction);
  const sideWord = desiredSign > 0 ? "long" : "short";

  if (desiredSign === 0) {
    if (Math.abs(current) > 1e-9) {
      return {
        action: current > 0 ? "sell" : "buy",
        symbol: primarySymbol,
        size: Math.abs(current),
        confidence: 0.4,
        rationale: `Funding on ${primarySymbol} negligible (${(f.fundingRate * 100).toFixed(4)}%); flattening to avoid directional risk.`,
      };
    }
    return hold(`Funding on ${primarySymbol} negligible (${(f.fundingRate * 100).toFixed(4)}%).`);
  }

  // Open/extend toward the funding-receiving side if not already there.
  if ((desiredSign > 0 && current <= 1e-9) || (desiredSign < 0 && current >= -1e-9)) {
    if (targetSize <= 0) return hold("size resolved to zero");
    return {
      action: desiredSign > 0 ? "buy" : "sell",
      symbol: primarySymbol,
      size: targetSize,
      confidence: conviction,
      rationale: `${sideWord === "long" ? "Long" : "Short"} ${primarySymbol} to receive funding: fundingRate ${(f.fundingRate * 100).toFixed(4)}% (pred ${(f.fundingPrediction * 100).toFixed(4)}%).`,
    };
  }
  return hold(`Already positioned ${sideWord} on ${primarySymbol} to collect funding (${(f.fundingRate * 100).toFixed(4)}%).`);
}

export const fundingCarryAgent: AgentDefinition = {
  config: FUNDING_CARRY_CONFIG,
  systemPrompt: SYSTEM_PROMPT,

  async gather(feed: PriceFeed): Promise<TickContext> {
    const featuresBySymbol: Record<string, FundingFeatures> = {};
    const priceBySymbol: Record<string, number> = {};
    for (const symbol of FUNDING_CARRY_CONFIG.allowedSymbols) {
      const t = await feed.getFuturesTicker(symbol);
      featuresBySymbol[symbol] = computeFundingFeatures(t);
      priceBySymbol[symbol] = t.last;
    }
    const primarySymbol = pickBestCarry(featuresBySymbol);
    return {
      priceBySymbol,
      primarySymbol,
      llmContext: { strategy: "funding-carry", primarySymbol, features: featuresBySymbol },
      featuresJson: JSON.stringify(featuresBySymbol),
      fallback: (maxSize, status) => fundingFallback(featuresBySymbol, primarySymbol, maxSize, status),
    };
  },
};

function hold(reason: string): Proposal {
  return { action: "hold", symbol: "PF_XBTUSD", size: 0, confidence: 0.5, rationale: reason };
}
