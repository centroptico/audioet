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

export type TranscriptSnapshot = {
  chunks: ChunkRecord[];
  orderedText: string;
  encodingIndex: number | null;
  transcribing: number[];
  doneCount: number;
  total: number;
};
