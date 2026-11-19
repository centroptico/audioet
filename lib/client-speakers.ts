import { parseRetryAfter, TranscribeRequestError } from "./retry";
import type { SpeakerExcerpt, SpeakerMap } from "./speaker-map";

export type SpeakerBill = {
  maps: SpeakerMap[];
  cost: number;
  costKnown: boolean;
};

export async function postSpeakerMap(chunks: SpeakerExcerpt[], signal: AbortSignal): Promise<SpeakerBill> {
  let response: Response;
  try {
    response = await fetch("/api/speakers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chunks }),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new TranscribeRequestError("No hay conexión para unificar hablantes.", 503);
  }

  let payload: { maps?: unknown; error?: unknown; cost?: unknown; costKnown?: unknown; retryAfterMs?: unknown } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    payload = {};
  }

  const cost = typeof payload.cost === "number" && Number.isFinite(payload.cost) ? payload.cost : 0;
  const costKnown = typeof payload.costKnown === "boolean" ? payload.costKnown : typeof payload.cost === "number";
  if (!response.ok) {
    const message =
      typeof payload.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : `Error ${response.status} al unificar hablantes.`;
    const retryAfter =
      typeof payload.retryAfterMs === "number"
        ? payload.retryAfterMs
        : parseRetryAfter(response.headers.get("retry-after"));
    throw new TranscribeRequestError(message, response.status, retryAfter, costKnown ? { cost, seconds: 0, costKnown } : undefined);
  }
  if (!Array.isArray(payload.maps)) {
    throw new TranscribeRequestError("La respuesta no trae el mapa de hablantes.", 502);
  }
  return { maps: payload.maps as SpeakerMap[], cost, costKnown };
}
