"use client";

import type { RiskEventView } from "@/lib/types";

/** Collapse runs of identical (type+detail) events into one row with a count + latest time,
 *  so a repeated veto never drowns the dramatic BENCH event. */
function collapse(events: RiskEventView[]): Array<RiskEventView & { count: number }> {
  const out: Array<RiskEventView & { count: number }> = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (prev && prev.type === e.type && prev.detail === e.detail) {
      prev.count += 1;
      if (e.ts > prev.ts) prev.ts = e.ts; // keep the most recent timestamp
    } else {
      out.push({ ...e, count: 1 });
    }
  }
  return out;
}

export default function EventLog({ events }: { events: RiskEventView[] }) {
  if (!events || events.length === 0) {
    return (
      <div className="flex h-[120px] items-center justify-center text-sm text-neutral-600">
        No risk events yet — the Risk Marshal is watching.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {collapse(events).map((e) => {
        const bench = e.type === "BENCH";
        const veto = e.type === "VETO";
        const cls = bench
          ? "border-red-500/50 bg-red-500/10 text-red-200"
          : veto
            ? "border-amber-500/30 bg-amber-500/5 text-amber-200"
            : "border-neutral-800 bg-neutral-900/40 text-neutral-300";
        return (
          <li key={e.id} className={`rounded-lg border px-3 py-2 text-sm ${cls}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold tracking-wide">
                {bench ? "⛔ BENCH" : veto ? "⚠ VETO" : e.type}
                {e.count > 1 && (
                  <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium tabular">
                    × {e.count}
                  </span>
                )}
              </span>
              <span className="text-[11px] text-neutral-500 tabular">
                {new Date(e.ts).toLocaleTimeString()}
              </span>
            </div>
            <p className="mt-0.5 leading-snug">{e.detail}</p>
          </li>
        );
      })}
    </ul>
  );
}
