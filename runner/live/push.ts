// POST /api/internal/ingest (Bearer INGEST_TOKEN) with bounded bodies, a timeout and a short retry.
import type { CandleRow, QuoteRow, SnapshotRow, SourceId } from "../../worker/src/market/types.ts";

export interface IngestBody {
  job: string; // /^[a-z-]{2,20}$/
  candles?: CandleRow[];
  quotes?: QuoteRow[];
  snapshots?: SnapshotRow[];
  health?: { source: SourceId; ok: boolean; error: string | null }[];
  runEngine?: string[];
  lifecycle?: boolean;
}

export interface IngestResult {
  ok: boolean;
  engine?: { evaluated?: string[]; issued?: string[]; transitions?: { symbol: string; type: string; outcome?: string }[] } | null;
}

export class Ingest {
  private url: string;
  private token: string;
  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  async send(body: IngestBody, tries = 3): Promise<IngestResult> {
    // keep each request well under the Worker's limits (quotes <= 50, snapshots <= 50, < 1 MB)
    const quotes = body.quotes ?? [];
    if (quotes.length > 50) throw new Error("ingest: more than 50 quotes in one push");
    let last: unknown = null;
    for (let k = 0; k < tries; k++) {
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        if (res.status === 400 || res.status === 401 || res.status === 413 || res.status === 415) throw new Fatal(`ingest ${res.status}: ${text.slice(0, 300)}`);
        if (!res.ok) throw new Error(`ingest ${res.status}: ${text.slice(0, 200)}`);
        return JSON.parse(text) as IngestResult;
      } catch (e) {
        if (e instanceof Fatal) throw e;
        last = e;
        await new Promise((r) => setTimeout(r, 1000 * (k + 1)));
      }
    }
    throw last instanceof Error ? last : new Error("ingest failed");
  }

  /** Large backfills: candles in chunks, then the rest. */
  async sendChunked(job: string, candles: CandleRow[], rest: Omit<IngestBody, "job" | "candles">): Promise<IngestResult> {
    for (let i = 0; i < candles.length; i += 1500) await this.send({ job, candles: candles.slice(i, i + 1500) });
    const snaps = rest.snapshots ?? [];
    for (let i = 0; i < snaps.length; i += 8) await this.send({ job, snapshots: snaps.slice(i, i + 8) });
    return this.send({ job, quotes: rest.quotes, health: rest.health, runEngine: rest.runEngine, lifecycle: rest.lifecycle });
  }
}

class Fatal extends Error {}
