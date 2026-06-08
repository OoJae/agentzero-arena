"use client";

/** Sticky mini status bar that fades in once the hero is scrolled past, so the
 *  LIVE / audit / kill-switch state stays glanceable while viewing the dashboard. */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

export default function StatusBar({
  connected,
  auditVerified,
  anyBenched,
  leaderName,
}: {
  connected: boolean;
  auditVerified: boolean | null;
  anyBenched: boolean;
  leaderName: string | null;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > window.innerHeight * 0.85);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ y: -48, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -48, opacity: 0 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-x-0 top-0 z-50 border-b border-line bg-bg/80 backdrop-blur-md"
        >
          <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-2.5 sm:px-8">
            <span className="font-display text-sm uppercase tracking-tight">
              AgentZero <span style={{ color: "var(--accent)" }}>Arena</span>
            </span>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
              {leaderName && <span className="hidden text-fg-dim sm:inline">leader · {leaderName}</span>}
              <Chip tone={connected ? "live" : "dim"} pulse={connected}>
                {connected ? "LIVE" : "off"}
              </Chip>
              {auditVerified != null && (
                <Chip tone={auditVerified ? "up" : "down"}>{auditVerified ? "audit ✓" : "audit ✗"}</Chip>
              )}
              {anyBenched && <Chip tone="down">⛔</Chip>}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Chip({ children, tone, pulse }: { children: React.ReactNode; tone: "live" | "up" | "down" | "dim"; pulse?: boolean }) {
  const colors: Record<string, string> = { live: "var(--live)", up: "var(--up)", down: "var(--down)", dim: "var(--fg-faint)" };
  const c = colors[tone]!;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5"
      style={{ color: c, background: `color-mix(in srgb, ${c} 10%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${c} 30%, transparent)` }}
    >
      {pulse && <span className="h-1 w-1 animate-pulse rounded-full" style={{ background: c }} />}
      {children}
    </span>
  );
}
