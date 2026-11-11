// SEC EDGAR XBRL companyfacts -> compact fundamentals (PURE). The ~4 MB download runs in the runner
// with the declared SEC_USER_AGENT (fair-access policy). Public-domain data.
export const SEC_FACTS = (cik: string) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

interface Fact {
  start?: string;
  end: string;
  val: number;
  form?: string;
  filed?: string;
  fp?: string;
}

interface Series {
  tag: string;
  unit: string;
  items: Fact[];
}

type Facts = Record<string, Record<string, { units?: Record<string, Fact[]> }>>;

const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;

/** Pick, among candidate tags, the one whose most recent observation is the newest. */
function pick(facts: Facts, taxonomy: string, tags: string[], unitTest: (u: string) => boolean): Series | null {
  let best: Series | null = null;
  let bestEnd = "";
  for (const tag of tags) {
    const units = facts[taxonomy]?.[tag]?.units;
    if (!units) continue;
    for (const [unit, items] of Object.entries(units)) {
      if (!unitTest(unit) || !Array.isArray(items) || !items.length) continue;
      const end = items.reduce((m, x) => (x.end > m ? x.end : m), "");
      if (end > bestEnd) {
        bestEnd = end;
        best = { tag, unit, items };
      }
    }
  }
  return best;
}

/** Deduplicate by (start, end), keeping the most recently filed value. */
function dedupe(items: Fact[]): Fact[] {
  const m = new Map<string, Fact>();
  for (const x of items) {
    if (!Number.isFinite(x.val) || !x.end) continue;
    const k = `${x.start ?? ""}|${x.end}`;
    const cur = m.get(k);
    if (!cur || (x.filed ?? "") > (cur.filed ?? "")) m.set(k, x);
  }
  return [...m.values()];
}

interface Period {
  start: string;
  end: string;
  val: number;
  filed: string | null;
  form: string | null;
}

/** Discrete quarters: reported 3-month facts plus Q4 derived as FY - 9M YTD (same start). */
function quarters(items: Fact[]): Period[] {
  const d = dedupe(items).filter((x) => x.start);
  const out = new Map<string, Period>();
  for (const x of d) {
    const len = days(x.start as string, x.end);
    if (len >= 80 && len <= 100) out.set(x.end, { start: x.start as string, end: x.end, val: x.val, filed: x.filed ?? null, form: x.form ?? null });
  }
  for (const fy of d) {
    const len = days(fy.start as string, fy.end);
    if (len < 350 || len > 380) continue;
    const ytd9 = d.find((x) => x.start === fy.start && days(x.start as string, x.end) >= 260 && days(x.start as string, x.end) <= 285);
    if (!ytd9 || out.has(fy.end)) continue;
    const qStart = new Date(Date.parse(ytd9.end) + 86400000).toISOString().slice(0, 10);
    out.set(fy.end, { start: qStart, end: fy.end, val: fy.val - ytd9.val, filed: fy.filed ?? null, form: fy.form ?? null });
  }
  return [...out.values()].sort((a, b) => a.end.localeCompare(b.end));
}

function annuals(items: Fact[]): Period[] {
  return dedupe(items)
    .filter((x) => x.start && days(x.start, x.end) >= 350 && days(x.start, x.end) <= 380)
    .map((x) => ({ start: x.start as string, end: x.end, val: x.val, filed: x.filed ?? null, form: x.form ?? null }))
    .sort((a, b) => a.end.localeCompare(b.end));
}

/** Sum of 4 contiguous quarters ending at index i (null if there's a gap). */
function sum4(qs: Period[], i: number): number | null {
  if (i < 3) return null;
  let s = 0;
  for (let k = i - 3; k <= i; k++) {
    const q = qs[k] as Period;
    if (k > i - 3) {
      const gap = days((qs[k - 1] as Period).end, q.end);
      if (gap < 80 || gap > 100) return null;
    }
    s += q.val;
  }
  return s;
}

export interface Flow {
  ttm: number;
  prior: number | null;
  end: string;
  basis: "TTM" | "FY";
  filed: string | null;
  form: string | null;
}

/** Trailing-twelve-month value and the same window one year earlier (falls back to fiscal years). */
export function ttmOf(items: Fact[]): Flow | null {
  const qs = quarters(items);
  const fys = annuals(items);
  const lastFy = fys[fys.length - 1];
  const i = qs.length - 1;
  const q = qs[i];
  const t = sum4(qs, i);
  if (q && t !== null && (!lastFy || q.end >= lastFy.end)) {
    const target = Date.parse(q.end) - 365 * 86400000;
    const j = qs.findIndex((x) => Math.abs(Date.parse(x.end) - target) < 20 * 86400000);
    return { ttm: t, prior: j >= 0 ? sum4(qs, j) : null, end: q.end, basis: "TTM", filed: q.filed, form: q.form };
  }
  if (!lastFy) return null;
  const prev = fys[fys.length - 2];
  return { ttm: lastFy.val, prior: prev && Math.abs(days(prev.end, lastFy.end) - 365) < 20 ? prev.val : null, end: lastFy.end, basis: "FY", filed: lastFy.filed, form: lastFy.form };
}

function latestInstant(items: Fact[]): Fact | null {
  const d = dedupe(items).filter((x) => !x.start);
  return d.sort((a, b) => a.end.localeCompare(b.end))[d.length - 1] ?? null;
}

export interface SecFundamentals {
  entity: string;
  cik: string;
  currency: string; // reporting currency of the flows (USD, EUR ...)
  basis: "TTM" | "FY";
  periodEnd: string;
  filed: string | null;
  form: string | null;
  revenueTtm: number | null;
  revenueGrowthPct: number | null;
  netIncomeTtm: number | null;
  netMarginPct: number | null;
  epsTtm: number | null; // diluted, reporting currency
  epsGrowthPct: number | null;
  sharesOutstanding: number | null;
  sharesAsOf: string | null;
  debt: number | null;
  equity: number | null;
  debtToEquity: number | null;
  tags: Record<string, string>;
}

const growth = (a: number | null, b: number | null) => (a !== null && b !== null && b !== 0 ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null);

export function parseCompanyFacts(raw: unknown, cik: string): SecFundamentals {
  const r = raw as { entityName?: string; facts?: Facts };
  const f = r?.facts;
  if (!f || !f["us-gaap"]) throw new Error("sec: no us-gaap facts");
  const money = (u: string) => /^[A-Z]{3}$/.test(u);
  const perShare = (u: string) => /^[A-Z]{3}\/shares$/.test(u);
  const rev = pick(f, "us-gaap", ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"], money);
  const ni = pick(f, "us-gaap", ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"], money);
  const eps = pick(f, "us-gaap", ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic"], perShare);
  const eq = pick(f, "us-gaap", ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], money);
  const debtT = pick(f, "us-gaap", ["LongTermDebt", "LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"], money);
  const sh = pick(f, "dei", ["EntityCommonStockSharesOutstanding"], (u) => u === "shares") ?? pick(f, "us-gaap", ["WeightedAverageNumberOfDilutedSharesOutstanding"], (u) => u === "shares");

  const revF = rev ? ttmOf(rev.items) : null;
  const niF = ni ? ttmOf(ni.items) : null;
  const epsF = eps ? ttmOf(eps.items) : null;
  const eqI = eq ? latestInstant(eq.items) : null;
  const dI = debtT ? latestInstant(debtT.items) : null;
  const shI = sh ? (latestInstant(sh.items) ?? dedupe(sh.items).sort((a, b) => a.end.localeCompare(b.end)).pop() ?? null) : null;
  const ref = revF ?? niF;
  if (!ref) throw new Error("sec: no revenue or net income series");
  const tags: Record<string, string> = {};
  for (const [k, s] of Object.entries({ revenue: rev, netIncome: ni, eps, equity: eq, debt: debtT, shares: sh })) if (s) tags[k] = `${s.tag} (${s.unit})`;
  // only compare flows that end on the same period
  const niAligned = niF && revF && niF.end === revF.end ? niF : null;
  const equity = eqI ? eqI.val : null;
  const debt = dI ? dI.val : null;
  return {
    entity: String(r.entityName ?? ""),
    cik,
    currency: rev?.unit ?? ni?.unit ?? "USD",
    basis: ref.basis,
    periodEnd: ref.end,
    filed: ref.filed,
    form: ref.form,
    revenueTtm: revF?.ttm ?? null,
    revenueGrowthPct: revF ? growth(revF.ttm, revF.prior) : null,
    netIncomeTtm: niF?.ttm ?? null,
    netMarginPct: niAligned && revF && revF.ttm > 0 ? Math.round((niAligned.ttm / revF.ttm) * 1000) / 10 : null,
    epsTtm: epsF ? Math.round(epsF.ttm * 100) / 100 : null,
    epsGrowthPct: epsF ? growth(epsF.ttm, epsF.prior) : null,
    sharesOutstanding: shI ? shI.val : null,
    sharesAsOf: shI ? shI.end : null,
    debt,
    equity,
    debtToEquity: debt !== null && equity !== null && equity > 0 ? Math.round((debt / equity) * 100) / 100 : null,
    tags,
  };
}
