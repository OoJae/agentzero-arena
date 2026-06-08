"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AgentSnapshot, EquityPoint } from "@/lib/types";

export const STRATEGY_COLOR: Record<string, string> = {
  momentum: "#34d399",
  "mean-reversion": "#60a5fa",
  "funding-carry": "#fbbf24",
  "macro-hedge": "#f472b6",
  sentiment: "#a78bfa",
};

/**
 * GAP-AWARE: when the time between consecutive points is far larger than the typical
 * cadence (e.g. the worker was paused for hours), insert a null-valued break so the
 * line discontinues instead of drawing a misleading flat segment across the pause.
 */
function withGaps(series: EquityPoint[], agents: AgentSnapshot[]): EquityPoint[] {
  if (series.length < 3) return series;
  // typical step = median of consecutive deltas
  const deltas: number[] = [];
  for (let i = 1; i < series.length; i++) deltas.push(series[i]!.t - series[i - 1]!.t);
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const gapThreshold = Math.max(median * 6, 5 * 60_000); // >6× median or >5min

  const out: EquityPoint[] = [];
  for (let i = 0; i < series.length; i++) {
    const p = series[i]!;
    if (i > 0 && p.t - series[i - 1]!.t > gapThreshold) {
      // insert a break point with all agent values null (midpoint timestamp)
      const breakPoint: EquityPoint = { t: (p.t + series[i - 1]!.t) / 2 } as EquityPoint;
      for (const a of agents) (breakPoint as Record<string, number | null>)[a.id] = null as never;
      out.push(breakPoint);
    }
    out.push(p);
  }
  return out;
}

export default function EquityChart({
  series,
  agents,
}: {
  series: EquityPoint[];
  agents: AgentSnapshot[];
}) {
  if (!series || series.length < 2) {
    return (
      <div className="flex h-[300px] items-center justify-center font-mono text-sm text-fg-faint">
        Equity curves appear as the agents trade…
      </div>
    );
  }
  const data = withGaps(series, agents);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 12, right: 18, bottom: 0, left: 0 }}>
        <defs>
          {agents.map((a) => {
            const c = STRATEGY_COLOR[a.strategy] ?? "#9ca3af";
            return (
              <linearGradient key={a.id} id={`grad-${a.id}`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={c} stopOpacity={0.5} />
                <stop offset="100%" stopColor={c} stopOpacity={1} />
              </linearGradient>
            );
          })}
        </defs>
        <CartesianGrid stroke="#15171d" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={(t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          stroke="#3a4150"
          tick={{ fill: "#5b6675", fontSize: 10, fontFamily: "var(--font-mono)" }}
          tickLine={false}
          axisLine={false}
          minTickGap={48}
        />
        <YAxis
          domain={["auto", "auto"]}
          tickFormatter={(v: number) => `$${Math.round(v).toLocaleString()}`}
          stroke="#3a4150"
          tick={{ fill: "#5b6675", fontSize: 10, fontFamily: "var(--font-mono)" }}
          tickLine={false}
          axisLine={false}
          width={64}
        />
        <Tooltip
          contentStyle={{
            background: "rgba(14,16,20,0.95)",
            border: "1px solid #2a2e38",
            borderRadius: 12,
            fontSize: 12,
            fontFamily: "var(--font-mono)",
          }}
          labelStyle={{ color: "#9aa0ad" }}
          labelFormatter={(t) => new Date(Number(t)).toLocaleTimeString()}
          formatter={(v, name) => [`$${Number(v).toFixed(2)}`, String(name)]}
        />
        {agents.map((a) => (
          <Line
            key={a.id}
            type="monotone"
            dataKey={a.id}
            name={a.name}
            stroke={`url(#grad-${a.id})`}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: STRATEGY_COLOR[a.strategy] ?? "#9ca3af", strokeWidth: 0 }}
            isAnimationActive={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
