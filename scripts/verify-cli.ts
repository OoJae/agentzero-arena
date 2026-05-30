/**
 * scripts/verify-cli.ts — Day-1 empirical verification of the Kraken CLI.
 *
 * GOLDEN RULE: don't assume CLI behavior, verify it. This script resolves the
 * uncertain behaviors (BUILD.md Appendix B) and writes findings to
 * kraken/cli-findings.json so the wrapper + isolation layer are built to what the
 * CLI ACTUALLY does. Re-run it whenever the environment or CLI version changes.
 *
 * Safe by design: market-data probes are read-only; trade probes are PAPER only.
 * No credentials, no live orders.
 *
 * Run: pnpm verify-cli
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// ─── Resolve the kraken binary (installer puts it in ~/.cargo/bin) ───────────
function resolveKrakenBin(): string {
  const candidates = [
    process.env.KRAKEN_BIN,
    join(homedir(), ".cargo", "bin", "kraken"),
    "/usr/local/bin/kraken",
    "kraken",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c === "kraken") return c; // rely on PATH
    if (existsSync(c)) return c;
  }
  return "kraken";
}
const KRAKEN_BIN = resolveKrakenBin();

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json: unknown;
}

function run(args: string[], home?: string): RunResult {
  const env = { ...process.env };
  if (home) env.HOME = home;
  const r = spawnSync(KRAKEN_BIN, args, {
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  let json: unknown = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not json */
  }
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", json };
}

function isNetworkError(res: RunResult): boolean {
  const j = res.json as { error?: string } | null;
  if (j?.error === "network") return true;
  return /network error|could not resolve|connection timed out/i.test(
    res.stdout + res.stderr,
  );
}

// ─── Findings accumulator ────────────────────────────────────────────────────
type Status = "CONFIRMED" | "FAILED" | "DEFERRED" | "INFO";
interface Finding {
  id: string;
  question: string;
  status: Status;
  detail: string;
  evidence?: unknown;
}
const findings: Finding[] = [];
function record(f: Finding) {
  findings.push(f);
}

// ─── 0. Binary + version ─────────────────────────────────────────────────────
function checkVersion() {
  const r = run(["--version"]);
  record({
    id: "version",
    question: "Kraken CLI binary + version",
    status: r.code === 0 ? "INFO" : "FAILED",
    detail: `bin=${KRAKEN_BIN} version=${r.stdout.trim() || "unknown"} (exit ${r.code})`,
  });
}

// ─── 1. Per-agent isolation via HOME (THE critical question) ─────────────────
function checkIsolationHome() {
  const baseA = mkdtempSync(join(tmpdir(), "kraken-verify-A-"));
  const baseB = mkdtempSync(join(tmpdir(), "kraken-verify-B-"));
  try {
    const initA = run(["paper", "init", "--balance", "12345", "--currency", "USD", "-o", "json"], baseA);
    const initB = run(["paper", "init", "--balance", "67890", "--currency", "USD", "-o", "json"], baseB);
    const statusA = run(["paper", "status", "-o", "json"], baseA);
    const statusB = run(["paper", "status", "-o", "json"], baseB);

    const balA = (statusA.json as { starting_balance?: number } | null)?.starting_balance;
    const balB = (statusB.json as { starting_balance?: number } | null)?.starting_balance;

    const isolated =
      initA.code === 0 &&
      initB.code === 0 &&
      balA === 12345 &&
      balB === 67890;

    // Where did state land under each HOME?
    const statePaths = [
      "Library/Application Support/kraken/paper/state.json", // macOS (observed)
      ".local/share/kraken-cli/paper.db",
      ".config/kraken/paper/state.json",
    ];
    const foundA = statePaths.filter((p) => existsSync(join(baseA, p)));

    record({
      id: "isolation-home",
      question:
        "Does per-agent HOME give each agent its OWN isolated paper portfolio?",
      status: isolated ? "CONFIRMED" : "FAILED",
      detail: isolated
        ? `YES. Two agents with HOME overrides report independent balances (A=${balA}, B=${balB}). State under each HOME: ${foundA.join(", ") || "(path not in known list — inspect manually)"}.`
        : `Balances did not diverge as expected (A=${balA}, B=${balB}; exits ${initA.code}/${initB.code}). Inspect manually before trusting PaperCliProvider.`,
      evidence: { balA, balB, foundStatePaths: foundA, baseA, baseB },
    });
  } finally {
    rmSync(baseA, { recursive: true, force: true });
    rmSync(baseB, { recursive: true, force: true });
  }
}

// ─── 1b. XDG_CONFIG_HOME (secondary — suspected unreliable on macOS) ─────────
function checkIsolationXdg() {
  const base = mkdtempSync(join(tmpdir(), "kraken-verify-xdg-"));
  try {
    const env = { ...process.env, XDG_CONFIG_HOME: join(base, "cfg"), HOME: homedir() };
    const r = spawnSync(KRAKEN_BIN, ["paper", "init", "--balance", "31337", "-o", "json"], {
      env,
      encoding: "utf8",
      timeout: 20_000,
    });
    const wroteUnderXdg = existsSync(join(base, "cfg", "kraken"));
    record({
      id: "isolation-xdg",
      question: "Does XDG_CONFIG_HOME relocate paper state? (macOS data dir may ignore it)",
      status: "INFO",
      detail: `init exit=${r.status}; state under XDG_CONFIG_HOME/kraken = ${wroteUnderXdg ? "yes" : "no"}. On macOS the paper DB uses 'Application Support' (HOME-relative), so HOME override is the recommended lever.`,
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ─── 1c. Global --config flag? ───────────────────────────────────────────────
function checkConfigFlag() {
  const r = run(["--help"]);
  const help = r.stdout + r.stderr;
  const hasConfig = /--config(-dir)?\b/.test(help);
  record({
    id: "config-flag",
    question: "Is there a global --config / --config-dir override flag?",
    status: "INFO",
    detail: hasConfig
      ? "A --config(-dir) flag appears in `kraken --help` — could be an alternative isolation lever."
      : "No global --config flag found in `kraken --help`; use HOME override for isolation.",
  });
}

// ─── 2. Output + exit-code contract (no pipe masking) ────────────────────────
function checkExitCodeContract() {
  const home = mkdtempSync(join(tmpdir(), "kraken-verify-ec-"));
  try {
    // True success path: init (creates the paper account) then status.
    run(["paper", "init", "--balance", "10000", "-o", "json"], home);
    const ok = run(["paper", "status", "-o", "json"], home);
    // Guaranteed-failing paths: uninitialized status (app error) + bad subcommand (usage).
    const uninit = run(["paper", "status", "-o", "json"], mkdtempSync(join(tmpdir(), "kraken-verify-ec2-")));
    const bad = run(["definitely-not-a-command", "-o", "json"]);
    record({
      id: "exit-contract",
      question: "Exit code 0 = success, non-zero = failure? JSON on stdout?",
      status: ok.code === 0 ? "CONFIRMED" : "FAILED",
      detail: `success: init→status exit=${ok.code}, stdout is ${ok.json ? "valid JSON" : "non-JSON"}. failures: uninitialized status exit=${uninit.code}, bad subcommand exit=${bad.code}. Branch on exit code, never on string matching.`,
      evidence: { successExit: ok.code, uninitExit: uninit.code, badExit: bad.code },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ─── 3. --validate on live orders (help-only; never executes live) ───────────
function checkValidateFlag() {
  const r = run(["order", "buy", "--help"]);
  const help = r.stdout + r.stderr;
  const hasValidate = /--validate\b/.test(help);
  record({
    id: "validate-flag",
    question: "Does `--validate` exist on `kraken order buy` (live dry-run)?",
    status: hasValidate ? "CONFIRMED" : "DEFERRED",
    detail: hasValidate
      ? "`--validate` present in `kraken order buy --help`. Live finale will dry-run before any real order."
      : "Could not confirm `--validate` from help output (exit " + r.code + "). Verify on a network-enabled host.",
  });
}

// ─── 4. Symbol format + market data (needs network) ──────────────────────────
function checkSymbolFormat() {
  const variants = ["BTCUSD", "BTC/USD", "XBTUSD", "XBT/USD"];
  const results: Record<string, string> = {};
  let anyNetwork = false;
  for (const sym of variants) {
    const r = run(["ticker", sym, "-o", "json"]);
    if (isNetworkError(r)) {
      anyNetwork = true;
      results[sym] = "network-blocked";
    } else if (r.code === 0 && r.json) {
      results[sym] = "OK";
    } else {
      results[sym] = `rejected (exit ${r.code})`;
    }
  }
  const accepted = Object.entries(results)
    .filter(([, v]) => v === "OK")
    .map(([k]) => k);
  record({
    id: "symbol-format",
    question: "Which symbol format does `ticker` accept (BTCUSD vs BTC/USD vs XBT)?",
    status: accepted.length ? "CONFIRMED" : "DEFERRED",
    detail: accepted.length
      ? `Accepted: ${accepted.join(", ")}.`
      : anyNetwork
        ? "DEFERRED — *.kraken.com egress is blocked in this environment; re-run on a network-enabled host (user's terminal / VPS)."
        : "No variant accepted and no network error — inspect manually.",
    evidence: results,
  });
}

// ─── 5. ohlc intervals (help) ────────────────────────────────────────────────
function checkOhlcHelp() {
  const r = run(["ohlc", "--help"]);
  const help = r.stdout + r.stderr;
  const m = help.match(/--interval[^\n]*\n?[^\n]*/);
  record({
    id: "ohlc-interval",
    question: "What `--interval` values does `kraken ohlc` accept?",
    status: r.code === 0 ? "INFO" : "DEFERRED",
    detail: m ? `help excerpt: ${m[0].replace(/\s+/g, " ").trim()}` : `(no --interval line found; exit ${r.code})`,
  });
}

// ─── 6. Subaccount + futures paper (help-only) ───────────────────────────────
function checkSubaccountHelp() {
  const r = run(["subaccount", "--help"]);
  const help = (r.stdout + r.stderr).split("\n").filter((l) => /create|transfer|list|^\s{2,}\w/.test(l)).slice(0, 8);
  record({
    id: "subaccount",
    question: "What does the `subaccount` group expose? (eligibility needs creds → deferred)",
    status: r.code === 0 ? "INFO" : "DEFERRED",
    detail: r.code === 0 ? `subcommands: ${help.join(" | ").replace(/\s+/g, " ").trim().slice(0, 300)}` : `help exit ${r.code}`,
  });
}

function checkFuturesPaperHelp() {
  const r = run(["futures", "paper", "--help"]);
  record({
    id: "futures-paper",
    question: "Does `kraken futures paper` exist? (Phase 2 perps agents)",
    status: r.code === 0 ? "INFO" : "DEFERRED",
    detail: r.code === 0 ? "`futures paper` group present — Phase 2 Funding-Carry/Macro-Hedge can use it (re-test isolation there)." : `not confirmed (exit ${r.code})`,
  });
}

// ─── Network reachability summary ────────────────────────────────────────────
function checkNetwork() {
  const r = run(["ticker", "BTCUSD", "-o", "json"]);
  const blocked = isNetworkError(r);
  record({
    id: "network",
    question: "Is *.kraken.com reachable from this environment?",
    status: blocked ? "DEFERRED" : "CONFIRMED",
    detail: blocked
      ? "NO — Kraken egress is blocked here (allowlist). Build + paper-state + unit tests work offline; LIVE prices require running on the user's terminal/VPS. Use ARENA_PRICE_FEED=replay for offline dev."
      : "YES — live market data reachable.",
  });
}

// ─── Report ──────────────────────────────────────────────────────────────────
function printReport() {
  const icon: Record<Status, string> = {
    CONFIRMED: "✅",
    INFO: "ℹ️ ",
    DEFERRED: "⏸️ ",
    FAILED: "❌",
  };
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  AgentZero Arena — Kraken CLI Verification Report");
  console.log("══════════════════════════════════════════════════════════════\n");
  for (const f of findings) {
    console.log(`${icon[f.status]} [${f.status}] ${f.question}`);
    console.log(`    ${f.detail}\n`);
  }

  const iso = findings.find((f) => f.id === "isolation-home");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(
    `  ISOLATION VERDICT: ${
      iso?.status === "CONFIRMED"
        ? "PaperCliProvider via per-agent HOME ✅ (default)"
        : "Per-agent HOME unconfirmed → default to VirtualProvider ⚠️"
    }`,
  );
  console.log("──────────────────────────────────────────────────────────────\n");

  const out = {
    generatedAt: new Date().toISOString(),
    krakenBin: KRAKEN_BIN,
    findings,
  };
  const outPath = join(process.cwd(), "kraken", "cli-findings.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Findings written to ${outPath}\n`);
}

function main() {
  checkVersion();
  checkNetwork();
  checkIsolationHome();
  checkIsolationXdg();
  checkConfigFlag();
  checkExitCodeContract();
  checkValidateFlag();
  checkSymbolFormat();
  checkOhlcHelp();
  checkSubaccountHelp();
  checkFuturesPaperHelp();
  printReport();
}

main();

// Re-export for potential reuse/testing.
export { run, isNetworkError };
export type { RunResult };
