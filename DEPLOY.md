# DEPLOY.md — running AgentZero Arena 24/7 on a VPS

The arena is two long-lived processes — the Next.js dashboard and the agent worker — kept
alive by **pm2**. It runs **paper-only** (live Kraken prices, **no credentials, no real money**);
the live-money finale is run separately from a trusted machine on explicit go-ahead.

> Reference deployment: Ubuntu 24.04 (x86_64), Node 22 (nvm), pnpm, dashboard on **:3100**.
> The box is shared — the arena coexists with other services and must not disturb them.

## Prerequisites on the host
- Node ≥ 22 (`node:sqlite` + `process.loadEnvFile`), pnpm, git.
- **Kraken reachable** — `curl -sS https://api.kraken.com/0/public/Time` must return JSON. If it's
  blocked (e.g. a mainland-China region), run offline instead: `ARENA_PRICE_FEED=replay`,
  `ARENA_ISOLATION_PROVIDER=virtual`.
- The **Kraken CLI** installed (Linux one-liner below) and **pm2**.

## First-time deploy
```bash
# 1. Kraken CLI (no Rust needed)
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/krakenfx/kraken-cli/releases/latest/download/kraken-cli-installer.sh | sh
kraken --version

# 2. pm2
pnpm add -g pm2     # or: npm i -g pm2

# 3. code
git clone <repo-url> ~/agentzero-arena && cd ~/agentzero-arena
pnpm install
pnpm build          # ~2GB RAM; ensure swap exists on small boxes

# 4. env (PAPER ONLY — never put Kraken keys here)
cat > .env <<'EOF'
ANTHROPIC_API_KEY=<your-mimo-or-anthropic-key>
ANTHROPIC_BASE_URL=https://token-plan-sgp.xiaomimimo.com/anthropic   # blank for real Anthropic
ARENA_AGENT_MODEL=mimo-v2.5-pro                                       # or claude-sonnet-4-6
ARENA_MAX_TOKENS=2048
ARENA_PRICE_FEED=live
ARENA_ISOLATION_PROVIDER=paper-cli
ARENA_TICK_SECONDS=20
ARENA_OHLC_INTERVAL=15
PORT=3100
EOF

# 5. verify the CLI on THIS OS (paper-state path + HOME isolation)
pnpm verify-cli

# 6. start + persist
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd      # run the command it prints, then `pm2 save` again

# 7. open the port (OS firewall + cloud security group)
sudo ufw allow 3100/tcp 2>/dev/null || true
#   …and open TCP 3100 in your cloud provider's firewall console (e.g. Tencent Lighthouse).

# 8. populate the Validation tab (out-of-sample backtest on real OHLC)
pnpm validate
```
Dashboard: `http://<vps-ip>:3100`

## Update flow
```bash
cd ~/agentzero-arena
git pull
pnpm install
pnpm build
pm2 restart arena-web arena-worker   # use restart, NOT reload — pm2 reload skips the tsx worker
```
> The dashboard has a **"▶ run finale · rehearsal"** button (top-right of the arena) that triggers a
> safe finale rehearsal — no real money. The worker clears the display event log + finale state on each
> boot (`ARENA_RESET_EVENTS_ON_BOOT`, default on), so `pm2 restart arena-worker` = clean slate for filming.
> The audit chain is never wiped.

## Operations
- Status / logs: `pm2 status`, `pm2 logs arena-worker --lines 50`, `pm2 logs arena-web`.
- **Run ONE worker only.** Two workers against the same `./data` fight over paper state
  (phantom trades + futures `*_state.json.lock` errors). pm2 keeps a single instance.
- Demo the Risk Marshal on cue: `pnpm tsx scripts/force-breach.ts macro-hedge "drawdown breach"`
  → a loud ⛔ BENCH event; `pnpm audit-dump` still verifies.
- Refresh validation anytime: `pnpm validate` (optionally a daily cron).
- **Fresh tournament (reset):** stop the worker, wipe state, restart BOTH processes:
  ```bash
  pm2 stop arena-worker
  rm -rf data/agents data/arena.db data/arena.db-shm data/arena.db-wal
  pm2 restart arena-worker arena-web    # restart WEB too — it holds the old DB inode open otherwise
  pnpm validate                          # repopulate the Validation tab
  ```
- **Public HTTPS:** a Cloudflare quick tunnel runs under pm2 as `arena-tunnel`
  (`pm2 start cloudflared --name arena-tunnel -- tunnel --url http://localhost:3100`). Its
  `*.trycloudflare.com` hostname is ephemeral (rotates on restart); grab the current one with
  `pm2 logs arena-tunnel --nostream | grep trycloudflare`. For a stable hostname, use a named tunnel
  with a Cloudflare-managed domain.

## Safety
- VPS is **paper-only**: no `KRAKEN_API_KEY/SECRET` in its `.env`. The wrapper strips those from
  every paper/market call regardless. `.env` and `/data` are git-ignored — never commit them.
- The live-money finale (`scripts/finale.ts --live`) is triple-gated and meant to be run from a
  trusted machine with a funded, least-privilege key (trading ON, withdrawals OFF) — not the VPS.
