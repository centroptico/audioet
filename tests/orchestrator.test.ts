import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTranscription } from "../lib/orchestrator";
import { TranscribeRequestError } from "../lib/retry";
import type { EncodeResult } from "../lib/types";

const mp3 = (size: number): EncodeResult => ({
  bytes: new Uint8Array(size),
  format: "mp3",
  bitrate: "32k",
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runTranscription", () => {
  it("encodes one slice at a time and transcribes a few at once, in order", async () => {
    let encoding = 0;
    let maxEncoding = 0;
    let inflight = 0;
    let maxInflight = 0;
    const seen: string[] = [];
    const plan = Array.from({ length: 6 }, (_, index) => ({
      index,
      start: index * 10,
      duration: 10,
    }));

    const result = await runTranscription({
      plan,
      concurrency: 3,
      sleep: async () => undefined,
      encode: async ({ start }) => {
        encoding += 1;
        maxEncoding = Math.max(maxEncoding, encoding);
        await sleep(8);
        encoding -= 1;
        const bytes = new Uint8Array(8);
        bytes[0] = start / 10;
        return { bytes, format: "mp3", bitrate: "32k" };
      },
      transcribe: async ({ bytes }) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        const index = bytes[0] ?? 0;
        await sleep(index === 0 ? 40 : 12);
        inflight -= 1;
        return `bloque ${index} alfa beta gamma delta epsilon`;
      },
      onProgress: (snapshot) => {
        if (snapshot.orderedText) seen.push(snapshot.orderedText);
      },
    });

    assert.equal(maxEncoding, 1);
    assert.ok(maxInflight >= 2 && maxInflight <= 3);
    assert.equal(result.doneCount, 6);
    for (const text of seen) assert.match(text, /^bloque 0 /);
    assert.match(result.orderedText, /bloque 0 [\s\S]*bloque 5/);
  });

  it("retries rate limits with backoff and surfaces fatal upstream errors", async () => {
    const waits: number[] = [];
    let calls = 0;
    const retry = await runTranscription({
      plan: [{ index: 0, start: 0, duration: 10 }],
      sleep: async (ms) => {
        waits.push(ms);
      },
      encode: async () => mp3(4),
      transcribe: async () => {
        calls += 1;
        if (calls < 3) throw new TranscribeRequestError("Rate limit exceeded", 429);
        return "hola esto ya funciona bien";
      },
    });
    assert.deepEqual(waits, [1000, 2000]);
    assert.equal(retry.chunks[0]?.status, "done");
    assert.equal(retry.orderedText, "hola esto ya funciona bien");

    let fatalCalls = 0;
    const fatal = await runTranscription({
      plan: [{ index: 0, start: 0, duration: 10 }],
      sleep: async () => undefined,
      encode: async () => mp3(4),
      transcribe: async () => {
        fatalCalls += 1;
        throw new TranscribeRequestError("Invalid request parameters", 400);
      },
    });
    assert.equal(fatalCalls, 1);
    assert.equal(fatal.chunks[0]?.status, "error");
    assert.match(fatal.chunks[0]?.error ?? "", /Invalid request parameters/);
  });

  it("splits a slice that times out and dedups the halves", async () => {
    const ranges: number[] = [];
    let uploads = 0;
    const result = await runTranscription({
      plan: [{ index: 0, start: 0, duration: 80 }],
      maxChunkBytes: 10_000_000,
      sleep: async () => undefined,
      encode: async ({ duration }) => {
        ranges.push(duration);
        return mp3(Math.ceil(duration));
      },
      transcribe: async ({ bytes }) => {
        uploads += 1;
        if (bytes.byteLength > 50) {
          throw new TranscribeRequestError("The operation was aborted due to timeout", 504);
        }
        return bytes.byteLength > 42
          ? "uno dos tres cuatro cinco seis"
          : "tres cuatro cinco seis siete ocho";
      },
    });

    assert.deepEqual(ranges, [80, 45, 40]);
    assert.equal(uploads, 4);
    assert.equal(result.chunks[0]?.status, "done");
    assert.equal(result.orderedText, "uno dos tres cuatro cinco seis siete ocho");
  });

  it("cuts an oversized file before uploading it", async () => {
    let uploads = 0;
    const result = await runTranscription({
      plan: [{ index: 0, start: 10, duration: 80 }],
      maxChunkBytes: 50,
      sleep: async () => undefined,
      encode: async ({ duration }) => mp3(duration > 50 ? 1000 : 10),
      transcribe: async () => {
        uploads += 1;
        return "lado izquierdo alfa beta gamma y lado derecho alfa beta";
      },
    });
    assert.equal(uploads, 2);
    assert.equal(result.doneCount, 1);
    assert.match(result.orderedText, /lado izquierdo/);
  });

  it("skips slices that were already saved and stops when aborted", async () => {
    const starts: number[] = [];
    const resumed = await runTranscription({
      plan: [
        { index: 0, start: 0, duration: 10 },
        { index: 1, start: 5, duration: 10 },
      ],
      initial: [{ index: 0, status: "done", text: "ya estaba listo este texto" }],
      sleep: async () => undefined,
      encode: async ({ start }) => {
        starts.push(start);
        return mp3(4);
      },
      transcribe: async () => "sigue el relato con más detalle",
    });
    assert.deepEqual(starts, [5]);
    assert.match(resumed.orderedText, /^ya estaba listo este texto/);

    const controller = new AbortController();
    const aborted = await runTranscription({
      plan: [
        { index: 0, start: 0, duration: 10 },
        { index: 1, start: 5, duration: 10 },
      ],
      concurrency: 1,
      signal: controller.signal,
      sleep: async () => undefined,
      encode: async () => mp3(4),
      transcribe: async () => {
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    });
    assert.notEqual(aborted.chunks[0]?.status, "error");
    assert.notEqual(aborted.chunks[0]?.status, "done");
    assert.equal(aborted.chunks[1]?.status, "pending");
  });

  it("sums the cost of every call, including a failed one and a later success", async () => {
    let calls = 0;
    const result = await runTranscription({
      plan: [{ index: 0, start: 0, duration: 10 }],
      initialUsage: { cost: 0.01, seconds: 60, costKnown: true },
      sleep: async () => undefined,
      encode: async () => mp3(4),
      transcribe: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TranscribeRequestError("rate", 429, undefined, { cost: 0.001, seconds: 2, costKnown: true });
        }
        return { text: "hola esto ya funciona bien", cost: 0.002, seconds: 8, costKnown: true };
      },
    });
    assert.equal(result.chunks[0]?.status, "done");
    assert.equal(result.costUsd, 0.013);
    assert.equal(result.billedSeconds, 70);
    assert.equal(result.costKnown, true);

    const unknown = await runTranscription({
      plan: [{ index: 0, start: 0, duration: 10 }],
      sleep: async () => undefined,
      encode: async () => mp3(4),
      transcribe: async () => ({ text: "texto sin costo en la respuesta", seconds: 5 }),
    });
    assert.equal(unknown.costUsd, 0);
    assert.equal(unknown.billedSeconds, 5);
    assert.equal(unknown.costKnown, false);

    const bareRetry = await runTranscription({
      plan: [{ index: 0, start: 0, duration: 10 }],
      sleep: async () => undefined,
      encode: async () => mp3(4),
      transcribe: async () => {
        throw new TranscribeRequestError("sin costo", 400);
      },
    });
    assert.equal(bareRetry.costUsd, 0);
    assert.equal(bareRetry.costKnown, true);
  });
});
