// Logging without PII: only a component tag, an error class/message from OUR code paths and
// optional non-identifying counters. Never pass emails, tokens, IPs or request bodies here.
export function logError(where: string, err: unknown, meta?: Record<string, string | number | boolean>): void {
  const e = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // D1/driver messages can echo SQL but never bound values; still cap the length.
  console.error(JSON.stringify({ level: "error", where, error: e.slice(0, 300), ...(meta ?? {}) }));
}

export function logInfo(where: string, meta: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ level: "info", where, ...meta }));
}
