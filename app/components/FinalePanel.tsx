"use client";

import type { FinaleState } from "@/lib/types";

function money(n: number): string {
  return `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export default function FinalePanel({ finale }: { finale: FinaleState }) {
  const live = finale.live;
  const armed = finale.cancelAfterArmed;
  const accent = live ? "var(--live)" : "var(--up)";
  return (
    <section
      className="relative overflow-hidden rounded-3xl border p-6 sm:p-8"
      style={{ borderColor: `color-mix(in srgb, ${accent} 45%, transparent)`, background: `color-mix(in srgb, ${accent} 5%, var(--bg-elev))` }}
    >
      {/* glow */}
      <div
        className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full blur-3xl"
        style={{ background: `color-mix(in srgb, ${accent} 22%, transparent)` }}
      />

      <div className="relative mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <span className="font-mono text-[10px] uppercase tracking-[0.35em]" style={{ color: accent }}>
            {live ? "live finale · real money" : "finale rehearsal · no funds"}
          </span>
          <h3 className="font-display text-huge mt-1 uppercase leading-none">
            {finale.leader ?? "resolving…"}
            <span className="ml-3 align-middle text-base font-normal text-fg-dim">→ LIVE</span>
          </h3>
        </div>
        {armed && finale.secondsRemaining != null && (
          <div className="text-right">
            <div className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">dead-man&apos;s switch</div>
            <div
              className="font-display text-5xl tabular leading-none"
              style={{ color: finale.secondsRemaining <= 15 ? "var(--down)" : accent }}
            >
              {String(finale.secondsRemaining).padStart(2, "0")}
              <span className="text-2xl">s</span>
            </div>
          </div>
        )}
      </div>

      <div className="relative grid gap-3 sm:grid-cols-4">
        <Cell label="phase" value={finale.phase} />
        <Cell
          label="--validate"
          value={finale.validateAccepted === true ? "✓ accepted" : finale.validateAccepted === false ? "✗ rejected" : "— rehearsal"}
          accent={finale.validateAccepted === true ? "var(--up)" : undefined}
        />
        <Cell label="order" value={finale.fill ? `${finale.fill.size} ${finale.asset}` : `~$${finale.notionalUsd} ${finale.asset}`} />
        <Cell label="fill price" value={finale.fill ? `$${finale.fill.price.toFixed(2)}` : "—"} />
        <Cell label="fee" value={finale.fill ? `$${finale.fill.fee.toFixed(4)}` : "—"} />
        <Cell label="balance Δ" value={finale.balanceDelta != null ? money(finale.balanceDelta) : "—"} />
        <Cell label="kill-switch" value={armed ? "armed" : "off"} accent={armed ? accent : undefined} />
        <Cell label="mode" value={live ? "REAL crypto spot" : "no funds touched"} />
      </div>

      <p className="relative mt-5 text-sm text-fg-dim">{finale.message}</p>
    </section>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg/40 px-4 py-3">
      <div className="font-mono text-[9px] uppercase tracking-wider text-fg-faint">{label}</div>
      <div className="mt-1 truncate font-mono text-sm tabular" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
    </div>
  );
}
