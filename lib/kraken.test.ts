import { describe, expect, it } from "vitest";
import { interpretResult, lockPathFromMessage, mapCategory, parsePaperBalance, KrakenError, type RawResult } from "./kraken.js";

function ok(stdout: string): RawResult {
  return { stdout, stderr: "", status: 0 };
}
function fail(stdout: string, status = 1, stderr = ""): RawResult {
  return { stdout, stderr, status };
}

describe("interpretResult — exit-code & JSON contract", () => {
  it("parses JSON on exit 0", () => {
    const out = interpretResult(ok('{"current_value":10000,"mode":"paper"}'));
    expect((out as { current_value: number }).current_value).toBe(10000);
  });

  it("throws parse error when exit 0 but stdout is not JSON", () => {
    expect(() => interpretResult(ok("not json"))).toThrowError(KrakenError);
    try {
      interpretResult(ok("not json"));
    } catch (e) {
      expect((e as KrakenError).category).toBe("parse");
    }
  });

  it("returns plain text when json:false on success", () => {
    expect(interpretResult(ok("  done  "), { json: false })).toBe("done");
  });

  it("throws on non-zero exit and maps the envelope category", () => {
    try {
      interpretResult(fail('{"error":"network","message":"could not resolve","retryable":true}'));
      throw new Error("should have thrown");
    } catch (e) {
      const ke = e as KrakenError;
      expect(ke).toBeInstanceOf(KrakenError);
      expect(ke.category).toBe("network");
      expect(ke.retryable).toBe(true);
      expect(ke.exitCode).toBe(1);
    }
  });

  it("never treats a non-zero exit as success even with JSON stdout", () => {
    expect(() => interpretResult(fail('{"error":"api","message":"insufficient funds"}'))).toThrowError(KrakenError);
  });

  it("handles spawn-level failure (binary missing) as config error", () => {
    try {
      interpretResult({ stdout: "", stderr: "", status: null, spawnError: { message: "spawn kraken ENOENT" } });
    } catch (e) {
      expect((e as KrakenError).category).toBe("config");
    }
  });
});

describe("mapCategory", () => {
  it("uses the envelope error field when it is a known category", () => {
    expect(mapCategory({ error: "rate_limit", message: "" }, "")).toBe("rate_limit");
    expect(mapCategory({ error: "auth", message: "" }, "")).toBe("auth");
  });

  it("infers from message text when category is unknown", () => {
    expect(mapCategory(null, "Connection timed out")).toBe("network");
    expect(mapCategory(null, "Too Many Requests 429")).toBe("rate_limit");
    expect(mapCategory(null, "invalid signature / api key")).toBe("auth");
    expect(mapCategory(null, "unknown pair")).toBe("api");
  });
});

describe("parsePaperBalance — verified nested shape", () => {
  it("extracts `total` from the nested {available,reserved,total} envelope", () => {
    const raw = {
      balances: {
        BTC: { available: 0.14214497, reserved: 0.0, total: 0.14214497 },
        USD: { available: 114.9934, reserved: 0.0, total: 114.9934 },
      },
      mode: "paper",
    };
    const out = parsePaperBalance(raw);
    expect(out.BTC).toBeCloseTo(0.14214497, 6);
    expect(out.USD).toBeCloseTo(114.9934, 4);
    expect(Object.keys(out).sort()).toEqual(["BTC", "USD"]);
  });

  it("does not return {} for the real shape (the bug that hid positions)", () => {
    const out = parsePaperBalance({ balances: { ETH: { total: 2.5 }, USD: { total: 9000 } } });
    expect(Object.keys(out).length).toBe(2);
    expect(out.ETH).toBe(2.5);
  });

  it("tolerates plain-number values and {ASSET:qty} without a balances wrapper", () => {
    expect(parsePaperBalance({ BTC: 0.5, USD: 100, mode: "paper" })).toEqual({ BTC: 0.5, USD: 100 });
  });

  it("tolerates an array of {asset, amount}", () => {
    const out = parsePaperBalance([{ asset: "SOL", amount: 12 }, { asset: "USD", amount: 50 }]);
    expect(out).toEqual({ SOL: 12, USD: 50 });
  });

  it("returns {} for junk", () => {
    expect(parsePaperBalance(null)).toEqual({});
    expect(parsePaperBalance("nope")).toEqual({});
  });
});

describe("lockPathFromMessage — self-heal stuck futures lock", () => {
  it("extracts the quoted .lock path from the CLI error", () => {
    const msg = "Validation error: Futures paper state is locked by another process. Try again shortly. If a previous command crashed, remove '/root/agentzero-arena/data/agents/macro-hedge/home/.config/kraken/paper/futures_state.json.lock'.";
    expect(lockPathFromMessage(msg)).toBe("/root/agentzero-arena/data/agents/macro-hedge/home/.config/kraken/paper/futures_state.json.lock");
  });
  it("falls back to an unquoted .lock path", () => {
    expect(lockPathFromMessage("locked: /tmp/x/paper/state.json.lock now")).toBe("/tmp/x/paper/state.json.lock");
  });
  it("returns null when there is no lock path", () => {
    expect(lockPathFromMessage("some other error")).toBeNull();
  });
});
