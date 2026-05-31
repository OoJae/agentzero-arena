/**
 * worker/agents/meanReversion.ts — the Mean-Reversion agent (BUILD.md §5.1).
 *
 * Fades extremes on crypto majors (BTC/ETH/SOL): buy oversold, exit when price
 * reverts toward the mean. Deterministic features only (z-score, Bollinger %B, RSI);
 * the LLM/fallback reasons over them. Long-only spot.
 */
import { computeMeanReversionFeatures, DEFAULT_MEAN_REVERSION_PARAMS } from "../../lib/features.js";
import type { PortfolioStatus } from "../../lib/isolation.js";
import type { PriceFeed } from "../../lib/priceFeed.js";
import type { AgentConfig, MeanReversionFeatures, Proposal } from "../../lib/types.js";
import type { AgentDefinition, TickContext } from "../agentRunner.js";

export const MEAN_REVERSION_CONFIG: AgentConfig = {
  id: "mean-reversion",
  name: "Mean-Reversion",
  strategy: "mean-reversion",
  venue: "spot",
  allowedSymbols: ["BTCUSD", "ETHUSD", "SOLUSD"],
  maxPositionPct: 0.5,
  maxLeverage: 1,
  startingBalance: 10_000,
  startingCurrency: "USD",
};

const SYSTEM_PROMPT = `You are the **Mean-Reversion** agent in a live, multi-agent trading arena on the Kraken CLI.

Mandate: fade short-term extremes in liquid crypto majors — buy when oversold, exit when price reverts toward its mean. You are LONG-ONLY (no shorting).

Decide ONLY from the deterministic features provided each tick — never predict prices:
- zScore = standardized distance from the moving average (≤ −1 ⇒ oversold; ≥ 0 ⇒ reverted)
- percentB = Bollinger position (0 = lower band, 1 = upper band)
- rsi = 0..100 oscillator (low ⇒ oversold, e.g. < 35)

Hard constraints (also enforced in code): trade only allowed symbols; never exceed maxSize; enter long ONLY when clearly oversold (zScore well below −1 AND rsi low); exit when price reverts (zScore ≥ 0 or rsi elevated). If nothing is at an extreme, HOLD. Prefer HOLD over marginal trades.

Submit a decision with a 1–2 sentence rationale citing the specific features.`;

const ENTRY_Z = -1.0;
const ENTRY_RSI = 35;
const EXIT_RSI = 55;

function mostOversold(featuresBySymbol: Record<string, MeanReversionFeatures>): string {
  let best: string | null = null;
  let bestZ = Infinity;
  for (const [sym, f] of Object.entries(featuresBySymbol)) {
    if (f.zScore < bestZ) {
      bestZ = f.zScore;
      best = sym;
    }
  }
  return best ?? Object.keys(featuresBySymbol)[0] ?? "BTCUSD";
}

function meanReversionFallback(
  featuresBySymbol: Record<string, MeanReversionFeatures>,
  primarySymbol: string,
  maxSize: number,
  status: PortfolioStatus,
): Proposal {
  // Exit any held symbol that has reverted to / above its mean.
  for (const [sym, f] of Object.entries(featuresBySymbol)) {
    const held = status.positions[sym] ?? 0;
    if (held > 1e-9 && (f.zScore >= 0 || f.rsi > EXIT_RSI)) {
      return {
        action: "sell",
        symbol: sym,
        size: held,
        confidence: 0.6,
        rationale: `Exiting ${sym}: reverted to mean (zScore ${f.zScore.toFixed(2)}, RSI ${f.rsi.toFixed(0)}).`,
      };
    }
  }
  // Enter the most-oversold symbol if flat and clearly oversold.
  const f = featuresBySymbol[primarySymbol];
  if (!f) return hold("no features available");
  const holding = (status.positions[primarySymbol] ?? 0) > 1e-9;
  if (!holding && f.zScore < ENTRY_Z && f.rsi < ENTRY_RSI) {
    const conviction = Math.max(0.2, Math.min(1, Math.abs(f.zScore) / 3));
    const size = Math.max(0, maxSize * conviction);
    if (size <= 0) return hold("size resolved to zero");
    return {
      action: "buy",
      symbol: primarySymbol,
      size,
      confidence: conviction,
      rationale: `Buying oversold ${primarySymbol}: zScore ${f.zScore.toFixed(2)}, RSI ${f.rsi.toFixed(0)}, %B ${f.percentB.toFixed(2)} — fading the extreme toward the mean.`,
    };
  }
  return hold(`No extreme on ${primarySymbol} (zScore ${f.zScore.toFixed(2)}, RSI ${f.rsi.toFixed(0)}).`);
}

export const meanReversionAgent: AgentDefinition = {
  config: MEAN_REVERSION_CONFIG,
  systemPrompt: SYSTEM_PROMPT,

  async gather(feed: PriceFeed, intervalMinutes: number, candleCount: number): Promise<TickContext> {
    const featuresBySymbol: Record<string, MeanReversionFeatures> = {};
    const priceBySymbol: Record<string, number> = {};
    for (const symbol of MEAN_REVERSION_CONFIG.allowedSymbols) {
      const candles = await feed.getCandles(symbol, intervalMinutes, candleCount);
      const f = computeMeanReversionFeatures(symbol, candles, DEFAULT_MEAN_REVERSION_PARAMS);
      featuresBySymbol[symbol] = f;
      priceBySymbol[symbol] = f.price;
    }
    const primarySymbol = mostOversold(featuresBySymbol);
    return {
      priceBySymbol,
      primarySymbol,
      llmContext: { strategy: "mean-reversion", primarySymbol, features: featuresBySymbol },
      featuresJson: JSON.stringify(featuresBySymbol),
      fallback: (maxSize, status) => meanReversionFallback(featuresBySymbol, primarySymbol, maxSize, status),
    };
  },
};

function hold(reason: string): Proposal {
  return { action: "hold", symbol: "BTCUSD", size: 0, confidence: 0.5, rationale: reason };
}
