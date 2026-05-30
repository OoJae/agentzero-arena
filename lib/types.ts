/**
 * Shared types for AgentZero Arena.
 *
 * Shapes for Kraken CLI envelopes are grounded in EMPIRICALLY OBSERVED output
 * from `kraken paper init/status` (kraken-cli 0.3.2). See CLAUDE.md "Verified CLI
 * findings" and scripts/verify-cli.ts.
 */

// ─── Kraken CLI error contract (9 categories) ────────────────────────────────
// From agents/error-catalog.json. The wrapper branches on EXIT CODE, then maps
// the JSON error envelope's `error` field to one of these categories.
export const ERROR_CATEGORIES = [
  "auth",
  "api",
  "validation",
  "config",
  "io",
  "parse",
  "network",
  "websocket",
  "rate_limit",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** JSON error envelope emitted on stdout when a command fails. */
export interface KrakenErrorEnvelope {
  error: string; // category, e.g. "network"
  message: string;
  suggestion?: string;
  docs_url?: string;
  retryable?: boolean;
}

// ─── Per-agent isolation ─────────────────────────────────────────────────────
/**
 * The environment passed to every CLI invocation for a given agent. Isolation is
 * achieved by giving each agent its OWN $HOME, which relocates the paper state
 * (verified: `<HOME>/Library/Application Support/kraken/...` on macOS).
 */
export interface AgentEnv {
  /** Per-agent home directory (isolation root). */
  home: string;
  /** Optional extra env vars (e.g. KRAKEN_API_KEY for the live finale only). */
  extra?: Record<string, string>;
}

// ─── Agents ──────────────────────────────────────────────────────────────────
export type StrategyId =
  | "momentum"
  | "mean-reversion"
  | "funding-carry"
  | "macro-hedge"
  | "sentiment";

export type AgentStatus = "ACTIVE" | "BENCHED" | "LIVE";

export interface AgentConfig {
  id: string;
  name: string;
  strategy: StrategyId;
  allowedSymbols: string[];
  maxPositionPct: number; // hard cap: max % of equity in a single position
  maxLeverage: number;
  startingBalance: number;
  startingCurrency: string; // e.g. "USD"
}

// ─── Decisions / trades ──────────────────────────────────────────────────────
export type Action = "buy" | "sell" | "hold";

/** Structured output of the decision engine (LLM or deterministic fallback). */
export interface Proposal {
  action: Action;
  symbol: string;
  size: number; // base-asset units (e.g. BTC)
  confidence: number; // 0..1
  rationale: string;
}

/** Risk Marshal pre-trade verdict (full implementation arrives in Phase 3). */
export interface Verdict {
  approved: boolean;
  reason: string;
  /** Size after clamping to hard limits (<= proposal.size). */
  clampedSize: number;
}

export interface Fill {
  side: "buy" | "sell";
  symbol: string;
  price: number;
  size: number;
  fee: number;
  mode: "paper" | "live";
  cliOrderId?: string;
  raw: unknown;
}

// ─── Market data ─────────────────────────────────────────────────────────────
export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TickerQuote {
  symbol: string;
  last: number;
  bid?: number;
  ask?: number;
  ts: number; // unix ms when observed
}

// ─── Features (deterministic; LLM reasons over these, never raw prices) ───────
export interface MomentumFeatures {
  symbol: string;
  price: number;
  shortReturn: number; // return over short window
  longReturn: number; // return over long window
  returnSpread: number; // short - long (trend strength)
  breakout: number; // (price - rangeHigh) / rangeHigh, >0 = breaking out up
  drawdownFromHigh: number; // (price - recentHigh) / recentHigh, <= 0
  realizedVol: number; // stdev of recent returns
}

// ─── Portfolio / equity ──────────────────────────────────────────────────────
/** Mirror of `kraken paper status -o json` (observed fields). */
export interface PaperStatus {
  current_value: number;
  starting_balance: number;
  starting_currency: string;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  total_trades: number;
  open_orders: number;
  fee_rate: number;
  slippage_rate: number;
  mode: string;
  valuation_complete?: boolean;
  positions?: unknown;
}

export interface EquitySnapshot {
  agentId: string;
  ts: number;
  equity: number;
  pnlPct: number;
  peakEquity: number;
  drawdownPct: number;
  positions: unknown;
}

// ─── Arena state (pushed to the dashboard over SSE) ──────────────────────────
export interface AgentSnapshot {
  id: string;
  name: string;
  strategy: StrategyId;
  status: AgentStatus;
  equity: number;
  pnlPct: number;
  drawdownPct: number;
  trades: number;
  lastRationale: string | null;
  lastAction: Action | null;
  updatedAt: number;
}

export interface RiskEventView {
  id: number;
  agentId: string;
  ts: number;
  type: string;
  detail: string;
  actionTaken: string | null;
}

export interface ArenaState {
  ts: number;
  agents: AgentSnapshot[];
  events: RiskEventView[];
  auditVerified: boolean | null;
}
