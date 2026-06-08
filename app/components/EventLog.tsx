"use client";

import { motion } from "framer-motion";
import type { RiskEventView } from "@/lib/types";

/** Collapse runs of identical (type+detail) events into one row with a count + latest time. */
function collapse(events: RiskEventView[]): Array<RiskEventView & { count: number }> {
  const out: Array<RiskEventView & { count: number }> = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (prev && prev.type === e.type && prev.detail === e.detail) {
      prev.count += 1;
      if (e.ts > prev.ts) prev.ts = e.ts;
    } else {
      out.push({ ...e, count: 1 });
    }
  }
  return out;
}

export default function EventLog({ events }: { events: RiskEventView[] }) {
  if (!events || events.length === 0) {
    return (
      <div className="flex h-[120px] items-center justify-center font-mono text-sm text-fg-faint">
        No risk events yet — the Risk Marshal is watching.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {collapse(events).map((e) => {
        const bench = e.type === "BENCH";
        const veto = e.type === "VETO";
        const color = bench ? "var(--down)" : veto ? "var(--live)" : "var(--fg-dim)";
        return (
          <motion.li
            key={e.id}
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="relative overflow-hidden rounded-xl px-4 py-3 text-sm"
            style={{
              background: bench ? "color-mix(in srgb, var(--down) 9%, transparent)" : veto ? "color-mix(in srgb, var(--live) 5%, transparent)" : "var(--bg-elev)",
              boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} ${bench ? "45" : "22"}%, transparent)`,
            }}
          >
            <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-semibold uppercase tracking-wider" style={{ color }}>
                {bench ? "⛔ BENCH" : veto ? "⚠ VETO" : e.type}
                {e.count > 1 && (
                  <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[10px] tabular">× {e.count}</span>
                )}
              </span>
              <span className="font-mono text-[10px] text-fg-faint tabular">
                {new Date(e.ts).toLocaleTimeString()}
              </span>
            </div>
            <p className={`mt-1 leading-snug ${bench ? "text-fg" : "text-fg-dim"}`}>{e.detail}</p>
          </motion.li>
        );
      })}
    </ul>
  );
}
