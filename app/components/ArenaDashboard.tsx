"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentSnapshot, ArenaState } from "@/lib/types";
import EquityChart, { STRATEGY_COLOR } from "./EquityChart";
import EventLog from "./EventLog";
import ValidationPanel from "./ValidationPanel";
import FinalePanel from "./FinalePanel";
import Hero from "./Hero";
import type { SceneMood } from "./ArenaScene";

type Tab = "arena" | "validation";

const STRATEGY_LABEL: Record<string, string> = {
  momentum: "Momentum",
  "mean-reversion": "Mean-Reversion",
  "funding-carry": "Funding-Carry",
  "macro-hedge": "Macro-Hedge",
  sentiment: "Sentiment",
};

function StatusBadge({ status }: { status: AgentSnapshot["status"] }) {
  const styles: Record<string, string> = {
    ACTIVE: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    BENCHED: "bg-red-500/15 text-red-300 ring-red-500/30",
    LIVE: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ring-1 ${styles[status] ?? styles.ACTIVE}`}>
      {status}
    </span>
  );
}

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export default function ArenaDashboard() {
  const [state, setState] = useState<ArenaState | null>(null);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<Tab>("arena");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onmessage = (ev) => {
      try {
        setState(JSON.parse(ev.data) as ArenaState);
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  const agents = state?.agents ?? [];
  const leader = agents[0] ?? null;
  const anyBenched = agents.some((a) => a.status === "BENCHED");
  const finale = state?.finale ?? null;
  const finaleActive = finale != null && finale.phase !== "idle";

  // Drive the 3D scene from live state: benched ⇒ red, live finale ⇒ amber, else violet.
  const mood: SceneMood = anyBenched ? "benched" : finaleActive ? "live" : "default";
  // "energy" = recent absolute PnL spread across agents (more movement ⇒ more distortion).
  const energy = Math.min(1, agents.reduce((m, a) => Math.max(m, Math.abs(a.pnlPct)), 0) / 8);

  const dashRef = useRef<HTMLDivElement>(null);
  const scrollToArena = () => dashRef.current?.scrollIntoView({ behavior: "smooth" });

  return (
    <>
      <Hero
        mood={mood}
        energy={energy}
        connected={connected}
        auditVerified={state?.auditVerified ?? null}
        anyBenched={anyBenched}
        onScrollToArena={scrollToArena}
      />

    <main ref={dashRef} className="mx-auto max-w-6xl px-6 py-10">
      <nav className="mb-6 flex gap-1 rounded-lg border border-neutral-800 bg-neutral-900/40 p-1 text-sm w-fit">
        {(["arena", "validation"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 capitalize transition ${
              tab === t ? "bg-neutral-700/60 text-white" : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      {finaleActive && finale && <FinalePanel finale={finale} />}

      {tab === "validation" ? (
        <div className="mt-2">
          <ValidationPanel validation={state?.validation ?? []} />
        </div>
      ) : (
      <>
      <section className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/40">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-4 py-3 font-medium">#</th>
              <th className="px-4 py-3 font-medium">Agent</th>
              <th className="px-4 py-3 font-medium">Strategy</th>
              <th className="px-4 py-3 text-right font-medium">Equity</th>
              <th className="px-4 py-3 text-right font-medium">PnL %</th>
              <th className="px-4 py-3 text-right font-medium">Max DD</th>
              <th className="px-4 py-3 text-right font-medium">Trades</th>
              <th className="px-4 py-3 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {agents.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-neutral-500">
                  Waiting for the arena worker… run <code className="rounded bg-neutral-800 px-1.5 py-0.5">pnpm dev</code>.
                </td>
              </tr>
            )}
            {agents.map((a, i) => (
              <tr key={a.id} className="border-b border-neutral-900/60 last:border-0 hover:bg-neutral-900/40">
                <td className="px-4 py-3 tabular text-neutral-500">{i + 1}</td>
                <td className="px-4 py-3 font-medium">{a.name}</td>
                <td className="px-4 py-3 text-neutral-400">{STRATEGY_LABEL[a.strategy] ?? a.strategy}</td>
                <td className="px-4 py-3 text-right tabular">{money(a.equity)}</td>
                <td className={`px-4 py-3 text-right tabular ${a.pnlPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>{pct(a.pnlPct)}</td>
                <td className="px-4 py-3 text-right tabular text-neutral-400">{pct(a.drawdownPct)}</td>
                <td className="px-4 py-3 text-right tabular text-neutral-400">{a.trades}</td>
                <td className="px-4 py-3 text-right"><StatusBadge status={a.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {agents.length > 0 && (
        <section className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
          <h2 className="mb-2 px-1 text-xs uppercase tracking-[0.15em] text-neutral-500">Risk Marshal · event log</h2>
          <EventLog events={state?.events ?? []} />
        </section>
      )}

      {agents.length > 0 && (
        <section className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
          <h2 className="mb-2 px-1 text-xs uppercase tracking-[0.15em] text-neutral-500">Equity curves</h2>
          <EquityChart series={state?.equitySeries ?? []} agents={agents} />
        </section>
      )}

      {leader && (
        <section className="mt-6">
          <h2 className="mb-3 text-xs uppercase tracking-[0.15em] text-neutral-500">Agent thinking</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {agents.map((a) => (
              <div
                key={a.id}
                className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4"
                style={{ borderLeft: `3px solid ${STRATEGY_COLOR[a.strategy] ?? "#6b7280"}` }}
              >
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm font-medium">{a.name}</span>
                  <span className="text-[11px] uppercase tracking-wide text-neutral-500">
                    {a.lastAction ?? "—"}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-neutral-300">
                  {a.lastRationale ?? "Awaiting first decision…"}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}
      </>
      )}

      <footer className="mt-8 text-center text-xs text-neutral-600">
        Paper mode · no real money. The live finale runs behind <code>--validate</code> + the dead-man&apos;s switch.
      </footer>
    </main>
    </>
  );
}
