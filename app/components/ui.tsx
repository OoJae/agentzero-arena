"use client";

/** Small shared UI atoms for the redesigned dashboard. */
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

/** Reveal children on scroll into view. */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Section heading: small mono kicker + oversized display title. */
export function SectionHead({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="mb-6">
      <span className="font-mono text-[10px] uppercase tracking-[0.35em] text-fg-faint">{kicker}</span>
      <h2 className="font-display text-huge mt-1 uppercase leading-none">{title}</h2>
    </div>
  );
}

/**
 * A number that smoothly counts toward its target and flashes up/green or down/red
 * on change. Renders with mono tabular figures so it doesn't jitter.
 */
export function AnimatedNumber({
  value,
  format,
  className = "",
  flash = true,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
  flash?: boolean;
}) {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const from = prev.current;
    const to = value;
    if (from === to) return;
    if (flash) {
      setDir(to > from ? "up" : "down");
      const t = setTimeout(() => setDir(null), 600);
      // animate value
      const start = performance.now();
      const dur = 500;
      const step = (now: number) => {
        const p = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        setDisplay(from + (to - from) * eased);
        if (p < 1) raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
      prev.current = to;
      return () => {
        clearTimeout(t);
        if (raf.current) cancelAnimationFrame(raf.current);
      };
    } else {
      setDisplay(to);
      prev.current = to;
    }
  }, [value, flash]);

  return (
    <span
      className={`tabular ${dir === "up" ? "flash-up" : dir === "down" ? "flash-down" : ""} ${className}`}
    >
      {format(display)}
    </span>
  );
}
