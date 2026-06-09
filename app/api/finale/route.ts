/**
 * app/api/finale/route.ts — trigger a finale REHEARSAL from the dashboard button.
 *
 * SAFETY: this endpoint is REHEARSAL-ONLY. It drops a `data/finale-trigger.json` file
 * that the worker polls; the worker runs `runFinale(live:false)` — which simulates the
 * fill and never places a real order. A REAL fill is impossible here: it requires the
 * triple gate (`--live` flag + `ARENA_FINALE_ARMED=YES` + funded creds) via the CLI on a
 * trusted machine. The Next app is also read-only over the DB — we only write the trigger
 * file, keeping the worker the sole DB writer.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const runtime = "nodejs";

const MAX_NOTIONAL_USD = 50;

export async function POST(req: Request) {
  let notionalUsd = 20;
  let asset = "BTCUSD";
  try {
    const body = (await req.json()) as { notionalUsd?: number; asset?: string };
    if (typeof body.notionalUsd === "number" && Number.isFinite(body.notionalUsd)) {
      notionalUsd = Math.min(Math.max(1, body.notionalUsd), MAX_NOTIONAL_USD);
    }
    if (typeof body.asset === "string" && /^[A-Z]{3,8}$/.test(body.asset)) asset = body.asset;
  } catch {
    /* no/invalid body — use defaults */
  }

  const dataDir = process.env.ARENA_DATA_DIR ?? "./data";
  try {
    mkdirSync(dataDir, { recursive: true });
    // live is intentionally NOT part of this payload — the worker forces rehearsal.
    writeFileSync(
      resolve(dataDir, "finale-trigger.json"),
      JSON.stringify({ notionalUsd, asset, ts: Date.now() }),
    );
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }

  return Response.json({ ok: true, mode: "rehearsal", notionalUsd, asset });
}
