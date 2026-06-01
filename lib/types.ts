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

export type Venue = "spot" | "futures";

export interface AgentConfig {
  id: string;
  name: string;
  strategy: StrategyId;
  venue: Venue; // spot → `kraken paper`; futures → `kraken futures paper`
  allowedSymbols: string[];
  maxPositionPct: number; // hard cap: max fraction of equity in a single position (0..1)
  maxLeverage: number;
  startingBalance: number;
  startingCurrency: string; // e.g. "USD"
  // ─── Risk profile (enforced by the Risk Marshal, BUILD.md §6) ───
  maxDrawdownPct: number; // bench if drawdown from peak worse than −this% (e.g. 10)
  maxExposurePct: number; // gross notional cap as % of equity (e.g. 60)
  maxOrdersPerMin: number; // order-rate cap
}

// ─── Futures market data (verified shapes from `kraken futures ticker`) ───────
export interface FuturesTickerData {
  symbol: string;
  last: number;
  markPrice: number;
  indexPrice: number;
  fundingRate: number; // current funding (sign: >0 ⇒ longs pay shorts)
  fundingRatePrediction: number;
  change24h: number; // 24h % change (coarse trend)
}

export interface FundingPoint {
  ts: number;
  fundingRate: number;
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

export interface MeanReversionFeatures {
  symbol: string;
  price: number;
  zScore: number; // (price − SMA) / stdev  (negative ⇒ oversold)
  percentB: number; // Bollinger position: 0 = lower band, 1 = upper band
  rsi: number; // 0..100 oscillator
  smaDeviation: number; // (price − SMA) / SMA
}

export interface FundingFeatures {
  symbol: string;
  price: number;
  fundingRate: number; // current funding (>0 ⇒ longs pay shorts ⇒ short receives)
  fundingPrediction: number;
  fundingTrend: number; // avg of recent historical funding
  change24h: number;
}

export interface MacroFeatures {
  symbol: string;
  price: number;
  indexChange24h: number; // equity-index 24h trend
  cryptoChange24h: number; // BTC perp 24h trend (cross-asset reference)
  divergence: number; // crypto − index (cross-asset divergence)
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

/** Mirror of `kraken futures paper status -o json` (observed fields). */
export interface FuturesPaperStatus {
  equity: number;
  collateral: number;
  starting_collateral: number;
  total_fills: number;
  unrealized_pnl: number;
  pnl: number;
  pnl_pct: number;
  positions: number;
  open_orders: number;
  currency: string;
  mode: string;
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

/** One row of the merged equity time series (for the multi-line chart). */
export type EquityPoint = { t: number } & Record<string, number>;

// ─── Validation (out-of-sample backtest results) ─────────────────────────────
export interface BacktestMetrics {
  trades: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
  totalReturnPct: number;
}

export interface ValidationView {
  ts: number;
  strategy: string;
  symbol: string;
  interval: number;
  source: "real" | "synthetic";
  train: BacktestMetrics;
  test: BacktestMetrics; // out-of-sample
  trainCandles: number;
  testCandles: number;
}

// ─── Live finale (the closing wow) ───────────────────────────────────────────
export type FinalePhase = "idle" | "resolving" | "validating" | "validated" | "live" | "armed" | "done" | "error";

export interface FinaleState {
  phase: FinalePhase;
  live: boolean; // false = rehearsal
  leader: string | null;
  asset: string;
  size: number;
  notionalUsd: number;
  validateAccepted: boolean | null;
  fill: { price: number; size: number; fee: number } | null;
  balanceDelta: number | null;
  cancelAfterArmed: boolean;
  secondsRemaining: number | null;
  message: string;
  updatedAt: number;
}

export interface ArenaState {
  ts: number;
  agents: AgentSnapshot[];
  events: RiskEventView[];
  auditVerified: boolean | null;
  equitySeries: EquityPoint[];
  validation: ValidationView[];
  finale: FinaleState | null;
}
