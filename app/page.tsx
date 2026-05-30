/**
 * Phase 0: an intentionally empty dashboard shell. The live leaderboard, thought
 * feed, and event log are wired up in Phase 1 (app/components/*) over the SSE
 * endpoint at /api/stream.
 */
export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header className="mb-10">
        <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">
          Kraken CLI · Agent Zero
        </p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">
          AgentZero <span className="text-emerald-400">Arena</span>
        </h1>
        <p className="mt-3 max-w-2xl text-neutral-400">
          The Kraken CLI as the execution substrate for an economy of competing
          agents — four strategy-specialized AI traders racing in capital-isolated
          portfolios, supervised by a Risk Marshal enforcing safety in real time.
        </p>
      </header>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-8">
        <div className="flex items-center gap-3">
          <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-amber-400" />
          <span className="text-sm text-neutral-300">
            Phase 0 — foundations online. Leaderboard arrives in Phase 1.
          </span>
        </div>
      </section>
    </main>
  );
}
