import { isSameOrigin } from "../../../lib/origin";
import { OpenRouterError } from "../../../lib/openrouter";
import type { SpeakerExcerpt } from "../../../lib/speaker-map";
import { unifySpeakers } from "../../../lib/speakers";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_BODY = 200_000;

function isExcerpt(value: unknown): value is SpeakerExcerpt {
  if (!value || typeof value !== "object") return false;
  const record = value as SpeakerExcerpt;
  if (typeof record.index !== "number" || !Array.isArray(record.speakers) || record.speakers.length > 12) {
    return false;
  }
  return record.speakers.every((speaker) => {
    if (!speaker || typeof speaker !== "object") return false;
    const item = speaker as SpeakerExcerpt["speakers"][number];
    return (
      typeof item.label === "string" &&
      /^Speaker \d+$/.test(item.label) &&
      typeof item.first === "string" &&
      item.first.length <= 400 &&
      typeof item.last === "string" &&
      item.last.length <= 400 &&
      Array.isArray(item.hints) &&
      item.hints.length <= 3 &&
      item.hints.every((hint) => typeof hint === "string" && hint.length <= 400)
    );
  });
}

/**
 * Asks a chat model for a speaker-name map. The body is short text excerpts.
 * Audio never reaches this route.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Origen no permitido." }, { status: 403 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "Falta OPENROUTER_API_KEY en el servidor." }, { status: 422 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) {
    return Response.json({ error: "Los extractos son demasiado grandes." }, { status: 413 });
  }

  let body: { chunks?: unknown };
  try {
    body = JSON.parse(raw) as { chunks?: unknown };
  } catch {
    return Response.json({ error: "El cuerpo no es JSON." }, { status: 400 });
  }
  if (!Array.isArray(body.chunks) || body.chunks.length === 0 || body.chunks.length > 40 || !body.chunks.every(isExcerpt)) {
    return Response.json({ error: "Faltan los extractos de los fragmentos." }, { status: 400 });
  }

  const origin = request.headers.get("origin");
  const siteUrl = process.env.OPENROUTER_SITE_URL || origin || undefined;

  try {
    const result = await unifySpeakers({
      apiKey,
      excerpts: body.chunks,
      chunkCount: body.chunks.length,
      siteUrl,
      signal: request.signal,
    });
    return Response.json({ maps: result.maps, cost: result.cost, costKnown: result.costKnown });
  } catch (error) {
    if (error instanceof OpenRouterError) {
      return Response.json(
        {
          error: `OpenRouter: ${error.message}`,
          ...(error.usage ? { cost: error.usage.cost, costKnown: error.usage.costKnown } : {}),
        },
        { status: error.status === 499 ? 499 : error.status },
      );
    }
    return Response.json({ error: "Error inesperado al unificar hablantes." }, { status: 502 });
  }
}
