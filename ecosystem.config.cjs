/**
 * pm2 process config for the VPS (24/7).
 *
 *   arena-web    → Next.js dashboard (next start), bound to 0.0.0.0:$PORT
 *   arena-worker → the long-lived agent runtime (tsx worker/index.ts), SINGLE instance
 *                  (the per-agent CLI mutex in worker/index.ts assumes exactly one worker)
 *
 * Usage on the VPS (login shell so nvm node/pnpm resolve):
 *   pm2 start ecosystem.config.cjs && pm2 save && pm2 startup systemd
 *
 * Paper-only on the VPS — no Kraken credentials in .env. The live finale runs from the Mac.
 */
module.exports = {
  apps: [
    {
      name: "arena-web",
      script: "pnpm",
      args: "start",
      cwd: __dirname,
      env: { NODE_ENV: "production", PORT: "3100" },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      out_file: "./data/pm2-web.out.log",
      error_file: "./data/pm2-web.err.log",
      time: true,
    },
    {
      name: "arena-worker",
      script: "pnpm",
      args: "worker",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      // Long-lived agent loops — never fork multiple instances.
      instances: 1,
      out_file: "./data/pm2-worker.out.log",
      error_file: "./data/pm2-worker.err.log",
      time: true,
    },
  ],
};
