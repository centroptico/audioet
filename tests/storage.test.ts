import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLAN_VERSION } from "../lib/config";
import {
  clearTranscript,
  fileKeyOf,
  loadTranscript,
  persistableChunks,
  samePlan,
  saveTranscript,
  STORAGE_KEY,
  type KeyValueStore,
  type PersistedTranscript,
} from "../lib/storage";
import type { ChunkRecord } from "../lib/types";

function memoryStore(): KeyValueStore & { dump: () => Map<string, string> } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    dump: () => values,
  };
}

function sample(): PersistedTranscript {
  return {
    version: 1,
    planVersion: PLAN_VERSION,
    chunkSeconds: 600,
    overlapSeconds: 5,
    fileKey: "nota.m4a:10:20",
    fileName: "nota.m4a",
    fileSize: 10,
    durationSec: 30,
    editedText: null,
    costUsd: 0.0123,
    billedSeconds: 90.5,
    costKnown: true,
    chunks: [{ index: 0, start: 0, duration: 30, status: "done", text: "hola" }],
    updatedAt: 1,
  };
}

describe("storage", () => {
  it("round-trips the transcript and ignores corrupt payloads", () => {
    const store = memoryStore();
    assert.equal(loadTranscript(store), null);
    assert.equal(saveTranscript(store, sample()), true);
    assert.equal(loadTranscript(store)?.chunks[0]?.text, "hola");
    assert.equal(loadTranscript(store)?.costUsd, 0.0123);
    assert.equal(loadTranscript(store)?.billedSeconds, 90.5);
    assert.equal(loadTranscript(store)?.costKnown, true);
    const { costUsd: _cost, billedSeconds: _seconds, costKnown: _known, ...legacy } = sample();
    void _cost;
    void _seconds;
    void _known;
    store.setItem(STORAGE_KEY, JSON.stringify(legacy));
    const old = loadTranscript(store);
    assert.equal(old?.costUsd, 0);
    assert.equal(old?.billedSeconds, 0);
    assert.equal(old?.costKnown, false);
    assert.equal(old?.chunks[0]?.text, "hola");
    store.setItem(STORAGE_KEY, "{");
    assert.equal(loadTranscript(store), null);
    store.setItem(STORAGE_KEY, JSON.stringify({ version: 2 }));
    assert.equal(loadTranscript(store), null);
  });

  it("survives a full localStorage", () => {
    const store: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    assert.equal(saveTranscript(store, sample()), false);
  });

  it("clears the saved key and only resumes a matching plan", () => {
    const store = memoryStore();
    saveTranscript(store, sample());
    clearTranscript(store);
    assert.equal(store.dump().has(STORAGE_KEY), false);
    assert.equal(samePlan(sample()), true);
    assert.equal(samePlan({ ...sample(), planVersion: 99 }), false);
    assert.equal(fileKeyOf({ name: "a.m4a", size: 3, lastModified: 4 }), "a.m4a:3:4");
  });

  it("does not persist in-flight audio, only finished text", () => {
    const chunks: ChunkRecord[] = [
      { index: 0, start: 0, duration: 10, status: "done", text: "listo" },
      { index: 1, start: 5, duration: 10, status: "transcribing", text: "" },
      { index: 2, start: 10, duration: 10, status: "error", text: "", error: "falló" },
    ];
    const stored = persistableChunks(chunks);
    assert.equal(stored[1]?.status, "pending");
    assert.equal(stored[1]?.text, "");
    assert.equal(stored[2]?.error, "falló");
  });
});
