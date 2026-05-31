"use client";

import type { RiskEventView } from "@/lib/types";

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
      {events.map((e) => {
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
