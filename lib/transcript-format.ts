export type TimedWord = {
  word: string;
  start: number;
  end: number;
  speaker?: number;
};

export type TimedSegment = {
  text: string;
  start: number;
  end: number;
  speaker?: number;
};

export type RenderInput = {
  words?: readonly TimedWord[];
  segments?: readonly TimedSegment[];
  fallback?: string;
  /** Seconds where this slice starts in the original file. */
  offset: number;
  /** Absolute time. Words that start earlier belong to the previous slice. */
  dropBefore: number;
  speakers: boolean;
  timestamps: boolean;
};

type Unit = {
  speaker: number | null;
  start: number;
  text: string;
};

const SENTENCE_END = /[.!?…]$/;
const SENTENCE_GAP = 1.2;
const TIMESTAMP_BLOCK_SECONDS = 30;

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `[${pad(hours)}:${pad(minutes)}:${pad(secs)}]`;
}

function speakerNumber(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function keepWord(start: number, offset: number, dropBefore: number): boolean {
  return start + offset >= dropBefore - 0.05;
}

function joinWords(words: readonly string[]): string {
  return words.join(" ").replace(/\s+/g, " ").trim();
}

function sentenceUnits(words: readonly TimedWord[], speakers: boolean): Unit[] {
  const units: Unit[] = [];
  let buffer: TimedWord[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const first = buffer[0];
    units.push({
      speaker: speakers ? speakerNumber(first.speaker) + 1 : null,
      start: first.start,
      text: joinWords(buffer.map((word) => word.word)),
    });
    buffer = [];
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const previous = buffer[buffer.length - 1];
    const speakerChanged =
      speakers && previous !== undefined && speakerNumber(previous.speaker) !== speakerNumber(word.speaker);
    if (speakerChanged) flush();
    buffer.push(word);
    const next = words[index + 1];
    const gap = next ? next.start - word.end : 0;
    const ended = SENTENCE_END.test(word.word.trim()) || gap > SENTENCE_GAP;
    const longBlock =
      !speakers && buffer[0] !== undefined && word.end - buffer[0].start >= TIMESTAMP_BLOCK_SECONDS;
    if (ended || longBlock) flush();
  }
  flush();
  return units;
}

function mergeSameSpeaker(units: readonly Unit[], speakers: boolean): Unit[] {
  if (!speakers) return [...units];
  const merged: Unit[] = [];
  for (const unit of units) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === unit.speaker) {
      last.text = `${last.text} ${unit.text}`.trim();
      continue;
    }
    merged.push({ ...unit });
  }
  return merged;
}

function renderUnits(units: readonly Unit[], speakers: boolean, timestamps: boolean): string {
  return units
    .filter((unit) => unit.text.trim())
    .map((unit) => {
      const stamp = timestamps ? `${formatTimestamp(unit.start)} ` : "";
      const who = speakers ? `Speaker ${unit.speaker ?? 1}: ` : "";
      return `${stamp}${who}${unit.text}`.trim();
    })
    .join("\n\n");
}

function wordsInWindow(words: readonly TimedWord[], offset: number, dropBefore: number): TimedWord[] {
  return words
    .filter((word) => word.word.trim() && Number.isFinite(word.start))
    .filter((word) => keepWord(word.start, offset, dropBefore))
    .map((word) => ({
      word: word.word.trim(),
      start: word.start + offset,
      end: (Number.isFinite(word.end) ? word.end : word.start) + offset,
      speaker: word.speaker,
    }));
}

function segmentsInWindow(
  segments: readonly TimedSegment[],
  offset: number,
  dropBefore: number,
): TimedSegment[] {
  return segments
    .filter((segment) => segment.text.trim() && Number.isFinite(segment.start))
    .filter((segment) => keepWord(segment.start, offset, dropBefore))
    .map((segment) => ({
      text: segment.text.trim(),
      start: segment.start + offset,
      end: (Number.isFinite(segment.end) ? segment.end : segment.start) + offset,
      speaker: segment.speaker,
    }));
}

/**
 * Turns timed words (or segments, if there are no words) into paragraphs.
 * Words stay internal: the same speaker's sentences become one paragraph,
 * and a timestamp, when requested, is written once per paragraph.
 */
export function renderTranscript(input: RenderInput): string {
  const words = wordsInWindow(input.words ?? [], input.offset, input.dropBefore);
  if (words.length > 0) {
    const units = mergeSameSpeaker(sentenceUnits(words, input.speakers), input.speakers);
    return renderUnits(units, input.speakers, input.timestamps);
  }

  const segments = segmentsInWindow(input.segments ?? [], input.offset, input.dropBefore);
  if (segments.length > 0) {
    const asWords: TimedWord[] = segments.map((segment) => ({
      word: segment.text,
      start: segment.start,
      end: segment.end,
      speaker: segment.speaker,
    }));
    const units = mergeSameSpeaker(sentenceUnits(asWords, input.speakers), input.speakers);
    return renderUnits(units, input.speakers, input.timestamps);
  }

  return (input.fallback ?? "").trim();
}
