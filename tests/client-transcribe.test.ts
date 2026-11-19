import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { postChunk } from "../lib/client-transcribe";
import { TranscribeRequestError } from "../lib/retry";
import { DEFAULT_JOB } from "../lib/transcript-job";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("postChunk", () => {
  it("returns text, cost and seconds from the route", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ text: "hola", cost: 0.000398, seconds: 14.328, costKnown: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const result = await postChunk(new Uint8Array([1, 2, 3]), "mp3", new AbortController().signal, DEFAULT_JOB);
    assert.deepEqual(result, {
      text: "hola",
      cost: 0.000398,
      seconds: 14.328,
      costKnown: true,
      words: [],
      segments: [],
    });
  });

  it("treats a missing cost as unknown and keeps a cost reported on failure", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ text: "sin precio" }), { status: 200 });
    const missing = await postChunk(new Uint8Array([1]), "mp3", new AbortController().signal, DEFAULT_JOB);
    assert.equal(missing.cost, 0);
    assert.equal(missing.costKnown, false);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "OpenRouter: rate", cost: 0.002, seconds: 3, costKnown: true }), {
        status: 429,
      });
    await assert.rejects(
      () => postChunk(new Uint8Array([1]), "mp3", new AbortController().signal, DEFAULT_JOB),
      (error: unknown) => {
        assert.ok(error instanceof TranscribeRequestError);
        assert.equal(error.status, 429);
        assert.deepEqual(error.usage, { cost: 0.002, seconds: 3, costKnown: true });
        return true;
      },
    );
  });
});
