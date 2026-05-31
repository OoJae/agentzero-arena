import { describe, expect, it } from "vitest";
import { interpretResult, mapCategory, KrakenError, type RawResult } from "./kraken.js";

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
