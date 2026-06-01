"use client";

import type { BacktestMetrics, ValidationView } from "@/lib/types";

const STRATEGY_LABEL: Record<string, string> = {
  momentum: "Momentum",
  "mean-reversion": "Mean-Reversion",
};

function num(n: number, d = 2): string {
  if (!Number.isFinite(n)) return "∞";
  return n.toFixed(d);
}
function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function MetricCols({ m, oos }: { m: BacktestMetrics; oos?: boolean }) {
  const ret = m.totalReturnPct;
  return (
    <>
      <td className={`px-3 py-2 text-right tabular ${oos ? "font-medium" : "text-neutral-400"}`}>{m.trades}</td>
      <td className={`px-3 py-2 text-right tabular ${oos ? "font-medium" : "text-neutral-400"}`}>{(m.winRate * 100).toFixed(0)}%</td>
      <td className={`px-3 py-2 text-right tabular ${ret >= 0 ? "text-emerald-400" : "text-red-400"}`}>{pct(ret)}</td>
      <td className={`px-3 py-2 text-right tabular ${m.sharpe >= 0 ? "text-emerald-400" : "text-red-400"}`}>{num(m.sharpe)}</td>
      <td className="px-3 py-2 text-right tabular text-neutral-400">{pct(m.maxDrawdownPct)}</td>
      <td className="px-3 py-2 text-right tabular text-neutral-400">{num(m.profitFactor)}</td>
    </>
  );
}

export default function ValidationPanel({ validation }: { validation: ValidationView[] }) {
  if (!validation || validation.length === 0) {
    return (
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-8 text-center text-sm text-neutral-500">
        No validation runs yet. Run <code className="rounded bg-neutral-800 px-1.5 py-0.5">pnpm validate</code> to backtest the spot strategies on real OHLC.
      </div>
    );
  }
  const source = validation[0]?.source ?? "real";
  const interval = validation[0]?.interval ?? 1440;

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs uppercase tracking-[0.15em] text-neutral-500">Out-of-sample validation</h2>
          <span className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ${source === "real" ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30" : "bg-amber-500/10 text-amber-300 ring-amber-500/30"}`}>
            {source === "real" ? "real OHLC" : "synthetic"} · {interval >= 1440 ? `${interval / 1440}d` : `${interval}m`} candles
          </span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2 font-medium">Strategy</th>
              <th className="px-3 py-2 font-medium">Symbol</th>
              <th className="px-3 py-2 font-medium">Window</th>
              <th className="px-3 py-2 text-right font-medium">Trades</th>
              <th className="px-3 py-2 text-right font-medium">Win</th>
              <th className="px-3 py-2 text-right font-medium">Return</th>
              <th className="px-3 py-2 text-right font-medium">Sharpe</th>
              <th className="px-3 py-2 text-right font-medium">Max DD</th>
              <th className="px-3 py-2 text-right font-medium">PF</th>
            </tr>
          </thead>
          <tbody>
            {validation.map((v) => (
              <RowPair key={`${v.strategy}-${v.symbol}`} v={v} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4 text-xs leading-relaxed text-neutral-500">
        <p className="mb-1 font-medium text-neutral-400">Limitations (stated plainly):</p>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>Kraken OHLC is capped at ~721 candles/interval; daily ⇒ ~2 years of history.</li>
          <li>Backtest uses {interval >= 1440 ? "daily" : `${interval}m`} candles; the live agents trade a 15m cadence — regimes and lag differ.</li>
          <li>Paper model: no slippage, no partial fills; Starter taker fee 0.26%; long-only spot.</li>
          <li>Funding-Carry &amp; Macro-Hedge (perps) have no historical OHLC via the CLI — validated <em>live</em> in the tournament.</li>
          {source === "synthetic" && <li className="text-amber-400">⚠ This run used synthetic candles (Kraken unreachable) — not real-data validation.</li>}
        </ul>
      </div>
    </section>
  );
}

function RowPair({ v }: { v: ValidationView }) {
  return (
    <>
      <tr className="border-b border-neutral-900/60 text-neutral-500">
        <td className="px-3 py-2" rowSpan={2}>{STRATEGY_LABEL[v.strategy] ?? v.strategy}</td>
        <td className="px-3 py-2" rowSpan={2}>{v.symbol}</td>
        <td className="px-3 py-2 text-neutral-500">train ({v.trainCandles})</td>
        <MetricCols m={v.train} />
      </tr>
      <tr className="border-b border-neutral-800">
        <td className="px-3 py-2 font-medium text-neutral-300">test ({v.testCandles}) · OOS</td>
        <MetricCols m={v.test} oos />
      </tr>
    </>
  );
}
