import { CHANNELS, SAMPLE_RATE } from "./config";
import type { AudioFormat } from "./config";

export type EncoderChoice = {
  id: "libmp3lame" | "aac" | "libopus";
  format: AudioFormat;
  bitrate: string;
  extension: string;
};

/**
 * Prefer MP3 because that is the shape the OpenRouter docs show.
 * AAC and Opus are fallbacks that the same endpoint also accepts.
 * Bitrates stay low so a 10 minute slice is about 2.4 MB (or less for Opus).
 */
export const ENCODER_PREFERENCE: readonly EncoderChoice[] = [
  { id: "libmp3lame", format: "mp3", bitrate: "32k", extension: "mp3" },
  { id: "aac", format: "m4a", bitrate: "32k", extension: "m4a" },
  { id: "libopus", format: "ogg", bitrate: "24k", extension: "ogg" },
];

export function listEncoderNames(ffmpegList: string): Set<string> {
  const names = new Set<string>();
  for (const line of ffmpegList.split("\n")) {
    const match = line.match(/^\s*[A-Z.]{6}\s+(\S+)/);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

export function pickEncoder(ffmpegList: string): EncoderChoice | null {
  const names = listEncoderNames(ffmpegList);
  for (const choice of ENCODER_PREFERENCE) {
    if (names.has(choice.id)) return choice;
  }
  return null;
}

export function parseDuration(log: string): number | null {
  const match = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const total = hours * 3600 + minutes * 60 + seconds;
  if (!Number.isFinite(total) || total <= 0) return null;
  return total;
}

function formatSeconds(value: number): string {
  return value.toFixed(3);
}

/**
 * Fast seek (`-ss` / `-t` before `-i`) so a late slice of a 3 hour file
 * does not decode everything before it. Output is mono 16 kHz speech.
 */
export function buildChunkArgs(
  inputPath: string,
  outputPath: string,
  start: number,
  duration: number,
  encoder: EncoderChoice,
): string[] {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-ss",
    formatSeconds(Math.max(0, start)),
    "-t",
    formatSeconds(Math.max(0.1, duration)),
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    String(CHANNELS),
    "-ar",
    String(SAMPLE_RATE),
    "-c:a",
    encoder.id,
    "-b:a",
    encoder.bitrate,
  ];
  if (encoder.id === "libopus") {
    args.push("-vbr", "off", "-application", "voip");
  }
  args.push(outputPath);
  return args;
}
