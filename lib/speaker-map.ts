export type SpeakerExcerpt = {
  index: number;
  speakers: Array<{
    label: string;
    first: string;
    last: string;
    hints: string[];
  }>;
};

export type SpeakerMap = Record<string, string>;

const LABEL = /^(?:\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] )?Speaker (\d+): ([\s\S]*)$/;
const HINT = /\b(soy|me llamo|mi nombre(?: es)?|habla|te habla)\b/i;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} .'\u2019-]{0,39}$/u;

function clip(text: string, max = 320): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max).trim();
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Compact, per-chunk view: first line, last line, and lines that may reveal a name. */
export function excerptsFromChunks(chunks: readonly { index: number; text: string }[]): SpeakerExcerpt[] {
  return chunks
    .map((chunk) => {
      const grouped = new Map<string, string[]>();
      for (const paragraph of paragraphsOf(chunk.text)) {
        const match = paragraph.match(LABEL);
        if (!match) continue;
        const label = `Speaker ${match[1]}`;
        const body = match[2]?.trim() ?? "";
        if (!body) continue;
        const list = grouped.get(label) ?? [];
        list.push(body);
        grouped.set(label, list);
      }
      const speakers = [...grouped.entries()].map(([label, lines]) => ({
        label,
        first: clip(lines[0] ?? ""),
        last: clip(lines[lines.length - 1] ?? ""),
        hints: lines.filter((line) => HINT.test(line)).slice(0, 3).map((line) => clip(line, 220)),
      }));
      return { index: chunk.index, speakers };
    })
    .filter((chunk) => chunk.speakers.length > 0);
}

export function isSpeakerName(value: string): boolean {
  const trimmed = value.trim();
  if (!NAME.test(trimmed)) return false;
  return trimmed.split(/\s+/).length <= 4;
}

/** Keeps only short labels. Anything else is ignored so the model cannot rewrite speech. */
export function sanitizeSpeakerMaps(value: unknown, chunkCount: number): SpeakerMap[] | null {
  if (!value || typeof value !== "object") return null;
  const chunks = (value as { chunks?: unknown }).chunks;
  if (!Array.isArray(chunks)) return null;
  const maps: SpeakerMap[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const entry = chunks[index];
    const map: SpeakerMap = {};
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      for (const [key, raw] of Object.entries(entry)) {
        if (!/^Speaker \d+$/.test(key)) continue;
        if (typeof raw !== "string" || !isSpeakerName(raw)) continue;
        map[key] = raw.trim();
      }
    }
    maps.push(map);
  }
  return maps;
}

export function parseSpeakerContent(content: string, chunkCount: number): SpeakerMap[] | null {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return sanitizeSpeakerMaps(JSON.parse(trimmed), chunkCount);
  } catch {
    return null;
  }
}

/** Replaces the paragraph label only. The words after the colon stay as they were. */
export function applySpeakerMap(text: string, map: SpeakerMap): string {
  return text.replace(
    /^(\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] )?Speaker (\d+):/gm,
    (full, stamp: string | undefined, num: string) => {
      const next = map[`Speaker ${num}`];
      if (!next) return full;
      return `${stamp ?? ""}${next}:`;
    },
  );
}
