/**
 * scripts/probe-llm.ts — one-shot diagnostic for the configured decision model.
 *
 * Confirms the provider (MiMo / Anthropic) is reachable and reports which structured-
 * output path works (forced tool-use vs JSON-mode), then runs a real `claudeDecide`.
 *
 * Run: pnpm tsx scripts/probe-llm.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import { claudeDecide, getModel, isCustom } from "../worker/decide.js";
import type { AgentConfig } from "../lib/types.js";

for (const f of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* optional */
  }
}

function textOf(r: Anthropic.Message): string {
  return r.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
}

const TOOL: Anthropic.Tool = {
  name: "submit_decision",
  description: "Submit a trading decision.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["buy", "sell", "hold"] },
      symbol: { type: "string" },
      size: { type: "number" },
      confidence: { type: "number" },
      rationale: { type: "string" },
    },
    required: ["action", "symbol", "size", "confidence", "rationale"],
  },
};

async function main() {
  console.log("─".repeat(64));
  console.log(`Provider: ${isCustom() ? "custom (MiMo-compatible)" : "Anthropic"}`);
  console.log(`Model:    ${getModel()}`);
  console.log(`Base URL: ${process.env.ANTHROPIC_BASE_URL ?? "(default api.anthropic.com)"}`);
  console.log(`API key:  ${process.env.ANTHROPIC_API_KEY ? "set" : "ABSENT"}`);
  console.log("─".repeat(64));
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("No ANTHROPIC_API_KEY — claudeDecide would use the deterministic fallback.");
    return;
  }

  const MODEL = getModel();
  const c = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  });

  // 1) basic connectivity
  try {
    const r = await c.messages.create({
      model: MODEL,
      max_tokens: 32,
      system: "You are a connectivity test.",
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
    });
    console.log(`1) basic chat:  OK  (stop=${r.stop_reason}) → ${JSON.stringify(textOf(r).slice(0, 60))}`);
  } catch (e) {
    console.log(`1) basic chat:  FAILED → ${(e as Error).message}`);
    return;
  }

  // 2) forced tool-use support
  try {
    const r = await c.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: "Test.",
      tools: [TOOL],
      tool_choice: { type: "tool", name: "submit_decision" },
      messages: [{ role: "user", content: "Decide HOLD on BTCUSD, size 0, confidence 0.5." }],
    });
    const tu = r.content.find((b) => b.type === "tool_use");
    console.log(`2) tool-use:    ${tu ? "SUPPORTED ✓ → " + JSON.stringify((tu as Anthropic.ToolUseBlock).input) : "no tool_use block (stop=" + r.stop_reason + ")"}`);
  } catch (e) {
    console.log(`2) tool-use:    NOT supported → ${(e as Error).message}  (JSON-mode fallback will be used)`);
  }

  // 3) full claudeDecide with a sentinel fallback so we can tell if the LLM was used
  const agent: AgentConfig = {
    id: "probe",
    name: "Probe",
    strategy: "momentum",
    allowedSymbols: ["BTCUSD", "ETHUSD", "SOLUSD"],
    maxPositionPct: 0.5,
    maxLeverage: 1,
    startingBalance: 10000,
    startingCurrency: "USD",
  };
  const proposal = await claudeDecide({
    agent,
    systemPrompt:
      "You are the Momentum agent. Decide ONLY from the supplied features; never predict prices. Go long clear uptrends, else HOLD.",
    context: {
      features: {
        BTCUSD: { price: 73000, shortReturn: 0.012, longReturn: 0.004, returnSpread: 0.0015, breakout: -0.004, drawdownFromHigh: -0.01, realizedVol: 0.008 },
        ETHUSD: { price: 1998, shortReturn: -0.006, longReturn: -0.01, returnSpread: 0.0005, breakout: -0.03, drawdownFromHigh: -0.03, realizedVol: 0.009 },
      },
    },
    maxSize: 0.06,
    fallback: () => ({ action: "hold", symbol: "BTCUSD", size: 0, confidence: 0.5, rationale: "FALLBACK-SENTINEL" }),
  });
  console.log("─".repeat(64));
  console.log(`3) claudeDecide → ${JSON.stringify(proposal)}`);
  console.log(
    proposal.rationale.includes("FALLBACK-SENTINEL")
      ? "   ⚠️  Used the DETERMINISTIC FALLBACK (the model did not return usable output)."
      : "   ✓  The MODEL produced the decision.",
  );
  console.log("─".repeat(64));
}

main();
