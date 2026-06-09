# AgentZero Arena

> **The Kraken CLI as the execution substrate for an economy of competing agents** —
> with a supervisor enforcing safety in real time.

### ▶ Live demo (24/7): **https://grand-hook-protective-attributes.trycloudflare.com**
<sub>Running on a VPS under pm2 against live Kraken prices. (Mirror: `http://43.153.109.3:3100`. The
Cloudflare quick-tunnel hostname may rotate on restart — check the repo for the current link.)</sub>

Four strategy-specialized AI agents (Momentum, Mean-Reversion, Funding-Carry on perps,
Macro-Hedge on equity-index perps) each trade their **own capital-isolated paper portfolio**
against **live Kraken prices**, competing on a real-time public leaderboard. A deterministic
**Risk Marshal** pre-screens every order, monitors drawdown/exposure, and **benches**
rule-breakers live — flattening their positions and arming the dead-man's switch
(`kraken order cancel-after`). After the tournament resolves, the winning strategy is
promoted from paper to a **small real crypto allocation** behind `--validate` and a kill switch.

Built for the Kraken **Agent Zero** hackathon. The headline is the *arena / agent-economy
frame* and *real-time safety supervision*, not "a profitable bot."

## Why this is different

- **A competitive multi-agent arena**, not a single bot — capital genuinely isolated per agent.
- **A Risk Marshal** that intervenes live (bench + flatten + dead-man's switch) — Kraken's
  stated priority around agentic guardrails, shown on camera.
- **Rare CLI surfaces:** per-agent isolation, `--validate` dry-runs, `cancel-after` dead-man's
  switch, WebSocket streaming, spot + perps breadth, native MCP, paper→live promotion.
- **Honest rigor:** tamper-evident hash-chained audit log + out-of-sample validation, limitations stated.

## Kraken CLI surfaces exercised (≥5)

Every Kraken interaction goes through one typed wrapper (`lib/kraken.ts`, `-o json`, branch on exit code).
The arena visibly uses:

1. **Spot paper trading** — `kraken paper init/buy/sell/status/balance`, isolated per agent.
2. **Futures paper trading** — `kraken futures paper …` (perps: `PF_XBTUSD`, `PF_ETHUSD`, S&P index `PF_SPXUSD`).
3. **Per-agent capital isolation** — each agent gets its own `$HOME`, relocating the CLI's paper state (verified).
4. **Market data** — `kraken ticker`, `ohlc`, `futures ticker`, `futures historical-funding-rates`.
5. **Live orders + `--validate`** — `kraken order buy … --validate` dry-run before any real fill (finale).
6. **Dead-man's switch** — `kraken order cancel-after <secs>` armed with a heartbeat in the live finale.
7. **Multi-asset breadth** — crypto spot **and** perps **and** an equity-index perp, in one tournament.
8. **MCP server** — read-only `kraken mcp -s market` wired in `kraken/.mcp.json`.

## Architecture (short)

```
Kraken CLI  ──(kraken <cmd> -o json, per-agent HOME)──►  Worker (Node, long-lived)
                                                          ├─ Agents (isolated paper portfolios)
                                                          ├─ Risk Marshal (veto + bench + kill-switch)
                                                          └─ Audit log (hash chain) ─► SQLite (WAL)
SQLite ──(SSE)──► Next.js 15 dashboard (leaderboard · thought feeds · events · live-finale)
```

Per-agent isolation is achieved by giving each agent its own `HOME`, which relocates the
Kraken CLI's paper state — verified empirically (see `kraken/cli-findings.json`). The whole tournament runs
in **paper mode with no credentials**; only the live finale touches real funds, behind
`--validate` + `cancel-after`, on the operator's explicit go-ahead.

## Quickstart

```bash
# 1. Install the Kraken CLI (no Rust needed)
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/krakenfx/kraken-cli/releases/latest/download/kraken-cli-installer.sh | sh

# 2. Install deps
pnpm install

# 3. (optional) configure
cp .env.example .env          # add ANTHROPIC_API_KEY for real LLM decisions (falls back without)

# 4. Verify the CLI on your machine (writes kraken/cli-findings.json)
pnpm verify-cli

# 5. Run the arena (dashboard on http://localhost:3000 + the agent worker)
pnpm dev
```

> **Network note:** live prices need `*.kraken.com` reachable. If your environment blocks it,
> set `ARENA_PRICE_FEED=replay` and `ARENA_ISOLATION_PROVIDER=virtual` for an offline demo, or
> run on a host with open egress.

**Deployed 24/7 on a VPS** under `pm2` (web + long-lived worker), fronted by a Cloudflare Tunnel for
HTTPS — see [`DEPLOY.md`](./DEPLOY.md) for the full runbook (Kraken CLI install, paper-only `.env`,
`pm2 start ecosystem.config.cjs`, firewall, update flow).

## Validation (out-of-sample, honest)

`pnpm validate` backtests the spot strategies' **exact deterministic signal logic** over **real
Kraken OHLC** (daily, ~2yr) with a chronological **70/30 train/test split**, and reports
out-of-sample metrics (win rate, return, Sharpe, max drawdown, profit factor) in the dashboard's
**Validation tab**. We show the train→test degradation candidly — that honesty is the point.

**Limitations (stated plainly):**
- Kraken OHLC is capped at ~721 candles/interval; daily ⇒ ~2 years of history.
- The backtest uses daily candles; the live agents trade a 15m cadence (regimes/lag differ).
- Paper model: no slippage, no partial fills; Starter taker fee 0.26%; long-only spot.
- **Funding-Carry & Macro-Hedge (perps) have no historical OHLC via the CLI** — they are validated
  *live* in the tournament, not in the offline harness.

## Safety

Paper-first by default; **no credentials, no real money** for the tournament (the CLI wrapper
strips `KRAKEN_API_KEY/SECRET` from every paper/market call). The live finale is crypto **spot
only** here (never xStocks), tiny notional (hard-capped), `--validate` before the order,
`cancel-after` armed with a heartbeat + on-screen countdown, and **withdrawals permission OFF**.
Secrets live in env only; `.env` is git-ignored.

The finale is **triple-gated**: a real order requires `--live` **and** `ARENA_FINALE_ARMED=YES`
**and** funded credentials present — otherwise it runs a safe **rehearsal** that places no order.

```bash
pnpm tsx scripts/finale.ts                       # rehearsal (default; no funds touched)
ARENA_FINALE_ARMED=YES pnpm tsx scripts/finale.ts --live --notional 20   # real (on your go-ahead)
```

## Tech

- **Dashboard:** Next.js 15 (App Router) + React 19, a cinematic Three.js (`@react-three/fiber`) hero,
  Framer Motion, Recharts, Tailwind v4 — live over SSE.
- **Runtime:** a long-lived Node/`tsx` worker (the agent loops + Risk Marshal), SQLite via `node:sqlite` (WAL).
- **Decision model:** provider-agnostic via the Anthropic SDK — runs on **MiMo `mimo-v2.5-pro`**
  (Anthropic-compatible endpoint) or real Anthropic, with a deterministic fallback so the arena always runs.
- **Execution substrate:** **Kraken CLI 0.3.2** via `child_process` (`kraken <cmd> -o json`).

## Project status — complete & live

Phases 0–4 done and deployed: four isolated agents trading live Kraken prices (MiMo-driven), the Risk
Marshal (veto + bench + flatten + dead-man's switch), tamper-evident hash-chained audit, out-of-sample
validation, and the live-finale path (built + rehearsed behind `--validate` + `cancel-after`). Running 24/7
on a VPS with a redesigned dashboard. See [`DEPLOY.md`](./DEPLOY.md) for the deployment runbook.

## License

For the Kraken Agent Zero hackathon. Not financial advice.
