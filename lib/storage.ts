import { OVERLAP_SECONDS, CHUNK_SECONDS, PLAN_VERSION } from "./config";
import type { ChunkRecord } from "./types";

export const STORAGE_KEY = "audioet:v1";

export type PersistedChunk = {
  index: number;
  start: number;
  duration: number;
  status: "pending" | "done" | "error";
  text: string;
  error?: string;
};

export type PersistedTranscript = {
  version: 1;
  planVersion: number;
  chunkSeconds: number;
  overlapSeconds: number;
  fileKey: string;
  fileName: string;
  fileSize: number;
  durationSec: number;
  editedText: string | null;
  /** Running USD total. Missing on older saves, which load as 0. */
  costUsd: number;
  /** Sum of usage.seconds across billed calls. */
  billedSeconds: number;
  /** False when at least one call did not report usage.cost. */
  costKnown: boolean;
  chunks: PersistedChunk[];
  updatedAt: number;
};

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function fileKeyOf(file: { name: string; size: number; lastModified: number }): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function persistableChunks(chunks: readonly ChunkRecord[]): PersistedChunk[] {
  return chunks.map((chunk) => ({
    index: chunk.index,
    start: chunk.start,
    duration: chunk.duration,
    status: chunk.status === "done" ? "done" : chunk.status === "error" ? "error" : "pending",
    text: chunk.status === "done" ? chunk.text : "",
    error: chunk.status === "error" ? chunk.error : undefined,
  }));
}

function asMoney(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isPersisted(value: unknown): value is PersistedTranscript {
  if (!value || typeof value !== "object") return false;
  const record = value as PersistedTranscript;
  return (
    record.version === 1 &&
    typeof record.fileKey === "string" &&
    typeof record.fileName === "string" &&
    Array.isArray(record.chunks)
  );
}

export function loadTranscript(store: KeyValueStore): PersistedTranscript | null {
  const raw = store.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPersisted(parsed)) return null;
    return {
      ...parsed,
      costUsd: asMoney(parsed.costUsd),
      billedSeconds: asMoney(parsed.billedSeconds),
      costKnown: typeof parsed.costKnown === "boolean" ? parsed.costKnown : false,
    };
  } catch {
    return null;
  }
}

export function saveTranscript(store: KeyValueStore, value: PersistedTranscript): boolean {
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearTranscript(store: KeyValueStore): void {
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Private mode can throw. There is nothing else to clear.
  }
}

export function samePlan(saved: PersistedTranscript | null): saved is PersistedTranscript {
  return Boolean(
    saved &&
      saved.planVersion === PLAN_VERSION &&
      saved.chunkSeconds === CHUNK_SECONDS &&
      saved.overlapSeconds === OVERLAP_SECONDS,
  );
}
