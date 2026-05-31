/**
 * lib/kraken.ts — THE only path to the Kraken CLI.
 *
 * Contract (verified against kraken-cli 0.3.2; see CLAUDE.md):
 *  - Always invoke with `-o json`.
 *  - Branch on EXIT CODE (0 = success). Never parse stderr for data.
 *  - On failure, stdout carries a JSON envelope {error, message, suggestion?, retryable?};
 *    we throw a typed `KrakenError` carrying the mapped category.
 *  - Accept a per-agent env (HOME) for isolation.
 *  - Retry retryable categories (network/websocket/rate_limit) with capped backoff.
 *
 * Live methods exist but MUST only run during the explicit finale (see safety rules).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  ERROR_CATEGORIES,
  type AgentEnv,
  type Candle,
  type ErrorCategory,
  type FundingPoint,
  type FuturesPaperStatus,
  type FuturesTickerData,
  type KrakenErrorEnvelope,
  type PaperStatus,
  type TickerQuote,
} from "./types.js";

// ─── Binary resolution ───────────────────────────────────────────────────────
function resolveBin(): string {
  const candidates = [
    process.env.KRAKEN_BIN,
    join(homedir(), ".cargo", "bin", "kraken"),
    "/usr/local/bin/kraken",
    "/opt/homebrew/bin/kraken",
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  return "kraken"; // rely on PATH
}
const KRAKEN_BIN = resolveBin();

// ─── Typed error ─────────────────────────────────────────────────────────────
export class KrakenError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly exitCode: number | null;
  readonly suggestion?: string;
  readonly raw: string;

  constructor(opts: {
    category: ErrorCategory;
    message: string;
    retryable: boolean;
    exitCode: number | null;
    suggestion?: string;
    raw: string;
  }) {
    super(opts.message);
    this.name = "KrakenError";
    this.category = opts.category;
    this.retryable = opts.retryable;
    this.exitCode = opts.exitCode;
    this.suggestion = opts.suggestion;
    this.raw = opts.raw;
  }
}

const RETRYABLE_DEFAULT: Record<ErrorCategory, boolean> = {
  auth: false,
  api: false,
  validation: false,
  config: false,
  io: false,
  parse: false,
  network: true,
  websocket: true,
  rate_limit: true,
};

/** Max retries per category (network 5, websocket 12, rate_limit agent-controlled). */
const MAX_RETRIES: Partial<Record<ErrorCategory, number>> = {
  network: 5,
  websocket: 12,
  rate_limit: 4,
};

export function mapCategory(envelope: KrakenErrorEnvelope | null, combined: string): ErrorCategory {
  const raw = envelope?.error?.toLowerCase();
  if (raw && (ERROR_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as ErrorCategory;
  }
  const text = (combined + " " + (envelope?.message ?? "")).toLowerCase();
  if (/network|could not resolve|connection|timed out|timeout/.test(text)) return "network";
  if (/websocket|ws closed|stream/.test(text)) return "websocket";
  if (/rate.?limit|too many requests|429/.test(text)) return "rate_limit";
  if (/unauthor|invalid key|signature|permission|api key/.test(text)) return "auth";
  if (/insufficient|unknown pair|invalid pair|order|funds/.test(text)) return "api";
  if (/parse|unexpected token|invalid json/.test(text)) return "parse";
  if (/usage|unrecognized|invalid value|required/.test(text)) return "validation";
  return "api";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Core runner (one-shot, JSON) ────────────────────────────────────────────
/**
 * Build the subprocess env. SAFETY: Kraken credentials are STRIPPED for every call
 * except an explicit finale (`finale: true`). The whole paper tournament therefore
 * runs credential-free by construction — even though live keys may sit in `.env` —
 * so a stray `order` command cannot authenticate.
 */
function buildEnv(env?: AgentEnv, finale = false): NodeJS.ProcessEnv {
  const base = { ...process.env };
  if (!finale) {
    delete base.KRAKEN_API_KEY;
    delete base.KRAKEN_API_SECRET;
  }
  if (env?.home) base.HOME = env.home;
  if (env?.extra) Object.assign(base, env.extra);
  return base;
}

/** Ensure `-o json` is present exactly once. */
function withJson(args: string[]): string[] {
  if (args.includes("-o") || args.includes("--output")) return args;
  return [...args, "-o", "json"];
}

interface RunOpts {
  env?: AgentEnv;
  timeoutMs?: number;
  /** If false, do not append `-o json` (e.g. for cancel-after which returns plain). */
  json?: boolean;
  /** Finale ONLY: keep Kraken credentials in the subprocess env (auth'd live calls). */
  finale?: boolean;
}

export interface RawResult {
  stdout: string;
  stderr: string;
  status: number | null;
  /** Set when the process could not be spawned (binary missing, timeout). */
  spawnError?: { message: string };
}

/**
 * Pure interpretation of a CLI result per the contract (exit code → success/failure;
 * JSON on success; mapped KrakenError on failure). Extracted so it is unit-testable
 * without spawning a process.
 */
export function interpretResult(res: RawResult, opts: { json?: boolean } = {}): unknown {
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  const exit = res.status;

  // Spawn-level failure (binary missing, timeout).
  if (res.spawnError) {
    const msg = res.spawnError.message;
    const category: ErrorCategory = /ENOENT/.test(msg) ? "config" : "network";
    throw new KrakenError({
      category,
      message: `kraken spawn failed: ${msg}`,
      retryable: category === "network",
      exitCode: exit,
      raw: stderr || msg,
    });
  }

  let parsed: unknown = null;
  try {
    parsed = stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    parsed = null;
  }

  if (exit === 0) {
    if (opts.json === false) return stdout.trim();
    if (parsed === null) {
      throw new KrakenError({
        category: "parse",
        message: `expected JSON on success but could not parse stdout`,
        retryable: false,
        exitCode: exit,
        raw: stdout || stderr,
      });
    }
    return parsed;
  }

  // Non-zero exit → failure. Map the envelope to a category.
  const envelope = (parsed && typeof parsed === "object" && "error" in (parsed as object)
    ? (parsed as KrakenErrorEnvelope)
    : null);
  const category = mapCategory(envelope, stdout + " " + stderr);
  const message = envelope?.message ?? `kraken exited ${exit ?? "null"}`;
  // The paper-state lock is a brief transient ("Try again shortly") — make it retryable
  // even though its category is `validation`, so concurrent calls self-heal.
  const locked = /locked by another process/i.test(message);
  const retryable = locked ? true : (envelope?.retryable ?? RETRYABLE_DEFAULT[category]);
  throw new KrakenError({
    category,
    message,
    retryable,
    exitCode: exit,
    suggestion: envelope?.suggestion,
    raw: stdout || stderr,
  });
}

/** Spawn `kraken` asynchronously (NON-blocking — never use spawnSync; it stalls the
 *  event loop and starves concurrent agents + async LLM calls). Collects stdout/stderr. */
function spawnCollect(args: string[], opts: RunOpts): Promise<RawResult> {
  return new Promise((resolve) => {
    const child = spawn(KRAKEN_BIN, args, { env: buildEnv(opts.env, opts.finale) });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: RawResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ stdout, stderr, status: null, spawnError: { message: "kraken call timed out" } });
    }, opts.timeoutMs ?? 25_000);
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e) => finish({ stdout, stderr, status: null, spawnError: { message: e.message } }));
    child.on("close", (code) => finish({ stdout, stderr, status: code }));
  });
}

async function runOnce(args: string[], opts: RunOpts = {}): Promise<unknown> {
  const finalArgs = opts.json === false ? args : withJson(args);
  const raw = await spawnCollect(finalArgs, opts);
  return interpretResult(raw, { json: opts.json });
}

/** Run with category-aware exponential backoff for retryable errors. */
async function run(args: string[], opts: RunOpts = {}): Promise<unknown> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await runOnce(args, opts);
    } catch (err) {
      if (!(err instanceof KrakenError) || !err.retryable) throw err;
      const cap = MAX_RETRIES[err.category] ?? 3;
      if (attempt >= cap) throw err;
      const backoff = Math.min(30_000, 1000 * 2 ** attempt);
      attempt += 1;
      await sleep(backoff);
    }
  }
}

// ─── Symbol mapping (kept central so a format change is one edit) ─────────────
// Verified pair format is DEFERRED (network-blocked here); help examples use
// BTCUSD (paper) / XBTUSD (live). Identity by default; override per env if needed.
export function toCliPair(symbol: string): string {
  return symbol;
}

// ─── Public typed surface ────────────────────────────────────────────────────

export async function ticker(pair: string, env?: AgentEnv): Promise<TickerQuote> {
  const raw = (await run(["ticker", toCliPair(pair)], { env })) as Record<string, unknown>;
  // Kraken ticker JSON shape varies; extract a robust "last" price.
  const last = extractLast(raw);
  return { symbol: pair, last, ts: Date.now() };
}

/** Best-effort extraction of last-trade price from a ticker envelope. */
function extractLast(raw: unknown): number {
  if (raw == null) return NaN;
  if (typeof raw === "number") return raw;
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    // common shapes: { last }, { c: [last, ...] }, { result: { PAIR: { c: [..] } } }
    if (typeof o.last === "number") return o.last;
    if (typeof o.last === "string") return Number(o.last);
    if (Array.isArray(o.c) && o.c.length) return Number(o.c[0]);
    if (o.result && typeof o.result === "object") {
      const first = Object.values(o.result as Record<string, unknown>)[0];
      return extractLast(first);
    }
    // nested single-key wrappers
    const vals = Object.values(o);
    if (vals.length === 1) return extractLast(vals[0]);
  }
  return NaN;
}

export async function ohlc(
  pair: string,
  intervalMinutes: number,
  env?: AgentEnv,
): Promise<Candle[]> {
  const raw = await run(["ohlc", toCliPair(pair), "--interval", String(intervalMinutes)], {
    env,
  });
  return normalizeCandles(raw);
}

/** Normalize Kraken OHLC into typed candles. Kraken returns arrays like
 *  [time, open, high, low, close, vwap, volume, count]. */
function normalizeCandles(raw: unknown): Candle[] {
  let rows: unknown[] = [];
  if (Array.isArray(raw)) rows = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    // Verified shape: { "XXBTZUSD": [[time,o,h,l,c,vwap,vol,count], ...] }
    // Also handle { candles: [...] } and { result: { PAIR: [...] } }.
    const candidate =
      (Array.isArray(o.candles) && o.candles) ||
      (o.result && typeof o.result === "object"
        ? Object.values(o.result as Record<string, unknown>).find((v) => Array.isArray(v))
        : undefined) ||
      Object.values(o).find((v) => Array.isArray(v));
    if (Array.isArray(candidate)) rows = candidate;
  }
  return rows
    .map((r): Candle | null => {
      if (Array.isArray(r) && r.length >= 5) {
        return {
          time: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[6] ?? r[5] ?? 0),
        };
      }
      if (r && typeof r === "object") {
        const o = r as Record<string, unknown>;
        return {
          time: Number(o.time ?? o.t ?? 0),
          open: Number(o.open ?? o.o ?? 0),
          high: Number(o.high ?? o.h ?? 0),
          low: Number(o.low ?? o.l ?? 0),
          close: Number(o.close ?? o.c ?? 0),
          volume: Number(o.volume ?? o.v ?? 0),
        };
      }
      return null;
    })
    .filter((c): c is Candle => c !== null && Number.isFinite(c.close));
}

export async function orderbook(pair: string, env?: AgentEnv): Promise<unknown> {
  return run(["orderbook", toCliPair(pair)], { env });
}

// ─── Paper trading (no auth) ─────────────────────────────────────────────────
export async function paperInit(
  env: AgentEnv,
  balance: number,
  currency = "USD",
): Promise<unknown> {
  return run(
    ["paper", "init", "--balance", String(balance), "--currency", currency],
    { env },
  );
}

export async function paperBuy(
  env: AgentEnv,
  pair: string,
  volume: number,
  opts?: { type?: "market" | "limit"; price?: number },
): Promise<unknown> {
  const args = ["paper", "buy", toCliPair(pair), String(volume)];
  if (opts?.type) args.push("--type", opts.type);
  if (opts?.price != null) args.push("--price", String(opts.price));
  return run(args, { env });
}

export async function paperSell(
  env: AgentEnv,
  pair: string,
  volume: number,
  opts?: { type?: "market" | "limit"; price?: number },
): Promise<unknown> {
  const args = ["paper", "sell", toCliPair(pair), String(volume)];
  if (opts?.type) args.push("--type", opts.type);
  if (opts?.price != null) args.push("--price", String(opts.price));
  return run(args, { env });
}

export async function paperStatus(env: AgentEnv): Promise<PaperStatus> {
  return (await run(["paper", "status"], { env })) as PaperStatus;
}

/** Open spot paper positions, normalized to symbol→base-units (best-effort). */
export async function paperBalance(env: AgentEnv): Promise<Record<string, number>> {
  const raw = await run(["paper", "balance"], { env });
  const out: Record<string, number> = {};
  // Shape unverified across versions; accept {balances:{ASSET:qty}} or {ASSET:qty} or [{asset,amount}].
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const src = (obj.balances ?? obj.assets ?? obj) as Record<string, unknown> | unknown[];
  if (Array.isArray(src)) {
    for (const r of src) {
      if (r && typeof r === "object") {
        const o = r as Record<string, unknown>;
        const sym = String(o.asset ?? o.symbol ?? o.currency ?? "");
        const qty = Number(o.amount ?? o.balance ?? o.volume ?? 0);
        if (sym && Number.isFinite(qty)) out[sym] = qty;
      }
    }
  } else if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src)) {
      const qty = Number(v);
      if (Number.isFinite(qty)) out[k] = qty;
    }
  }
  return out;
}

// ─── Futures market data (no auth) ───────────────────────────────────────────
export async function futuresTicker(symbol: string): Promise<FuturesTickerData> {
  const raw = (await run(["futures", "ticker", symbol])) as Record<string, unknown>;
  const t = (raw?.ticker ?? raw) as Record<string, unknown>;
  return {
    symbol: String(t.symbol ?? symbol),
    last: Number(t.last ?? t.markPrice ?? NaN),
    markPrice: Number(t.markPrice ?? t.last ?? NaN),
    indexPrice: Number(t.indexPrice ?? t.markPrice ?? NaN),
    fundingRate: Number(t.fundingRate ?? 0),
    fundingRatePrediction: Number(t.fundingRatePrediction ?? 0),
    change24h: Number(t.change24h ?? 0),
  };
}

export async function futuresTickers(): Promise<unknown> {
  return run(["futures", "tickers"]);
}

export async function futuresInstruments(): Promise<unknown> {
  return run(["futures", "instruments"]);
}

/** Historical funding-rate series, normalized oldest→newest. */
export async function futuresHistoricalFundingRates(symbol: string): Promise<FundingPoint[]> {
  const raw = await run(["futures", "historical-funding-rates", symbol]);
  let rows: unknown[] = [];
  if (Array.isArray(raw)) rows = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const arr = (Array.isArray(o.rates) && o.rates) || Object.values(o).find((v) => Array.isArray(v));
    if (Array.isArray(arr)) rows = arr;
  }
  return rows
    .map((r): FundingPoint | null => {
      if (!r || typeof r !== "object") return null;
      const o = r as Record<string, unknown>;
      const fr = Number(o.fundingRate ?? o.relativeFundingRate ?? NaN);
      const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : Number(o.timestamp ?? 0);
      return Number.isFinite(fr) ? { ts, fundingRate: fr } : null;
    })
    .filter((p): p is FundingPoint => p !== null);
}

// ─── Futures paper trading (no auth) ─────────────────────────────────────────
export async function futuresPaperInit(
  env: AgentEnv,
  balance: number,
  currency = "USD",
): Promise<unknown> {
  return run(["futures", "paper", "init", "--balance", String(balance), "--currency", currency], { env });
}

interface FuturesOrderOpts {
  leverage: number; // REQUIRED by the CLI (validation error otherwise)
  type?: "market" | "limit";
  price?: number;
  reduceOnly?: boolean; // close-only (for flattening a position)
}

function futuresOrderArgs(side: "buy" | "sell", symbol: string, size: number, opts: FuturesOrderOpts): string[] {
  const args = ["futures", "paper", side, symbol, String(size), "--leverage", String(opts.leverage)];
  args.push("--type", opts.type ?? "market");
  if (opts.price != null) args.push("--price", String(opts.price));
  if (opts.reduceOnly) args.push("--reduce-only");
  return args;
}

export async function futuresPaperBuy(env: AgentEnv, symbol: string, size: number, opts: FuturesOrderOpts): Promise<unknown> {
  return run(futuresOrderArgs("buy", symbol, size, opts), { env });
}

export async function futuresPaperSell(env: AgentEnv, symbol: string, size: number, opts: FuturesOrderOpts): Promise<unknown> {
  return run(futuresOrderArgs("sell", symbol, size, opts), { env });
}

export async function futuresPaperStatus(env: AgentEnv): Promise<FuturesPaperStatus> {
  return (await run(["futures", "paper", "status"], { env })) as FuturesPaperStatus;
}

export async function futuresPaperPositions(env: AgentEnv): Promise<unknown> {
  return run(["futures", "paper", "positions"], { env });
}

// ─── LIVE order surface — FINALE ONLY, never called in the paper tournament ───
export async function orderBuyLive(
  env: AgentEnv,
  pair: string,
  volume: number,
  opts: { type?: "market" | "limit"; price?: number; validate?: boolean } = {},
): Promise<unknown> {
  const args = ["order", "buy", toCliPair(pair), String(volume)];
  // Live --type defaults to LIMIT, so be explicit.
  args.push("--type", opts.type ?? "market");
  if (opts.price != null) args.push("--price", String(opts.price));
  if (opts.validate) args.push("--validate");
  args.push("--yes");
  return run(args, { env, finale: true });
}

/** Dead-man's switch: cancel all open orders after <seconds> (0 disables). */
export async function cancelAfter(env: AgentEnv, seconds: number): Promise<unknown> {
  return run(["order", "cancel-after", String(seconds)], { env, finale: true });
}

// ─── WebSocket streaming (NDJSON) ────────────────────────────────────────────
export interface WsHandle {
  stop: () => void;
}

/** Stream live ticker updates; calls onTick per NDJSON line. */
export function wsTicker(
  pairs: string[],
  onTick: (obj: unknown) => void,
  env?: AgentEnv,
): WsHandle {
  const args = withJson(["ws", "ticker", ...pairs.map(toCliPair)]);
  const child = spawn(KRAKEN_BIN, args, { env: buildEnv(env) });
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    try {
      onTick(JSON.parse(t));
    } catch {
      /* ignore non-JSON status lines */
    }
  });
  return {
    stop: () => {
      rl.close();
      child.kill("SIGTERM");
    },
  };
}

export { KRAKEN_BIN };
