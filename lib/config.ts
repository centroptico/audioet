/**
 * Knobs for splitting long voice notes before they hit Vercel or OpenRouter.
 *
 * A 10 minute slice at 32 kbps mono is 600 * 32_000 / 8 = 2_400_000 bytes.
 * That sits under the 4.5 MB Vercel function body limit with room for the
 * multipart envelope, and far under OpenRouter's 25 MB upload cap.
 * Upstream transcription calls time out around 60 s; if a slice still
 * times out, the client splits it in half and retries.
 */
export const CHUNK_SECONDS = 600;
export const OVERLAP_SECONDS = 5;
export const SAMPLE_RATE = 16_000;
export const CHANNELS = 1;
export const TRANSCRIBE_CONCURRENCY = 3;
export const MAX_CHUNK_BYTES = 3_500_000;
export const API_MAX_BYTES = 4_200_000;
export const MAX_RETRY_ATTEMPTS = 4;
export const MIN_SPLIT_SECONDS = 30;
export const UPSTREAM_TIMEOUT_MS = 70_000;
export const PLAN_VERSION = 1;

/** Documented JSON shape. Switch to "multipart" to send an OpenAI-style file upload. */
export const UPSTREAM_MODE = "json" as "json" | "multipart";

export const OPENROUTER_MODEL = "x-ai/grok-stt-2.0";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/audio/transcriptions";

export const AUDIO_FORMATS = ["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

export function isAudioFormat(value: string): value is AudioFormat {
  return (AUDIO_FORMATS as readonly string[]).includes(value);
}
