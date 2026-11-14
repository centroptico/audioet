export class TranscribeRequestError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "TranscribeRequestError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type FailureKind = "retry" | "split" | "fatal";

/**
 * 413/408/504 mean this slice is too large or too slow: cut it in half.
 * 429 and transient 5xx are worth backing off and repeating as-is.
 */
export function classifyStatus(status: number): FailureKind {
  if (status === 408 || status === 413 || status === 504 || status === 524) return "split";
  if (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 529 ||
    status >= 500
  ) {
    return "retry";
  }
  return "fatal";
}

export function backoffMs(failedAttempts: number): number {
  const base = 1000 * 2 ** Math.max(0, failedAttempts);
  return Math.min(base, 16_000);
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), 30_000);
  return undefined;
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "Error desconocido";
}
