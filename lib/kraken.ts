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
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  ERROR_CATEGORIES,
  type AgentEnv,
  type Candle,
  type ErrorCategory,
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
  const retryable = envelope?.retryable ?? RETRYABLE_DEFAULT[category];
  throw new KrakenError({
    category,
    message: envelope?.message ?? `kraken exited ${exit ?? "null"}`,
    retryable,
    exitCode: exit,
    suggestion: envelope?.suggestion,
    raw: stdout || stderr,
  });
}

function runOnce(args: string[], opts: RunOpts = {}): unknown {
  const finalArgs = opts.json === false ? args : withJson(args);
  const res = spawnSync(KRAKEN_BIN, finalArgs, {
    env: buildEnv(opts.env, opts.finale),
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 25_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return interpretResult(
    {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      status: res.status,
      spawnError: res.error ? { message: res.error.message } : undefined,
    },
    { json: opts.json },
  );
}

/** Run with category-aware exponential backoff for retryable errors. */
async function run(args: string[], opts: RunOpts = {}): Promise<unknown> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return runOnce(args, opts);
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
