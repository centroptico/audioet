/** Allow curl (no Origin) and same-host browser calls. Reject other websites. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = request.headers.get("x-forwarded-host");
  const host = (forwarded || request.headers.get("host") || new URL(request.url).host)
    .split(",")[0]
    ?.trim();
  return Boolean(host) && originHost === host;
}
