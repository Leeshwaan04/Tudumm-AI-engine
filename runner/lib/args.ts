export interface Args {
  job: string;
  remote: boolean;
  persistTo: string | null;
  config: string | null;
  ingestUrl: string | null;
  date: string | null; // YYYYMMDD
  backfill: number;
  noEngine: boolean;
  dryRun: boolean;
  forceSec: boolean;
  concurrency: number;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { job: "", remote: false, persistTo: null, config: null, ingestUrl: null, date: null, backfill: 0, noEngine: false, dryRun: false, forceSec: false, concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i] as string;
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${x} needs a value`);
      return v;
    };
    if (x === "--remote") a.remote = true;
    else if (x === "--local") a.remote = false;
    else if (x === "--persist-to") a.persistTo = val();
    else if (x === "--config" || x === "-c") a.config = val();
    else if (x === "--ingest-url") a.ingestUrl = val();
    else if (x === "--date") a.date = val();
    else if (x === "--backfill") a.backfill = Number(val());
    else if (x === "--concurrency") a.concurrency = Math.max(1, Math.min(4, Number(val())));
    else if (x === "--no-engine") a.noEngine = true;
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--force-sec") a.forceSec = true;
    else if (!x.startsWith("-") && !a.job) a.job = x;
    else throw new Error(`unknown argument ${x}`);
  }
  if (a.date && !/^\d{8}$/.test(a.date)) throw new Error("--date must be YYYYMMDD");
  if (!Number.isInteger(a.backfill) || a.backfill < 0 || a.backfill > 400) throw new Error("--backfill must be 0..400");
  if (a.ingestUrl && !/^https?:\/\//.test(a.ingestUrl)) throw new Error("--ingest-url must be http(s)");
  if (a.remote && a.persistTo) throw new Error("--persist-to only applies to --local");
  return a;
}
