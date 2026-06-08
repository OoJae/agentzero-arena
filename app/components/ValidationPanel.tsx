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
      <td className={`px-3 py-2 text-right tabular ${oos ? "text-fg font-medium" : "text-fg-dim"}`}>{m.trades}</td>
      <td className={`px-3 py-2 text-right tabular ${oos ? "text-fg font-medium" : "text-fg-dim"}`}>{(m.winRate * 100).toFixed(0)}%</td>
      <td className="px-3 py-2 text-right tabular" style={{ color: ret >= 0 ? "var(--up)" : "var(--down)" }}>{pct(ret)}</td>
      <td className="px-3 py-2 text-right tabular" style={{ color: m.sharpe >= 0 ? "var(--up)" : "var(--down)" }}>{num(m.sharpe)}</td>
      <td className="px-3 py-2 text-right tabular text-fg-dim">{pct(m.maxDrawdownPct)}</td>
      <td className="px-3 py-2 text-right tabular text-fg-dim">{num(m.profitFactor)}</td>
    </>
  );
}

export default function ValidationPanel({ validation }: { validation: ValidationView[] }) {
  if (!validation || validation.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-bg-elev/50 p-10 text-center font-mono text-sm text-fg-faint">
        No validation runs yet. Run <code className="rounded bg-bg-elev2 px-1.5 py-0.5">pnpm validate</code> to backtest the spot strategies on real OHLC.
      </div>
    );
  }
  const source = validation[0]?.source ?? "real";
  const interval = validation[0]?.interval ?? 1440;

  return (
    <section className="space-y-4">
      <div className="overflow-x-auto rounded-2xl border border-line bg-bg-elev/50 p-5">
        <div className="mb-4 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-fg-faint">train vs. held-out test</span>
          <span
            className="rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider"
            style={{ color: source === "real" ? "var(--up)" : "var(--live)", background: `color-mix(in srgb, ${source === "real" ? "var(--up)" : "var(--live)"} 12%, transparent)` }}
          >
            {source === "real" ? "real OHLC" : "synthetic"} · {interval >= 1440 ? `${interval / 1440}d` : `${interval}m`} candles
          </span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-fg-faint">
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

      <div className="rounded-xl border border-line bg-bg-elev/30 p-5 text-xs leading-relaxed text-fg-faint">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-fg-dim">Limitations (stated plainly)</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>Kraken OHLC is capped at ~721 candles/interval; daily ⇒ ~2 years of history.</li>
          <li>Backtest uses {interval >= 1440 ? "daily" : `${interval}m`} candles; the live agents trade a 15m cadence — regimes and lag differ.</li>
          <li>Paper model: no slippage, no partial fills; Starter taker fee 0.26%; long-only spot.</li>
          <li>Funding-Carry &amp; Macro-Hedge (perps) have no historical OHLC via the CLI — validated <em>live</em> in the tournament.</li>
          {source === "synthetic" && <li style={{ color: "var(--live)" }}>⚠ This run used synthetic candles (Kraken unreachable) — not real-data validation.</li>}
        </ul>
      </div>
    </section>
  );
}

function RowPair({ v }: { v: ValidationView }) {
  return (
    <>
      <tr className="text-fg-faint">
        <td className="px-3 py-2 font-medium text-fg-dim" rowSpan={2}>{STRATEGY_LABEL[v.strategy] ?? v.strategy}</td>
        <td className="px-3 py-2 font-mono text-xs" rowSpan={2}>{v.symbol}</td>
        <td className="px-3 py-2 font-mono text-xs">train ({v.trainCandles})</td>
        <MetricCols m={v.train} />
      </tr>
      <tr className="border-b border-line">
        <td className="px-3 py-2 font-mono text-xs font-medium text-fg">test ({v.testCandles}) · OOS</td>
        <MetricCols m={v.test} oos />
      </tr>
    </>
  );
}
