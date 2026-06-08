"use client";

/**
 * Hero — fullscreen cinematic landing. Oversized wordmark, one-line thesis, live status
 * chips, and the Three.js centerpiece (dynamically loaded, ssr:false). The 3D render
 * loop is gated by an IntersectionObserver so it stops when scrolled past (VPS-friendly),
 * and falls back to a CSS gradient orb when WebGL is unavailable / reduced-motion.
 */
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import type { SceneMood } from "./ArenaScene";

const ArenaScene = dynamic(() => import("./ArenaScene"), {
  ssr: false,
  loading: () => <OrbFallback />,
});

function OrbFallback() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div
        className="h-[42vmin] w-[42vmin] rounded-full blur-2xl"
        style={{ background: "radial-gradient(circle at 40% 35%, rgba(124,92,255,0.55), rgba(34,211,238,0.18) 55%, transparent 72%)" }}
      />
    </div>
  );
}

function useWebGL(): boolean {
  const [ok, setOk] = useState(true);
  useEffect(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setOk(Boolean(gl) && !reduced);
    } catch {
      setOk(false);
    }
  }, []);
  return ok;
}

export default function Hero({
  mood = "default",
  energy = 0.4,
  connected,
  auditVerified,
  anyBenched,
  onScrollToArena,
}: {
  mood?: SceneMood;
  energy?: number;
  connected: boolean;
  auditVerified: boolean | null;
  anyBenched: boolean;
  onScrollToArena: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [active, setActive] = useState(true);
  const webgl = useWebGL();

  // Pause the WebGL loop when the hero scrolls out of view.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setActive(e!.isIntersecting), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <section ref={ref} className="relative flex h-screen w-full flex-col overflow-hidden">
      {/* 3D / fallback layer */}
      <div className="absolute inset-0 z-0">
        {webgl ? <ArenaScene mood={mood} energy={energy} active={active} /> : <OrbFallback />}
      </div>

      {/* gradient vignette to seat the type over the 3D */}
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{ background: "radial-gradient(120% 80% at 50% 30%, transparent 40%, rgba(6,7,10,0.55) 78%, var(--bg) 100%)" }}
      />

      {/* top bar */}
      <div className="relative z-10 flex items-center justify-between px-6 pt-6 sm:px-10">
        <span className="font-mono text-[11px] uppercase tracking-[0.3em] text-fg-dim">Kraken CLI · Agent Zero</span>
        <div className="flex items-center gap-2">
          <Chip tone={connected ? "live" : "dim"} pulse={connected}>
            {connected ? "LIVE" : "connecting"}
          </Chip>
          {auditVerified != null && (
            <Chip tone={auditVerified ? "up" : "down"}>{auditVerified ? "audit ✓" : "audit ✗"}</Chip>
          )}
          {anyBenched && <Chip tone="down">⛔ kill-switch</Chip>}
        </div>
      </div>

      {/* center wordmark */}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 24, filter: "blur(8px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
          className="font-display text-mega uppercase leading-[0.86]"
        >
          AgentZero
          <br />
          <span style={{ color: "var(--accent)" }}>Arena</span>
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="mt-6 max-w-xl text-balance text-sm leading-relaxed text-fg-dim sm:text-base"
        >
          Four autonomous AI agents trade capital-isolated portfolios on{" "}
          <span className="text-fg">live Kraken prices</span>. A Risk Marshal enforces the rules in real
          time — the winner trades real money.
        </motion.p>
      </div>

      {/* scroll cue */}
      <div className="relative z-10 flex justify-center pb-8">
        <button
          onClick={onScrollToArena}
          className="group flex flex-col items-center gap-2 text-fg-faint transition hover:text-fg"
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.3em]">enter the arena</span>
          <span className="scroll-cue text-lg">↓</span>
        </button>
      </div>
    </section>
  );
}

function Chip({
  children,
  tone,
  pulse,
}: {
  children: React.ReactNode;
  tone: "live" | "up" | "down" | "dim";
  pulse?: boolean;
}) {
  const colors: Record<string, string> = {
    live: "var(--live)",
    up: "var(--up)",
    down: "var(--down)",
    dim: "var(--fg-faint)",
  };
  const c = colors[tone]!;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider"
      style={{ borderColor: `color-mix(in srgb, ${c} 35%, transparent)`, color: c, background: `color-mix(in srgb, ${c} 10%, transparent)` }}
    >
      {pulse && <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: c }} />}
      {children}
    </span>
  );
}
