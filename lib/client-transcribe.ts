import type { AudioFormat } from "./config";
import { parseRetryAfter, TranscribeRequestError } from "./retry";
import type { TimedSegment, TimedWord } from "./transcript-format";
import type { TranscriptJob } from "./transcript-job";
import type { BillableUsage } from "./types";

export type ChunkBill = {
  text: string;
  cost: number;
  seconds: number;
  costKnown: boolean;
  words: TimedWord[];
  segments: TimedSegment[];
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function billOf(payload: { cost?: unknown; seconds?: unknown; costKnown?: unknown }): BillableUsage {
  const cost = finiteNumber(payload.cost);
  const seconds = finiteNumber(payload.seconds);
  const costKnown = typeof payload.costKnown === "boolean" ? payload.costKnown : cost !== undefined;
  return { cost: cost ?? 0, seconds: seconds ?? 0, costKnown };
}

function readWords(value: unknown): TimedWord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TimedWord => {
    if (!item || typeof item !== "object") return false;
    const word = item as TimedWord;
    return typeof word.word === "string" && typeof word.start === "number";
  });
}

function readSegments(value: unknown): TimedSegment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TimedSegment => {
    if (!item || typeof item !== "object") return false;
    const segment = item as TimedSegment;
    return typeof segment.text === "string" && typeof segment.start === "number";
  });
}

export async function postChunk(
  bytes: Uint8Array,
  format: AudioFormat,
  signal: AbortSignal,
  job: TranscriptJob,
): Promise<ChunkBill> {
  const form = new FormData();
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  form.append("file", blob, `fragmento.${format}`);
  form.append("format", format);
  form.append("model", job.model);
  form.append("speakers", job.speakers ? "1" : "0");
  form.append("timestamps", job.timestamps ? "1" : "0");

  let response: Response;
  try {
    response = await fetch("/api/transcribe", { method: "POST", body: form, signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new TranscribeRequestError("No hay conexión. Se reintentará el fragmento.", 503);
  }

  let payload: {
    text?: unknown;
    error?: unknown;
    retryAfterMs?: unknown;
    cost?: unknown;
    seconds?: unknown;
    costKnown?: unknown;
    words?: unknown;
    segments?: unknown;
  } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const message =
      typeof payload.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : response.status === 413
          ? "El fragmento supera el límite de subida."
          : `Error ${response.status} al transcribir.`;
    const retryAfter =
      typeof payload.retryAfterMs === "number"
        ? payload.retryAfterMs
        : parseRetryAfter(response.headers.get("retry-after"));
    const bill = billOf(payload);
    throw new TranscribeRequestError(message, response.status, retryAfter, bill.costKnown ? bill : undefined);
  }

  if (typeof payload.text !== "string" && readWords(payload.words).length === 0 && readSegments(payload.segments).length === 0) {
    throw new TranscribeRequestError("La respuesta no trae texto.", 502);
  }
  const bill = billOf(payload);
  return {
    text: typeof payload.text === "string" ? payload.text : "",
    cost: bill.cost,
    seconds: bill.seconds,
    costKnown: bill.costKnown,
    words: readWords(payload.words),
    segments: readSegments(payload.segments),
  };
}
