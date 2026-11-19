import {
  OPENROUTER_MODEL,
  OPENROUTER_URL,
  STT_MODELS,
  UPSTREAM_MODE,
  UPSTREAM_TIMEOUT_MS,
  type AudioFormat,
} from "./config";
import type { TranscriptJob } from "./transcript-job";
import { jobNeedsStructure } from "./transcript-job";
import type { TimedSegment, TimedWord } from "./transcript-format";
import type { BillableUsage } from "./types";

export type UpstreamMode = "json" | "multipart";

export type TranscriptionResult = {
  text: string;
  cost: number;
  seconds: number;
  costKnown: boolean;
  words: TimedWord[];
  segments: TimedSegment[];
};

export class OpenRouterError extends Error {
  readonly status: number;
  readonly usage?: BillableUsage;

  constructor(message: string, status: number, usage?: BillableUsage) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.usage = usage;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const MIME: Record<AudioFormat, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  aac: "audio/aac",
  wav: "audio/wav",
  webm: "audio/webm",
  flac: "audio/flac",
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Reads usage.cost and usage.seconds. A missing cost is 0 and costKnown is false. */
export function readUsage(payload: unknown): BillableUsage {
  const usage =
    payload && typeof payload === "object" && "usage" in payload
      ? (payload as { usage?: unknown }).usage
      : undefined;
  if (!usage || typeof usage !== "object") {
    return { cost: 0, seconds: 0, costKnown: false };
  }
  const record = usage as { cost?: unknown; seconds?: unknown };
  const cost = finiteNumber(record.cost);
  const seconds = finiteNumber(record.seconds);
  return {
    cost: cost ?? 0,
    seconds: seconds ?? 0,
    costKnown: cost !== undefined,
  };
}

function billedFromErrorBody(raw: string): BillableUsage | undefined {
  try {
    const usage = readUsage(JSON.parse(raw));
    return usage.costKnown ? usage : undefined;
  } catch {
    return undefined;
  }
}

export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join("[clave]");
}

export function parseUpstreamError(status: number, raw: string, secret?: string): string {
  let message = "";
  const body = raw.trim();
  if (body) {
    try {
      const json = JSON.parse(body) as {
        error?: { message?: unknown } | string;
        message?: unknown;
      };
      if (typeof json.error === "string") message = json.error;
      else if (json.error && typeof json.error === "object" && typeof json.error.message === "string") {
        message = json.error.message;
      } else if (typeof json.message === "string") message = json.message;
    } catch {
      message = body.slice(0, 800);
    }
  }
  if (!message) message = `OpenRouter respondió ${status}`;
  return redactSecret(message, secret).slice(0, 800);
}

function jobPayload(job: TranscriptJob | undefined): Record<string, unknown> {
  const model = job ? STT_MODELS[job.model] : OPENROUTER_MODEL;
  const payload: Record<string, unknown> = { model };
  if (!job || !jobNeedsStructure(job)) return payload;
  payload.response_format = "verbose_json";
  if (!job.speakers) return payload;
  if (job.model === "microsoft") {
    payload.diarize = true;
    return payload;
  }
  // Grok rejects a top-level diarize flag. The provider option is accepted.
  payload.provider = { options: { xai: { diarize: true } } };
  return payload;
}

export function buildUpstreamRequest(options: {
  apiKey: string;
  bytes: Uint8Array;
  format: AudioFormat;
  siteUrl?: string;
  mode?: UpstreamMode;
  job?: TranscriptJob;
}): { url: string; init: RequestInit } {
  const mode = options.mode ?? UPSTREAM_MODE;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
    "X-Title": "Audioet",
  };
  if (options.siteUrl) headers["HTTP-Referer"] = options.siteUrl;
  const extra = jobPayload(options.job);

  if (mode === "multipart") {
    const form = new FormData();
    const file = new File([toArrayBuffer(options.bytes)], `audio.${options.format}`, {
      type: MIME[options.format],
    });
    form.append("file", file);
    form.append("model", String(extra.model));
    if (typeof extra.response_format === "string") form.append("response_format", extra.response_format);
    if (extra.diarize === true) form.append("diarize", "true");
    return { url: OPENROUTER_URL, init: { method: "POST", headers, body: form } };
  }

  headers["Content-Type"] = "application/json";
  const body = JSON.stringify({
    ...extra,
    input_audio: {
      data: Buffer.from(options.bytes).toString("base64"),
      format: options.format,
    },
  });
  return { url: OPENROUTER_URL, init: { method: "POST", headers, body } };
}

function readTimedList(value: unknown, textKey: "word" | "text"): Array<TimedWord | TimedSegment> {
  if (!Array.isArray(value)) return [];
  const items: Array<TimedWord | TimedSegment> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { word?: unknown; text?: unknown; start?: unknown; end?: unknown; speaker?: unknown };
    const rawText = textKey === "word" ? record.word : record.text;
    const text = typeof rawText === "string" ? rawText.trim() : "";
    const start = finiteNumber(record.start);
    if (!text || start === undefined) continue;
    const end = finiteNumber(record.end) ?? start;
    const speaker = finiteNumber(record.speaker);
    const item = { start, end, ...(speaker !== undefined && speaker >= 0 ? { speaker: Math.floor(speaker) } : {}) };
    if (textKey === "word") items.push({ ...item, word: text });
    else items.push({ ...item, text });
  }
  return items;
}

export async function transcribeWithOpenRouter(options: {
  apiKey: string;
  bytes: Uint8Array;
  format: AudioFormat;
  siteUrl?: string;
  mode?: UpstreamMode;
  job?: TranscriptJob;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<TranscriptionResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const { url, init } = buildUpstreamRequest(options);

  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      if (options.signal?.aborted) {
        throw new OpenRouterError("La petición se canceló.", 499);
      }
      throw new OpenRouterError("OpenRouter no respondió a tiempo.", 504);
    }
    throw new OpenRouterError("No se pudo contactar con OpenRouter.", 502);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new OpenRouterError(
      parseUpstreamError(response.status, raw, options.apiKey),
      response.status,
      billedFromErrorBody(raw),
    );
  }

  let payload: { text?: unknown; words?: unknown; segments?: unknown };
  try {
    payload = JSON.parse(raw) as { text?: unknown; words?: unknown; segments?: unknown };
  } catch {
    throw new OpenRouterError("OpenRouter devolvió una respuesta que no es JSON.", 502);
  }
  const usage = readUsage(payload);
  const verbose = Boolean(options.job && jobNeedsStructure(options.job));
  const words = verbose ? (readTimedList(payload.words, "word") as TimedWord[]) : [];
  const segments = verbose && words.length === 0 ? (readTimedList(payload.segments, "text") as TimedSegment[]) : [];
  const segmentText = segments.map((segment) => segment.text).join(" ");
  const text = typeof payload.text === "string" ? payload.text : segmentText;
  if (!text && words.length === 0 && segments.length === 0) {
    throw new OpenRouterError("OpenRouter no devolvió el campo text.", 502);
  }
  return {
    text,
    cost: usage.cost,
    seconds: usage.seconds,
    costKnown: usage.costKnown,
    words,
    segments,
  };
}
