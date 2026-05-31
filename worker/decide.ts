/**
 * worker/decide.ts — the decision engine (provider-agnostic).
 *
 * The LLM reasons over DETERMINISTIC FEATURES (never raw/future prices) and emits a
 * structured proposal {action, symbol, size, confidence, rationale}. We prefer a
 * forced tool call; for third-party Anthropic-compatible endpoints (e.g. MiMo) that
 * may not support tools, we fall back to JSON-mode (parse a raw JSON object from the
 * text). If there is no API key or every attempt fails, we use the agent's
 * deterministic fallback — so the arena always runs and is always explainable.
 *
 * Provider is chosen by env: ANTHROPIC_BASE_URL (set ⇒ custom, e.g. MiMo) +
 * ARENA_AGENT_MODEL (e.g. `mimo-v2.5-pro` or `claude-sonnet-4-6`).
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Action, AgentConfig, Proposal } from "../lib/types.js";

// Read env LAZILY (inside calls), never at module load: ESM evaluates this module
// when it is imported, which is BEFORE the worker's body runs `loadEnvFile`. Reading
// at top-level would capture an empty env (the bug that picked the wrong model).
function getModel(): string {
  return process.env.ARENA_AGENT_MODEL ?? "claude-sonnet-4-6";
}
function getBaseUrl(): string | undefined {
  return process.env.ANTHROPIC_BASE_URL || undefined;
}
function isCustom(): boolean {
  return Boolean(getBaseUrl()); // custom Anthropic-compatible endpoint (e.g. MiMo)
}
/** Generous budget: MiMo v2.5 is a reasoning model that spends tokens "thinking"
 *  before emitting the tool call, so a small cap silently truncates the decision. */
function getMaxTokens(): number {
  return Number(process.env.ARENA_MAX_TOKENS ?? 2048);
}

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
      size: { type: "number", description: "Units to trade (0 for hold). Must not exceed maxSize." },
      confidence: { type: "number", description: "0..1 confidence in this decision" },
      rationale: { type: "string", description: "One or two sentences grounded in the features." },
    },
    required: ["action", "symbol", "size", "confidence", "rationale"],
  },
};

const JSON_HINT =
  'Respond with ONLY a single JSON object (no prose, no markdown fences): ' +
  '{"action":"buy|sell|hold","symbol":"<allowed symbol>","size":<number>,"confidence":<0..1>,"rationale":"<1-2 sentences citing the features>"}';

let _client: Anthropic | null = null;
function client(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: getBaseUrl() });
  }
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
    const proposal = await callModel(c, input);
    return clampProposal(proposal, input);
  } catch (err) {
    console.warn(`[decide] LLM call failed (${(err as Error).message}); using deterministic fallback`);
    return clampProposal(input.fallback(), input);
  }
}

function userTurn(input: DecideInput, jsonMode: boolean): string {
  return (
    `Allowed symbols: ${input.agent.allowedSymbols.join(", ")}\n` +
    `maxSize (units) you may not exceed: ${input.maxSize}\n\n` +
    `Features & portfolio (decide ONLY from these):\n` +
    JSON.stringify(input.context, null, 2) +
    (jsonMode ? `\n\n${JSON_HINT}` : "")
  );
}

/** Build the `system` param: cached blocks for real Anthropic, plain string for custom endpoints. */
function systemParam(text: string): Anthropic.MessageCreateParams["system"] {
  return isCustom() ? text : [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

async function callModel(c: Anthropic, input: DecideInput): Promise<Proposal> {
  // Attempt 1 — forced tool use (native on real Anthropic; some compat endpoints too).
  let lastErr: unknown;
  try {
    const resp = await c.messages.create({
      model: getModel(),
      max_tokens: getMaxTokens(),
      system: systemParam(input.systemPrompt),
      tools: [DECISION_TOOL],
      tool_choice: { type: "tool", name: "submit_decision" },
      messages: [{ role: "user", content: userTurn(input, false) }],
    });
    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUse) return ProposalSchema.parse(toolUse.input);
    const fromText = parseProposalFromText(textOf(resp));
    if (fromText) return fromText;
    lastErr = new Error("no tool_use or JSON in tool attempt");
  } catch (err) {
    lastErr = err; // e.g. endpoint rejects `tools` — fall through to JSON mode
  }

  // Attempt 2 — JSON mode (no tools). Robust for endpoints without tool support (MiMo).
  const resp = await c.messages.create({
    model: getModel(),
    max_tokens: 512,
    system: systemParam(input.systemPrompt),
    messages: [{ role: "user", content: userTurn(input, true) }],
  });
  const parsed = parseProposalFromText(textOf(resp));
  if (parsed) return parsed;
  throw (lastErr instanceof Error ? lastErr : new Error("no structured output from model"));
}

function textOf(resp: Anthropic.Message): string {
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Tolerant extraction of a Proposal JSON object from free text (handles ```json fences). */
export function parseProposalFromText(text: string): Proposal | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      const r = ProposalSchema.safeParse(obj);
      if (r.success) return r.data;
    } catch {
      /* try next candidate */
    }
  }
  return null;
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

export { ProposalSchema, getModel, isCustom };
