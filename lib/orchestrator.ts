import { MAX_CHUNK_BYTES, MAX_RETRY_ATTEMPTS, MIN_SPLIT_SECONDS, OVERLAP_SECONDS, TRANSCRIBE_CONCURRENCY } from "./config";
import { joinTranscripts, mergeTranscripts } from "./dedup";
import {
  backoffMs,
  classifyStatus,
  errorMessage,
  isAbortError,
  TranscribeRequestError,
} from "./retry";
import type { BillableUsage, ChunkPlanItem, ChunkRecord, EncodeResult, TranscriptSnapshot } from "./types";

export type TranscribeChunkResult = {
  text: string;
  cost?: number;
  seconds?: number;
  costKnown?: boolean;
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function roundMoney(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

export function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function usageFromResult(value: string | TranscribeChunkResult): BillableUsage & { text: string } {
  if (typeof value === "string") return { text: value, cost: 0, seconds: 0, costKnown: true };
  const cost = finiteNumber(value.cost);
  const seconds = finiteNumber(value.seconds);
  const costKnown = typeof value.costKnown === "boolean" ? value.costKnown : cost !== undefined;
  return { text: value.text, cost: cost ?? 0, seconds: seconds ?? 0, costKnown };
}

function addUsage(total: BillableUsage, next: BillableUsage): void {
  total.cost = roundMoney(total.cost + next.cost);
  total.seconds = roundSeconds(total.seconds + next.seconds);
  if (!next.costKnown) total.costKnown = false;
}

export type TranscribeInput = {
  bytes: Uint8Array;
  format: EncodeResult["format"];
  signal: AbortSignal;
  /** Start of this slice in the original file, in seconds. */
  start: number;
  /** Absolute time before which this slice's words repeat the previous slice. */
  dropBefore: number;
};

type RunOptions = {
  plan: ChunkPlanItem[];
  initial?: Array<Pick<ChunkRecord, "index" | "status" | "text" | "error">>;
  encode: (range: { start: number; duration: number }) => Promise<EncodeResult>;
  transcribe: (input: TranscribeInput) => Promise<string | TranscribeChunkResult>;
  initialUsage?: BillableUsage;
  /** Paragraph output. Slices are concatenated instead of word-deduped. */
  structured?: boolean;
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

export function joinBlocks(previous: string, next: string): string {
  const left = previous.trim();
  const right = next.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left}\n\n${right}`;
}

export function orderedTextFrom(
  chunks: readonly Pick<ChunkRecord, "status" | "text">[],
  mode: "plain" | "blocks" = "plain",
): string {
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (chunk.status !== "done") break;
    parts.push(chunk.text);
  }
  if (mode === "blocks") return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
  return joinTranscripts(parts);
}

function snapshotOf(records: readonly ChunkRecord[], usage: BillableUsage, structured: boolean): TranscriptSnapshot {
  const chunks = records.map((record) => ({ ...record }));
  return {
    chunks,
    orderedText: orderedTextFrom(chunks, structured ? "blocks" : "plain"),
    encodingIndex: chunks.find((chunk) => chunk.status === "encoding")?.index ?? null,
    transcribing: chunks.filter((chunk) => chunk.status === "transcribing").map((chunk) => chunk.index),
    doneCount: chunks.filter((chunk) => chunk.status === "done").length,
    total: chunks.length,
    costUsd: usage.cost,
    billedSeconds: usage.seconds,
    costKnown: usage.costKnown,
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

  const usage: BillableUsage = {
    cost: finiteNumber(options.initialUsage?.cost) ?? 0,
    seconds: finiteNumber(options.initialUsage?.seconds) ?? 0,
    costKnown: options.initialUsage?.costKnown !== false,
  };
  const previous = new Map(options.initial?.map((chunk) => [chunk.index, chunk]));
  const records: ChunkRecord[] = options.plan.map((item) => {
    const saved = previous.get(item.index);
    if (saved?.status === "done" && saved.text) {
      return { ...item, status: "done", text: saved.text };
    }
    return { ...item, status: "pending", text: "" };
  });

  const structured = options.structured === true;
  const emit = () => options.onProgress?.(snapshotOf(records, usage, structured));
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

  const combine = structured ? joinBlocks : mergeTranscripts;

  const sendWithRetry = async (encoded: EncodeResult, start: number, dropBefore: number): Promise<string> => {
    let retries = 0;
    let splitTries = 0;
    while (true) {
      if (signal.aborted) throw abortError();
      try {
        const result = usageFromResult(
          await options.transcribe({
            bytes: encoded.bytes,
            format: encoded.format,
            signal,
            start,
            dropBefore,
          }),
        );
        addUsage(usage, result);
        return result.text;
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw abortError();
        if (error instanceof TranscribeRequestError && error.usage) addUsage(usage, error.usage);
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

  const splitRange = async (
    start: number,
    duration: number,
    depth: number,
    index: number,
    dropBefore: number,
  ): Promise<string> => {
    const mid = duration / 2;
    const overlap = Math.min(OVERLAP_SECONDS, mid / 4);
    const leftEnd = start + mid + overlap;
    const left = await transcribeRange(start, mid + overlap, depth + 1, index, dropBefore);
    const right = await transcribeRange(start + mid, duration - mid, depth + 1, index, leftEnd);
    return combine(left, right);
  };

  const transcribeRange = async (
    start: number,
    duration: number,
    depth: number,
    index: number,
    dropBefore: number,
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
      return splitRange(start, duration, depth, index, dropBefore);
    }
    records[index] = { ...records[index], status: "transcribing" };
    emit();
    try {
      return await sendWithRetry(encoded, start, dropBefore);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw abortError();
      const kind = error instanceof TranscribeRequestError ? classifyStatus(error.status) : "retry";
      if (kind === "split" && canSplit(duration, depth)) {
        return splitRange(start, duration, depth, index, dropBefore);
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
        const dropBefore =
          index === 0 ? records[index].start : records[index - 1].start + records[index - 1].duration;
        const text = await transcribeRange(records[index].start, records[index].duration, 0, index, dropBefore);
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
  return snapshotOf(records, usage, structured);
}
