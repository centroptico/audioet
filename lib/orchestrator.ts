import { MAX_CHUNK_BYTES, MAX_RETRY_ATTEMPTS, MIN_SPLIT_SECONDS, OVERLAP_SECONDS, TRANSCRIBE_CONCURRENCY } from "./config";
import { joinTranscripts, mergeTranscripts } from "./dedup";
import {
  backoffMs,
  classifyStatus,
  errorMessage,
  isAbortError,
  TranscribeRequestError,
} from "./retry";
import type { ChunkPlanItem, ChunkRecord, EncodeResult, TranscriptSnapshot } from "./types";

export type TranscribeInput = {
  bytes: Uint8Array;
  format: EncodeResult["format"];
  signal: AbortSignal;
};

type RunOptions = {
  plan: ChunkPlanItem[];
  initial?: Array<Pick<ChunkRecord, "index" | "status" | "text" | "error">>;
  encode: (range: { start: number; duration: number }) => Promise<EncodeResult>;
  transcribe: (input: TranscribeInput) => Promise<string>;
  concurrency?: number;
  maxChunkBytes?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (snapshot: TranscriptSnapshot) => void;
};

function abortError(): Error {
  const error = new Error("Transcripción cancelada");
  error.name = "AbortError";
  return error;
}

export function orderedTextFrom(chunks: readonly Pick<ChunkRecord, "status" | "text">[]): string {
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (chunk.status !== "done") break;
    parts.push(chunk.text);
  }
  return joinTranscripts(parts);
}

function snapshotOf(records: readonly ChunkRecord[]): TranscriptSnapshot {
  const chunks = records.map((record) => ({ ...record }));
  return {
    chunks,
    orderedText: orderedTextFrom(chunks),
    encodingIndex: chunks.find((chunk) => chunk.status === "encoding")?.index ?? null,
    transcribing: chunks.filter((chunk) => chunk.status === "transcribing").map((chunk) => chunk.index),
    doneCount: chunks.filter((chunk) => chunk.status === "done").length,
    total: chunks.length,
  };
}

/**
 * Encode slices one at a time and transcribe a few of them at once.
 * Results stay tied to their index. The text shown to the user is only the
 * finished prefix, so a later slice never appears before the one before it.
 * A slice that is too big or times out is cut in half (with the same overlap
 * used between planned slices) and the two transcripts are deduped.
 */
export async function runTranscription(options: RunOptions): Promise<TranscriptSnapshot> {
  const concurrency = Math.max(1, options.concurrency ?? TRANSCRIBE_CONCURRENCY);
  const maxChunkBytes = options.maxChunkBytes ?? MAX_CHUNK_BYTES;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const signal = options.signal ?? new AbortController().signal;

  const previous = new Map(options.initial?.map((chunk) => [chunk.index, chunk]));
  const records: ChunkRecord[] = options.plan.map((item) => {
    const saved = previous.get(item.index);
    if (saved?.status === "done" && saved.text) {
      return { ...item, status: "done", text: saved.text };
    }
    return { ...item, status: "pending", text: "" };
  });

  const emit = () => options.onProgress?.(snapshotOf(records));
  emit();

  let encodeTail: Promise<void> = Promise.resolve();
  const encodeExclusive = async (
    range: { start: number; duration: number },
    onStart: () => void,
  ): Promise<EncodeResult> => {
    const run = encodeTail.then(async () => {
      if (signal.aborted) throw abortError();
      onStart();
      return options.encode(range);
    });
    encodeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const canSplit = (duration: number, depth: number) => depth < 4 && duration > MIN_SPLIT_SECONDS * 2;

  const sendWithRetry = async (encoded: EncodeResult): Promise<string> => {
    let retries = 0;
    let splitTries = 0;
    while (true) {
      if (signal.aborted) throw abortError();
      try {
        return await options.transcribe({
          bytes: encoded.bytes,
          format: encoded.format,
          signal,
        });
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw abortError();
        const kind = error instanceof TranscribeRequestError ? classifyStatus(error.status) : "retry";
        if (kind === "fatal") throw error;
        if (kind === "split") {
          if (splitTries < 1) {
            splitTries += 1;
            await sleep(error instanceof TranscribeRequestError && error.retryAfterMs ? error.retryAfterMs : backoffMs(0));
            continue;
          }
          throw error;
        }
        if (retries >= MAX_RETRY_ATTEMPTS - 1) throw error;
        const retryAfter = error instanceof TranscribeRequestError ? error.retryAfterMs : undefined;
        await sleep(retryAfter ?? backoffMs(retries));
        retries += 1;
      }
    }
  };

  const splitRange = async (start: number, duration: number, depth: number, index: number): Promise<string> => {
    const mid = duration / 2;
    const overlap = Math.min(OVERLAP_SECONDS, mid / 4);
    const left = await transcribeRange(start, mid + overlap, depth + 1, index);
    const right = await transcribeRange(start + mid, duration - mid, depth + 1, index);
    return mergeTranscripts(left, right);
  };

  const transcribeRange = async (
    start: number,
    duration: number,
    depth: number,
    index: number,
  ): Promise<string> => {
    if (signal.aborted) throw abortError();
    const encoded = await encodeExclusive({ start, duration }, () => {
      if (depth === 0) {
        records[index] = { ...records[index], status: "encoding", error: undefined };
        emit();
      }
    });
    if (signal.aborted) throw abortError();
    if (encoded.bytes.byteLength > maxChunkBytes && canSplit(duration, depth)) {
      return splitRange(start, duration, depth, index);
    }
    records[index] = { ...records[index], status: "transcribing" };
    emit();
    try {
      return await sendWithRetry(encoded);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw abortError();
      const kind = error instanceof TranscribeRequestError ? classifyStatus(error.status) : "retry";
      if (kind === "split" && canSplit(duration, depth)) {
        return splitRange(start, duration, depth, index);
      }
      throw error;
    }
  };

  let cursor = 0;
  const worker = async () => {
    while (!signal.aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= records.length) return;
      if (records[index].status === "done") continue;
      try {
        const text = await transcribeRange(records[index].start, records[index].duration, 0, index);
        if (signal.aborted) return;
        records[index] = { ...records[index], status: "done", text, error: undefined };
        emit();
      } catch (error) {
        if (isAbortError(error) || signal.aborted) return;
        records[index] = {
          ...records[index],
          status: "error",
          text: "",
          error: errorMessage(error),
        };
        emit();
      }
    }
  };

  const workers = Math.min(concurrency, Math.max(1, records.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return snapshotOf(records);
}
