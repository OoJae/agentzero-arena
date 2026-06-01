"use client";

import type { FinaleState } from "@/lib/types";

function money(n: number): string {
  return `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export default function FinalePanel({ finale }: { finale: FinaleState }) {
  const live = finale.live;
  const armed = finale.cancelAfterArmed;
  return (
    <section
      className={`mt-6 overflow-hidden rounded-2xl border p-5 ${
        live ? "border-amber-500/50 bg-amber-500/5" : "border-emerald-500/40 bg-emerald-500/5"
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold uppercase tracking-wide">
            {live ? "🔴 Live finale" : "🟢 Finale rehearsal"}
          </span>
          <span className="text-xs text-neutral-400">· {finale.leader ?? "resolving leader…"}</span>
        </div>
        {armed && finale.secondsRemaining != null && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-neutral-400">dead-man&apos;s switch</span>
            <span
              className={`rounded-md px-2 py-1 font-mono text-lg tabular font-bold ${
                finale.secondsRemaining <= 15 ? "bg-red-500/20 text-red-300" : "bg-neutral-800 text-emerald-300"
              }`}
            >
              {String(finale.secondsRemaining).padStart(2, "0")}s
            </span>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Cell label="Phase" value={finale.phase} />
        <Cell
          label="--validate"
          value={finale.validateAccepted === true ? "✓ accepted" : finale.validateAccepted === false ? "✗ rejected" : "— rehearsal"}
        />
        <Cell label="Order" value={finale.fill ? `${finale.fill.size} ${finale.asset}` : `~$${finale.notionalUsd} ${finale.asset}`} />
        <Cell label="Fill price" value={finale.fill ? `$${finale.fill.price.toFixed(2)}` : "—"} />
        <Cell label="Fee" value={finale.fill ? `$${finale.fill.fee.toFixed(4)}` : "—"} />
        <Cell label="Balance Δ" value={finale.balanceDelta != null ? money(finale.balanceDelta) : "—"} />
        <Cell label="Kill-switch" value={armed ? "armed" : "off"} />
        <Cell label="Mode" value={live ? "REAL crypto spot" : "no funds touched"} />
      </div>

      <p className="mt-3 text-sm text-neutral-300">{finale.message}</p>
    </section>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-0.5 truncate text-sm tabular">{value}</div>
    </div>
  );
}
