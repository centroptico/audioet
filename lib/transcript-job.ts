import { isSttModelKey, type SttModelKey } from "./config";

export type TranscriptJob = {
  speakers: boolean;
  timestamps: boolean;
  model: SttModelKey;
};

export const DEFAULT_JOB: TranscriptJob = {
  speakers: false,
  timestamps: false,
  model: "grok",
};

export function jobNeedsStructure(job: TranscriptJob): boolean {
  return job.speakers || job.timestamps;
}

export function jobFromParts(parts: {
  speakers?: unknown;
  timestamps?: unknown;
  model?: unknown;
}): TranscriptJob {
  const model = typeof parts.model === "string" && isSttModelKey(parts.model) ? parts.model : DEFAULT_JOB.model;
  return {
    speakers: parts.speakers === true,
    timestamps: parts.timestamps === true,
    model,
  };
}

export function flagOn(value: FormDataEntryValue | null): boolean {
  return value === "1" || value === "true";
}
