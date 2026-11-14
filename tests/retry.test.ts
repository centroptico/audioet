import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backoffMs, classifyStatus, parseRetryAfter } from "../lib/retry";

describe("retry policy", () => {
  it("splits timeouts and oversized uploads, retries rate limits, and stops on client errors", () => {
    assert.equal(classifyStatus(413), "split");
    assert.equal(classifyStatus(408), "split");
    assert.equal(classifyStatus(504), "split");
    assert.equal(classifyStatus(524), "split");
    assert.equal(classifyStatus(429), "retry");
    assert.equal(classifyStatus(500), "retry");
    assert.equal(classifyStatus(502), "retry");
    assert.equal(classifyStatus(503), "retry");
    assert.equal(classifyStatus(529), "retry");
    assert.equal(classifyStatus(400), "fatal");
    assert.equal(classifyStatus(401), "fatal");
    assert.equal(classifyStatus(402), "fatal");
  });

  it("backs off exponentially and caps the wait", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 8].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 16000]);
  });

  it("reads Retry-After seconds", () => {
    assert.equal(parseRetryAfter("2"), 2000);
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter("nope"), undefined);
  });
});
