import {
  OPENROUTER_MODEL,
  OPENROUTER_URL,
  UPSTREAM_MODE,
  UPSTREAM_TIMEOUT_MS,
  type AudioFormat,
} from "./config";
import type { BillableUsage } from "./types";

export type UpstreamMode = "json" | "multipart";

export type TranscriptionResult = {
  text: string;
  cost: number;
  seconds: number;
  costKnown: boolean;
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

export function buildUpstreamRequest(options: {
  apiKey: string;
  bytes: Uint8Array;
  format: AudioFormat;
  siteUrl?: string;
  mode?: UpstreamMode;
}): { url: string; init: RequestInit } {
  const mode = options.mode ?? UPSTREAM_MODE;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
    "X-Title": "Audioet",
  };
  if (options.siteUrl) headers["HTTP-Referer"] = options.siteUrl;

  if (mode === "multipart") {
    const form = new FormData();
    const file = new File([toArrayBuffer(options.bytes)], `audio.${options.format}`, {
      type: MIME[options.format],
    });
    form.append("file", file);
    form.append("model", OPENROUTER_MODEL);
    return { url: OPENROUTER_URL, init: { method: "POST", headers, body: form } };
  }

  headers["Content-Type"] = "application/json";
  const body = JSON.stringify({
    model: OPENROUTER_MODEL,
    input_audio: {
      data: Buffer.from(options.bytes).toString("base64"),
      format: options.format,
    },
  });
  return { url: OPENROUTER_URL, init: { method: "POST", headers, body } };
}

export async function transcribeWithOpenRouter(options: {
  apiKey: string;
  bytes: Uint8Array;
  format: AudioFormat;
  siteUrl?: string;
  mode?: UpstreamMode;
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

  let payload: { text?: unknown };
  try {
    payload = JSON.parse(raw) as { text?: unknown };
  } catch {
    throw new OpenRouterError("OpenRouter devolvió una respuesta que no es JSON.", 502);
  }
  if (typeof payload.text !== "string") {
    throw new OpenRouterError("OpenRouter no devolvió el campo text.", 502);
  }
  const usage = readUsage(payload);
  return {
    text: payload.text,
    cost: usage.cost,
    seconds: usage.seconds,
    costKnown: usage.costKnown,
  };
}
