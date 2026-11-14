const WORD_SPLIT = /\s+/;

/** Compare words ignoring case and punctuation glued to the edges. */
export function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Join two transcript pieces. If the start of `next` repeats the end of
 * `previous` by at least `minWords`, drop that repeated prefix.
 * Shorter matches are ignored so common pairs ("de la") don't get eaten.
 */
export function mergeTranscripts(
  previous: string,
  next: string,
  minWords = 4,
  window = 80,
): string {
  const left = previous.trim();
  const right = next.trim();
  if (!left) return right;
  if (!right) return left;

  const a = left.split(WORD_SPLIT);
  const b = right.split(WORD_SPLIT);
  const max = Math.min(window, a.length, b.length);
  let overlap = 0;
  for (let size = max; size >= minWords; size -= 1) {
    let same = true;
    for (let i = 0; i < size; i += 1) {
      if (normalizeWord(a[a.length - size + i] ?? "") !== normalizeWord(b[i] ?? "")) {
        same = false;
        break;
      }
    }
    if (same) {
      overlap = size;
      break;
    }
  }

  if (overlap === 0) return `${left} ${right}`;
  if (overlap >= b.length) return left;
  return `${left} ${b.slice(overlap).join(" ")}`;
}

export function joinTranscripts(parts: readonly string[]): string {
  return parts.reduce((accumulated, part) => mergeTranscripts(accumulated, part), "");
}
