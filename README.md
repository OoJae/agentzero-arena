# AgentZero Arena

> **The Kraken CLI as the execution substrate for an economy of competing agents** —
> with a supervisor enforcing safety in real time.

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

## Architecture (short)

```
Kraken CLI  ──(kraken <cmd> -o json, per-agent HOME)──►  Worker (Node, long-lived)
                                                          ├─ Agents (isolated paper portfolios)
                                                          ├─ Risk Marshal (veto + bench + kill-switch)
                                                          └─ Audit log (hash chain) ─► SQLite (WAL)
SQLite ──(SSE)──► Next.js 15 dashboard (leaderboard · thought feeds · events · live-finale)
```

Per-agent isolation is achieved by giving each agent its own `HOME`, which relocates the
Kraken CLI's paper state — verified empirically (see `CLAUDE.md`). The whole tournament runs
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

## Safety

Paper-first by default; **no credentials, no real money** for the tournament. The live finale
is crypto **spot/perps only** (never xStocks), tiny notional, `--validate` before every order,
`cancel-after` armed with a heartbeat, and **withdrawals permission OFF**. Secrets live in env
only; `.env` is git-ignored.

## Project status

Phase 0 (foundations) complete; Phase 1 (one isolated agent, end-to-end) in progress. See
`notes.md` for the running changelog and `02_BUILD_AgentZero_Arena.md` for the full plan.

## License

For the Kraken Agent Zero hackathon. Not financial advice.
