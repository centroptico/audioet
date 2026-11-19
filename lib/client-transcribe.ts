import type { AudioFormat } from "./config";
import { parseRetryAfter, TranscribeRequestError } from "./retry";
import type { BillableUsage } from "./types";

export type ChunkBill = {
  text: string;
  cost: number;
  seconds: number;
  costKnown: boolean;
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

export async function postChunk(bytes: Uint8Array, format: AudioFormat, signal: AbortSignal): Promise<ChunkBill> {
  const form = new FormData();
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  form.append("file", blob, `fragmento.${format}`);
  form.append("format", format);

  let response: Response;
  try {
    response = await fetch("/api/transcribe", { method: "POST", body: form, signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new TranscribeRequestError("No hay conexión. Se reintentará el fragmento.", 503);
  }

  let payload: { text?: unknown; error?: unknown; retryAfterMs?: unknown; cost?: unknown; seconds?: unknown; costKnown?: unknown } =
    {};
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

  if (typeof payload.text !== "string") {
    throw new TranscribeRequestError("La respuesta no trae texto.", 502);
  }
  const bill = billOf(payload);
  return { text: payload.text, cost: bill.cost, seconds: bill.seconds, costKnown: bill.costKnown };
}
