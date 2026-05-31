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

export default function EquityChart({
  series,
  agents,
}: {
  series: EquityPoint[];
  agents: AgentSnapshot[];
}) {
  if (!series || series.length < 2) {
    return (
      <div className="flex h-[260px] items-center justify-center text-sm text-neutral-600">
        Equity curves appear as the agents trade…
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={series} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
        <XAxis
          dataKey="t"
          tickFormatter={(t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          stroke="#6b7280"
          fontSize={11}
          minTickGap={40}
        />
        <YAxis
          domain={["auto", "auto"]}
          tickFormatter={(v: number) => `$${Math.round(v).toLocaleString()}`}
          stroke="#6b7280"
          fontSize={11}
          width={68}
        />
        <Tooltip
          contentStyle={{ background: "#0a0b0f", border: "1px solid #1f2937", borderRadius: 8, fontSize: 12 }}
          labelFormatter={(t) => new Date(Number(t)).toLocaleTimeString()}
          formatter={(v, name) => [`$${Number(v).toFixed(2)}`, String(name)]}
        />
        {agents.map((a) => (
          <Line
            key={a.id}
            type="monotone"
            dataKey={a.id}
            name={a.name}
            stroke={STRATEGY_COLOR[a.strategy] ?? "#9ca3af"}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
