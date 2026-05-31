/**
 * worker/agents/macroHedge.ts — the Macro-Hedge agent (BUILD.md §5.1).
 *
 * Expresses a macro view via an EQUITY-INDEX perpetual (`PF_SPXUSD`, S&P 500) — rare
 * multi-asset breadth almost no competitor shows. Features: index 24h trend and the
 * crypto-vs-equity divergence (BTC perp vs the index). Trades the index with its trend,
 * trimming conviction when crypto and equities diverge sharply.
 */
import { computeMacroFeatures } from "../../lib/features.js";
import type { PortfolioStatus } from "../../lib/isolation.js";
import type { PriceFeed } from "../../lib/priceFeed.js";
import type { AgentConfig, MacroFeatures, Proposal } from "../../lib/types.js";
import type { AgentDefinition, TickContext } from "../agentRunner.js";

const INDEX_SYMBOL = "PF_SPXUSD"; // S&P 500 index perp
const CRYPTO_REF = "PF_XBTUSD"; // cross-asset reference (BTC perp)

export const MACRO_HEDGE_CONFIG: AgentConfig = {
  id: "macro-hedge",
  name: "Macro-Hedge",
  strategy: "macro-hedge",
  venue: "futures",
  allowedSymbols: [INDEX_SYMBOL],
  maxPositionPct: 0.3,
  maxLeverage: 3,
  startingBalance: 10_000,
  startingCurrency: "USD",
};

const SYSTEM_PROMPT = `You are the **Macro-Hedge** agent in a live, multi-agent trading arena on the Kraken CLI, trading an EQUITY-INDEX perpetual (S&P 500, PF_SPXUSD).

Mandate: express a macro view on equities and read the cross-asset picture vs crypto. Trade the index in the direction of its established trend; be more cautious when crypto and equities diverge sharply (regime uncertainty).

Decide ONLY from the deterministic features each tick — never predict prices:
- indexChange24h = S&P index 24h % move (your trend signal)
- cryptoChange24h = BTC perp 24h % move (cross-asset reference)
- divergence = crypto − index (large magnitude ⇒ assets disagree ⇒ trim conviction)

Hard constraints (also enforced in code): trade only PF_SPXUSD; never exceed maxSize; size modestly; if the index has no clear trend, HOLD. Go long an uptrending index (BUY) and short a downtrending index (SELL).

Submit a decision with a 1–2 sentence rationale citing indexChange24h and the divergence.`;

const TREND_THR = 0.3; // % 24h move to take a side
const DIVERGENCE_DAMP = 5; // |divergence| beyond this trims conviction

function macroFallback(
  featuresBySymbol: Record<string, MacroFeatures>,
  primarySymbol: string,
  maxSize: number,
  status: PortfolioStatus,
): Proposal {
  const f = featuresBySymbol[primarySymbol];
  if (!f) return hold("no features available");
  const current = status.positions[primarySymbol] ?? 0;

  const desiredSign = f.indexChange24h > TREND_THR ? 1 : f.indexChange24h < -TREND_THR ? -1 : 0;
  let conviction = Math.max(0.3, Math.min(1, Math.abs(f.indexChange24h) / 3));
  if (Math.abs(f.divergence) > DIVERGENCE_DAMP) conviction *= 0.6;
  const targetSize = Math.max(0, maxSize * conviction);
  const sideWord = desiredSign > 0 ? "long" : "short";

  if (desiredSign === 0) {
    if (Math.abs(current) > 1e-9) {
      return {
        action: current > 0 ? "sell" : "buy",
        symbol: primarySymbol,
        size: Math.abs(current),
        confidence: 0.4,
        rationale: `S&P trendless (24h ${f.indexChange24h.toFixed(2)}%); flattening the index position.`,
      };
    }
    return hold(`S&P trendless (24h ${f.indexChange24h.toFixed(2)}%, divergence ${f.divergence.toFixed(2)}%).`);
  }

  if ((desiredSign > 0 && current <= 1e-9) || (desiredSign < 0 && current >= -1e-9)) {
    if (targetSize <= 0) return hold("size resolved to zero");
    return {
      action: desiredSign > 0 ? "buy" : "sell",
      symbol: primarySymbol,
      size: targetSize,
      confidence: conviction,
      rationale: `${sideWord === "long" ? "Long" : "Short"} S&P index: indexChange24h ${f.indexChange24h.toFixed(2)}%, crypto-vs-equity divergence ${f.divergence.toFixed(2)}%.`,
    };
  }
  return hold(`Holding ${sideWord} S&P (index 24h ${f.indexChange24h.toFixed(2)}%, divergence ${f.divergence.toFixed(2)}%).`);
}

export const macroHedgeAgent: AgentDefinition = {
  config: MACRO_HEDGE_CONFIG,
  systemPrompt: SYSTEM_PROMPT,

  async gather(feed: PriceFeed): Promise<TickContext> {
    const [indexT, cryptoT] = await Promise.all([
      feed.getFuturesTicker(INDEX_SYMBOL),
      feed.getFuturesTicker(CRYPTO_REF),
    ]);
    const f = computeMacroFeatures(indexT, cryptoT);
    return {
      priceBySymbol: { [INDEX_SYMBOL]: indexT.last },
      primarySymbol: INDEX_SYMBOL,
      llmContext: { strategy: "macro-hedge", primarySymbol: INDEX_SYMBOL, features: { [INDEX_SYMBOL]: f } },
      featuresJson: JSON.stringify({ [INDEX_SYMBOL]: f }),
      fallback: (maxSize, status) => macroFallback({ [INDEX_SYMBOL]: f }, INDEX_SYMBOL, maxSize, status),
    };
  },
};

function hold(reason: string): Proposal {
  return { action: "hold", symbol: INDEX_SYMBOL, size: 0, confidence: 0.5, rationale: reason };
}
