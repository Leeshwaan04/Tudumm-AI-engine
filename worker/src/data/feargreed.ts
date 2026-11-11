// Alternative.me Crypto Fear & Greed Index (daily). Pure parser + fetcher.
import { getJson } from "./http";

export const FNG_URL = "https://api.alternative.me/fng/?limit=30";

export interface FngPoint {
  value: number;
  label: string;
  t: number; // unix seconds (day)
}

export function parseFng(raw: unknown): FngPoint[] {
  const r = raw as { data?: { value?: string; value_classification?: string; timestamp?: string }[] };
  if (!Array.isArray(r?.data) || !r.data.length) throw new Error("fng: bad payload");
  return r.data
    .map((d) => ({ value: Number(d.value), label: String(d.value_classification ?? ""), t: Number(d.timestamp) }))
    .filter((p) => Number.isFinite(p.value) && p.value >= 0 && p.value <= 100 && Number.isFinite(p.t))
    .sort((a, b) => b.t - a.t); // newest first
}

export const fetchFng = async () => parseFng(await getJson(FNG_URL, { timeoutMs: 6000 }));
