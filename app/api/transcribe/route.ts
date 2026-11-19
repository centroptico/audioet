import { API_MAX_BYTES, isAudioFormat, isSttModelKey } from "../../../lib/config";
import { isSameOrigin } from "../../../lib/origin";
import { OpenRouterError, transcribeWithOpenRouter } from "../../../lib/openrouter";
import { flagOn, type TranscriptJob } from "../../../lib/transcript-job";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Forwards one audio slice to OpenRouter and returns `{ text, cost, seconds, costKnown, words, segments }`.
 * The bytes exist only for this request. Nothing is written to disk,
 * Blob storage, or a database.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Origen no permitido." }, { status: 403 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Falta OPENROUTER_API_KEY en el servidor." },
      { status: 422 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "No se pudo leer el fragmento." }, { status: 400 });
  }

  const file = form.get("file");
  const format = String(form.get("format") ?? "");
  if (!(file instanceof File)) {
    return Response.json({ error: "Falta el audio del fragmento." }, { status: 400 });
  }
  if (!isAudioFormat(format)) {
    return Response.json({ error: `Formato no soportado: ${format}` }, { status: 400 });
  }
  if (file.size <= 0) {
    return Response.json({ error: "El fragmento está vacío." }, { status: 400 });
  }
  if (file.size > API_MAX_BYTES) {
    return Response.json(
      { error: `El fragmento pesa demasiado (${file.size} bytes) para subirlo.` },
      { status: 413 },
    );
  }

  const modelKey = String(form.get("model") ?? "grok");
  if (!isSttModelKey(modelKey)) {
    return Response.json({ error: "Modelo no permitido." }, { status: 400 });
  }
  const job: TranscriptJob = {
    speakers: flagOn(form.get("speakers")),
    timestamps: flagOn(form.get("timestamps")),
    model: modelKey,
  };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const origin = request.headers.get("origin");
  const siteUrl = process.env.OPENROUTER_SITE_URL || origin || undefined;

  try {
    const result = await transcribeWithOpenRouter({
      apiKey,
      bytes,
      format,
      siteUrl,
      job,
      signal: request.signal,
    });
    return Response.json({
      text: result.text,
      cost: result.cost,
      seconds: result.seconds,
      costKnown: result.costKnown,
      words: result.words,
      segments: result.segments,
    });
  } catch (error) {
    if (error instanceof OpenRouterError) {
      return Response.json(
        {
          error: `OpenRouter: ${error.message}`,
          ...(error.usage
            ? { cost: error.usage.cost, seconds: error.usage.seconds, costKnown: error.usage.costKnown }
            : {}),
        },
        { status: error.status === 499 ? 499 : error.status },
      );
    }
    return Response.json({ error: "Error inesperado al transcribir." }, { status: 502 });
  }
}
