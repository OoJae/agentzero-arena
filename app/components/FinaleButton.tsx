"use client";

/**
 * FinaleButton — triggers a finale REHEARSAL from the dashboard (POST /api/finale).
 * Rehearsal-only by design: no real money can move from the web. The countdown + result
 * render via the existing SSE → FinalePanel. Disabled while a finale is already active.
 */
import { useState } from "react";

export default function FinaleButton({ active }: { active: boolean }) {
  const [pending, setPending] = useState(false);
  const disabled = active || pending;

  async function trigger() {
    if (disabled) return;
    setPending(true);
    try {
      await fetch("/api/finale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notionalUsd: 20, asset: "BTCUSD" }),
      });
    } catch {
      /* SSE will reflect the result; ignore network blips */
    } finally {
      // brief "triggered" feedback; the worker picks it up within a snapshot tick
      setTimeout(() => setPending(false), 2500);
    }
  }

  return (
    <button
      onClick={trigger}
      disabled={disabled}
      title="Promote the current leader to a tiny BTC order — rehearsal (no real money)"
      className="group inline-flex items-center gap-2 rounded-full border px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        borderColor: "color-mix(in srgb, var(--up) 40%, transparent)",
        color: "var(--up)",
        background: "color-mix(in srgb, var(--up) 8%, transparent)",
      }}
    >
      <span className="text-xs leading-none">▶</span>
      {active ? "finale running…" : pending ? "triggered…" : "run finale"}
      <span className="text-fg-faint">· rehearsal</span>
    </button>
  );
}
