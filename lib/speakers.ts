import { OPENROUTER_CHAT_URL, SPEAKER_MODEL, UPSTREAM_TIMEOUT_MS } from "./config";
import { OpenRouterError, readUsage } from "./openrouter";
import { parseSpeakerContent, type SpeakerExcerpt, type SpeakerMap } from "./speaker-map";
import type { BillableUsage } from "./types";

export type SpeakerUnifyResult = {
  maps: SpeakerMap[];
  cost: number;
  costKnown: boolean;
};

const INSTRUCTIONS = `Eres un asistente que solo devuelve JSON.
Recibes extractos de una transcripción dividida en fragmentos. En cada fragmento los hablantes se llaman Speaker 1, Speaker 2, y esos números NO coinciden entre fragmentos.
Devuelve exactamente {"chunks":[{ "Speaker 1": "Nombre" }, ...]} con un objeto por fragmento, en el mismo orden e índices.
Reglas:
- No reescribas ni cites las palabras dichas. Solo renombra etiquetas.
- La misma persona debe quedar con el mismo nombre en todos los fragmentos.
- Sustituye Speaker N por un nombre solo si el extracto lo revela con claridad (por ejemplo "soy Ana" o alguien le dice "Ana").
- Si no hay un nombre claro, conserva una etiqueta Speaker N, pero usa el mismo número para la misma persona en todos los fragmentos.
- Cada valor es un nombre corto o "Speaker N", sin saltos de línea.`;

export function buildSpeakerRequest(options: {
  apiKey: string;
  excerpts: SpeakerExcerpt[];
  chunkCount: number;
  siteUrl?: string;
}): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
    "Content-Type": "application/json",
    "X-Title": "Audioet",
  };
  if (options.siteUrl) headers["HTTP-Referer"] = options.siteUrl;
  const body = JSON.stringify({
    model: SPEAKER_MODEL,
    temperature: 0,
    usage: { include: true },
    messages: [
      { role: "system", content: INSTRUCTIONS },
      {
        role: "user",
        content: JSON.stringify({
          chunks: options.chunkCount,
          excerpts: options.excerpts,
        }),
      },
    ],
  });
  return { url: OPENROUTER_CHAT_URL, init: { method: "POST", headers, body } };
}

function messageContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  return typeof message?.content === "string" ? message.content : "";
}

export async function unifySpeakers(options: {
  apiKey: string;
  excerpts: SpeakerExcerpt[];
  chunkCount: number;
  siteUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<SpeakerUnifyResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const { url, init } = buildSpeakerRequest(options);

  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      if (options.signal?.aborted) throw new OpenRouterError("La petición se canceló.", 499);
      throw new OpenRouterError("OpenRouter no respondió a tiempo.", 504);
    }
    throw new OpenRouterError("No se pudo contactar con OpenRouter.", 502);
  }

  const raw = await response.text();
  let payload: unknown = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  const usage: BillableUsage = readUsage(payload);
  if (!response.ok) {
    throw new OpenRouterError(
      `OpenRouter respondió ${response.status}`,
      response.status,
      usage.costKnown ? usage : undefined,
    );
  }
  const maps = parseSpeakerContent(messageContent(payload), options.chunkCount);
  if (!maps) throw new OpenRouterError("OpenRouter no devolvió un mapa de hablantes válido.", 502);
  return { maps, cost: usage.cost, costKnown: usage.costKnown };
}
