export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** At least four decimals, up to six, with a Spanish comma. */
export function formatUsd(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const negative = safe < 0;
  const [whole, rawFrac] = Math.abs(safe).toFixed(6).split(".");
  let frac = rawFrac.replace(/0+$/, "");
  if (frac.length < 4) frac = frac.padEnd(4, "0");
  return `${negative ? "-" : ""}US$${groupThousands(whole)},${frac}`;
}

export function formatBilledMinutes(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const [whole, frac] = (safe / 60).toFixed(1).split(".");
  return `${groupThousands(whole)},${frac} min de audio`;
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return secs > 0 ? `${minutes} min ${secs} s` : `${minutes} min`;
  return `${secs} s`;
}
