import type { AudioFormat } from "./config";

export type ChunkPlanItem = {
  index: number;
  start: number;
  duration: number;
};

export type ChunkStatus = "pending" | "encoding" | "transcribing" | "done" | "error";

export type ChunkRecord = {
  index: number;
  start: number;
  duration: number;
  status: ChunkStatus;
  text: string;
  error?: string;
};

export type EncodeResult = {
  bytes: Uint8Array;
  format: AudioFormat;
  bitrate: string;
};

/** USD cost and billed audio seconds reported by one upstream call. */
export type BillableUsage = {
  cost: number;
  seconds: number;
  costKnown: boolean;
};

export type TranscriptSnapshot = {
  chunks: ChunkRecord[];
  orderedText: string;
  encodingIndex: number | null;
  transcribing: number[];
  doneCount: number;
  total: number;
  costUsd: number;
  billedSeconds: number;
  costKnown: boolean;
};
