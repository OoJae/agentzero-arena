/**
 * worker/decide.ts — the decision engine.
 *
 * The LLM reasons over DETERMINISTIC FEATURES (never raw/future prices) and emits a
 * structured proposal {action, symbol, size, confidence, rationale} via a forced
 * tool call (schema-validated with zod). If ANTHROPIC_API_KEY is absent or the call
 * fails, we fall back to a deterministic heuristic supplied by the agent — so the
 * arena always runs and is always explainable.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Action, AgentConfig, Proposal } from "../lib/types.js";

const MODEL = process.env.ARENA_AGENT_MODEL ?? "claude-sonnet-4-6";

const ProposalSchema = z.object({
  action: z.enum(["buy", "sell", "hold"]),
  symbol: z.string().min(1),
  size: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(600),
});

const DECISION_TOOL: Anthropic.Tool = {
  name: "submit_decision",
  description:
    "Submit your trading decision for this tick. Reason ONLY over the supplied features; never predict future prices. Stay within the stated hard risk limits.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["buy", "sell", "hold"] },
      symbol: { type: "string", description: "One of the allowed symbols" },
      size: { type: "number", description: "Base-asset units to trade (0 for hold). Must not exceed maxSize." },
      confidence: { type: "number", description: "0..1 confidence in this decision" },
      rationale: { type: "string", description: "One or two sentences grounded in the features." },
    },
    required: ["action", "symbol", "size", "confidence", "rationale"],
  },
};

let _client: Anthropic | null = null;
function client(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

export interface DecideInput {
  agent: AgentConfig;
  systemPrompt: string;
  /** Deterministic features + portfolio context, serialized into the user turn. */
  context: Record<string, unknown>;
  /** Hard ceiling on size for this tick (the agent computes it from risk limits). */
  maxSize: number;
  /** Deterministic decision used when no API key / on any LLM error. */
  fallback: () => Proposal;
}

export async function claudeDecide(input: DecideInput): Promise<Proposal> {
  const c = client();
  if (!c) return clampProposal(input.fallback(), input);

  try {
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: [
        { type: "text", text: input.systemPrompt, cache_control: { type: "ephemeral" } },
      ],
      tools: [DECISION_TOOL],
      tool_choice: { type: "tool", name: "submit_decision" },
      messages: [
        {
          role: "user",
          content:
            `Allowed symbols: ${input.agent.allowedSymbols.join(", ")}\n` +
            `maxSize (base units) you may not exceed: ${input.maxSize}\n\n` +
            `Features & portfolio (decide ONLY from these):\n` +
            JSON.stringify(input.context, null, 2),
        },
      ],
    });

    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) throw new Error("no tool_use block in response");
    const parsed = ProposalSchema.parse(toolUse.input);
    return clampProposal(parsed, input);
  } catch (err) {
    console.warn(`[decide] LLM call failed (${(err as Error).message}); using deterministic fallback`);
    return clampProposal(input.fallback(), input);
  }
}

/** Enforce allowed-symbol + maxSize + hold-normalization invariants. */
function clampProposal(p: Proposal, input: DecideInput): Proposal {
  let action: Action = p.action;
  let symbol = p.symbol;
  let size = Math.max(0, p.size);

  if (!input.agent.allowedSymbols.includes(symbol)) {
    symbol = input.agent.allowedSymbols[0] ?? symbol;
  }
  size = Math.min(size, input.maxSize);
  if (action === "hold" || size <= 0) {
    action = "hold";
    size = 0;
  }
  return {
    action,
    symbol,
    size,
    confidence: Math.max(0, Math.min(1, p.confidence)),
    rationale: p.rationale.slice(0, 600),
  };
}

export { ProposalSchema };
