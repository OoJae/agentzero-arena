"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentSnapshot, ArenaState } from "@/lib/types";
import EquityChart, { STRATEGY_COLOR } from "./EquityChart";
import EventLog from "./EventLog";
import ValidationPanel from "./ValidationPanel";
import FinalePanel from "./FinalePanel";
import Hero from "./Hero";
import StatusBar from "./StatusBar";
import type { SceneMood } from "./ArenaScene";
import { AnimatedNumber, Reveal, SectionHead } from "./ui";

type Tab = "arena" | "validation";

const STRATEGY_LABEL: Record<string, string> = {
  momentum: "Momentum",
  "mean-reversion": "Mean-Reversion",
  "funding-carry": "Funding-Carry",
  "macro-hedge": "Macro-Hedge",
  sentiment: "Sentiment",
};

function StatusBadge({ status }: { status: AgentSnapshot["status"] }) {
  const c: Record<string, string> = {
    ACTIVE: "var(--up)",
    BENCHED: "var(--down)",
    LIVE: "var(--live)",
  };
  const color = c[status] ?? c.ACTIVE;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-wider"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 30%, transparent)` }}
    >
      {status === "BENCHED" && "⛔ "}
      {status === "LIVE" && "● "}
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
      <StatusBar
        connected={connected}
        auditVerified={state?.auditVerified ?? null}
        anyBenched={anyBenched}
        leaderName={leader?.name ?? null}
      />
      <Hero
        mood={mood}
        energy={energy}
        connected={connected}
        auditVerified={state?.auditVerified ?? null}
        anyBenched={anyBenched}
        onScrollToArena={scrollToArena}
      />

    <main ref={dashRef} className="relative z-[2] mx-auto max-w-6xl px-5 py-16 sm:px-8">
      {/* tab switch */}
      <div className="mb-10 flex items-center justify-between gap-4">
        <div className="inline-flex gap-1 rounded-full border border-line bg-bg-elev/60 p-1 font-mono text-xs">
          {(["arena", "validation"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-4 py-1.5 uppercase tracking-wider transition ${
                tab === t ? "bg-accent text-white" : "text-fg-dim hover:text-fg"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="hidden font-mono text-[10px] uppercase tracking-[0.3em] text-fg-faint sm:block">
          paper mode · no real money
        </span>
      </div>

      {finaleActive && finale && (
        <Reveal className="mb-12">
          <FinalePanel finale={finale} />
        </Reveal>
      )}

      {tab === "validation" ? (
        <Reveal>
          <SectionHead kicker="rigor · out-of-sample" title="Validation" />
          <ValidationPanel validation={state?.validation ?? []} />
        </Reveal>
      ) : (
        <>
          {/* ── Leaderboard ───────────────────────────────────────────── */}
          <Reveal className="mb-16">
            <SectionHead kicker="live · capital-isolated" title="Leaderboard" />
            <Leaderboard agents={agents} />
          </Reveal>

          {/* ── Risk Marshal event log ────────────────────────────────── */}
          {agents.length > 0 && (
            <Reveal className="mb-16">
              <SectionHead kicker="supervisor · real-time" title="Risk Marshal" />
              <div className="rounded-2xl border border-line bg-bg-elev/50 p-4">
                <EventLog events={state?.events ?? []} />
              </div>
            </Reveal>
          )}

          {/* ── Equity curves ─────────────────────────────────────────── */}
          {agents.length > 0 && (
            <Reveal className="mb-16">
              <SectionHead kicker="performance · live" title="Equity Curves" />
              <div className="rounded-2xl border border-line bg-bg-elev/50 p-5">
                <EquityChart series={state?.equitySeries ?? []} agents={agents} />
              </div>
            </Reveal>
          )}

          {/* ── Agent thinking ────────────────────────────────────────── */}
          {leader && (
            <Reveal className="mb-8">
              <SectionHead kicker="reasoning · grounded in features" title="Agent Thinking" />
              <div className="grid gap-4 md:grid-cols-2">
                {agents.map((a) => (
                  <ThoughtCard key={a.id} agent={a} />
                ))}
              </div>
            </Reveal>
          )}
        </>
      )}

      <footer className="mt-16 border-t border-line pt-8 text-center font-mono text-[11px] uppercase tracking-[0.25em] text-fg-faint">
        Paper mode · the live finale runs behind <span className="text-fg-dim">--validate</span> + the dead-man&apos;s switch
      </footer>
    </main>
    </>
  );
}

/* ── Leaderboard ─────────────────────────────────────────────────────────── */
function Leaderboard({ agents }: { agents: AgentSnapshot[] }) {
  if (agents.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-bg-elev/50 p-12 text-center font-mono text-sm text-fg-faint">
        Waiting for the arena worker…
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {agents.map((a, i) => {
        const up = a.pnlPct >= 0;
        const accent = STRATEGY_COLOR[a.strategy] ?? "#6b7280";
        const leader = i === 0;
        return (
          <div
            key={a.id}
            className={`group relative grid grid-cols-[auto_1fr_auto] items-center gap-4 overflow-hidden rounded-2xl border px-5 py-4 transition sm:grid-cols-[auto_1.4fr_1fr_1fr_0.8fr_auto] ${
              a.status === "BENCHED"
                ? "border-down/40 bg-down/[0.06]"
                : leader
                  ? "border-line-strong bg-bg-elev"
                  : "border-line bg-bg-elev/50 hover:bg-bg-elev"
            }`}
          >
            {/* accent rail */}
            <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: accent }} />

            {/* rank */}
            <div className="flex items-center gap-3 pl-2">
              <span className={`font-display text-3xl leading-none ${leader ? "text-fg" : "text-fg-faint"}`}>
                {i + 1}
              </span>
            </div>

            {/* name + strategy */}
            <div className="min-w-0">
              <div className="truncate text-base font-semibold sm:text-lg">{a.name}</div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
                {STRATEGY_LABEL[a.strategy] ?? a.strategy}
              </div>
            </div>

            {/* equity (oversized) */}
            <div className="text-right">
              <AnimatedNumber
                value={a.equity}
                format={money}
                className={`font-display text-xl tracking-tight sm:text-2xl ${leader ? "text-fg" : "text-fg"}`}
              />
              <div className="font-mono text-[9px] uppercase tracking-wider text-fg-faint">equity</div>
            </div>

            {/* pnl */}
            <div className="hidden text-right sm:block" style={{ color: up ? "var(--up)" : "var(--down)" }}>
              <AnimatedNumber value={a.pnlPct} format={pct} className="text-lg font-semibold" flash={false} />
              <div className="font-mono text-[9px] uppercase tracking-wider text-fg-faint">
                pnl · dd {pct(a.drawdownPct)}
              </div>
            </div>

            {/* trades */}
            <div className="hidden text-right font-mono text-sm text-fg-dim sm:block">
              {a.trades}
              <div className="text-[9px] uppercase tracking-wider text-fg-faint">trades</div>
            </div>

            {/* status */}
            <div className="text-right">
              <StatusBadge status={a.status} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ThoughtCard({ agent: a }: { agent: AgentSnapshot }) {
  const accent = STRATEGY_COLOR[a.strategy] ?? "#6b7280";
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-bg-elev/50 p-5">
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: accent }} />
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold">{a.name}</span>
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider"
          style={{ color: accent, background: `color-mix(in srgb, ${accent} 12%, transparent)` }}
        >
          {a.lastAction ?? "—"}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-fg-dim">{a.lastRationale ?? "Awaiting first decision…"}</p>
    </div>
  );
}
