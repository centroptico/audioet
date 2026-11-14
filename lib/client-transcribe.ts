import type { AudioFormat } from "./config";
import { parseRetryAfter, TranscribeRequestError } from "./retry";

export async function postChunk(bytes: Uint8Array, format: AudioFormat, signal: AbortSignal): Promise<string> {
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

  let payload: { text?: unknown; error?: unknown; retryAfterMs?: unknown } = {};
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
    throw new TranscribeRequestError(message, response.status, retryAfter);
  }

  if (typeof payload.text !== "string") {
    throw new TranscribeRequestError("La respuesta no trae texto.", 502);
  }
  return payload.text;
}
