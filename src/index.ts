interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Moldova Government Procurement (MTender) MCP — keyless.
 *
 * Wraps the public, no-auth MTender OCDS API at https://public.mtender.gov.md.
 * MTender is Moldova's national e-procurement platform; it publishes tenders as
 * Open Contracting Data Standard (OCDS) record packages.
 *
 * The feed `GET /tenders` is a forward, oldest-first cursor over every ocid,
 * paginated by an `offset` TIMESTAMP (100 ids per page); each response echoes the
 * next `offset`. History goes back to 2018, so to surface the NEWEST tenders we
 * seed the offset a few days in the past and walk forward to the tail (the page
 * before "now"). Detail is `GET /tenders/{ocid}`, which returns an OCDS record
 * package (records[0].compiledRelease).
 *
 * All tools return shaped, LLM-friendly objects (English keys; Moldovan/Romanian
 * text preserved in values) and never throw — failures resolve to { error }.
 */


const BASE = 'https://public.mtender.gov.md';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'moldova_recent_tenders',
    description:
      "Most recent government procurement tenders from Moldova's national e-procurement platform (MTender), published as Open Contracting (OCDS) data. Returns each tender with ocid, title, buyer (procuring entity), value + currency (MDL), status, CPV classification, and publication/period dates. Titles and descriptions are in Romanian. Use moldova_get_tender for the full detail of one tender.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: ['number', 'string'], description: 'How many recent tenders to return (1–50). Default 20.' },
      },
    },
  },
  {
    name: 'moldova_get_tender',
    description:
      "Full detail for a single Moldova (MTender) government procurement tender by its OCDS contracting id (ocid, e.g. \"ocds-b3wdp1-MD-1539840280133\"). Returns title, description, buyer/procuring entity, value + currency, status, procurement method and category, CPV classification, tender period dates, budget, and parties. Get an ocid from moldova_recent_tenders or moldova_search_tenders.",
    inputSchema: {
      type: 'object',
      properties: {
        ocid: { type: 'string', description: 'OCDS contracting id, e.g. "ocds-b3wdp1-MD-1539840280133".' },
      },
      required: ['ocid'],
    },
  },
  {
    name: 'moldova_search_tenders',
    description:
      "Keyword search over recent Moldova (MTender) government procurement tenders. Scans the most recent tenders and returns those whose title, buyer, or CPV description contains the query (case-insensitive; Romanian text). Note: this is a client-side filter over recent tenders (MTender has no native full-text search), so it matches recent listings only. Returns shaped tenders like moldova_recent_tenders.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to match against title / buyer / CPV description (e.g. "medicamente", "construc", "computer").' },
        limit: { type: ['number', 'string'], description: 'Max matches to return (1–50). Default 20.' },
        scan: { type: ['number', 'string'], description: 'How many recent tenders to scan for matches (50–500). Default 200. Higher = more thorough but slower.' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'moldova_recent_tenders':
        return await recentTenders(args);
      case 'moldova_get_tender':
        return await getTender(args);
      case 'moldova_search_tenders':
        return await searchTenders(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

interface FeedEntry {
  ocid: string;
  date: string;
}

/**
 * Return the newest `count` feed entries, newest-first. The feed is oldest-first
 * and paged by an `offset` timestamp, so we seed the offset a few days back and
 * walk FORWARD to the tail (each response echoes the next `offset`; the tail is a
 * page with < 100 entries and/or no next offset). We widen the look-back window
 * on retry if a quiet period yields nothing.
 */
async function fetchNewest(count: number): Promise<FeedEntry[]> {
  const MAX_PAGES = 12; // safety cap on forward walk (each page = 100 ids)
  for (const lookbackDays of [3, 10, 45, 180]) {
    const seed = new Date(Date.now() - lookbackDays * 86400_000).toISOString();
    let offset: string | undefined = seed;
    const collected: FeedEntry[] = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const qs = offset ? `?offset=${encodeURIComponent(offset)}` : '';
      const page = (await mtGet(`/tenders${qs}`)) as { data?: FeedEntry[]; offset?: string };
      const data = page.data ?? [];
      collected.push(...data);
      if (!page.offset || data.length < 100) break; // reached the tail / "now"
      offset = page.offset;
    }
    const sorted = collected
      .filter((e) => e && e.ocid)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (sorted.length) return sorted.slice(0, count);
  }
  return [];
}

async function recentTenders(args: Record<string, unknown>): Promise<unknown> {
  const limit = clampInt(args.limit, 20, 1, 50);
  const feed = await fetchNewest(limit);
  const tenders = await Promise.all(feed.map((e) => shapeSummary(e.ocid).catch(() => ({ ocid: e.ocid, date: e.date, error: 'detail fetch failed' }))));
  return { count: tenders.length, source: 'MTender (mtender.gov.md) OCDS feed', tenders };
}

async function getTender(args: Record<string, unknown>): Promise<unknown> {
  const ocid = strArg(args.ocid);
  if (!ocid) throw new Error('moldova_get_tender requires "ocid" — an OCDS id like "ocds-b3wdp1-MD-1539840280133". Get one from moldova_recent_tenders.');
  const cr = await fetchCompiledRelease(ocid);
  if (!cr) return { error: 'tender not found', ocid };
  return shapeFull(cr);
}

async function searchTenders(args: Record<string, unknown>): Promise<unknown> {
  const query = strArg(args.query);
  if (!query) throw new Error('moldova_search_tenders requires "query" — a keyword like "medicamente".');
  const limit = clampInt(args.limit, 20, 1, 50);
  const scan = clampInt(args.scan, 200, 50, 500);
  const q = query.toLowerCase();
  const feed = await fetchNewest(scan);
  const shaped = await Promise.all(feed.map((e) => shapeSummary(e.ocid).catch(() => null)));
  const matches = shaped
    .filter((t): t is Record<string, unknown> => !!t)
    .filter((t) => {
      const hay = [t.title, t.buyer, t.cpv_description].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    })
    .slice(0, limit);
  return {
    query,
    scanned: feed.length,
    count: matches.length,
    note: 'Client-side keyword filter over recent MTender tenders (no native full-text search). Titles/buyers are in Romanian.',
    tenders: matches,
  };
}

async function fetchCompiledRelease(ocid: string): Promise<Record<string, any> | null> {
  const pkg = (await mtGet(`/tenders/${encodeURIComponent(ocid)}`)) as { records?: any[] };
  const cr = pkg.records?.[0]?.compiledRelease;
  return cr ?? null;
}

// Compact summary used by list/search tools.
async function shapeSummary(ocid: string): Promise<Record<string, unknown>> {
  const cr = await fetchCompiledRelease(ocid);
  if (!cr) return { ocid, error: 'not found' };
  const t = cr.tender ?? {};
  const value = t.value ?? cr.planning?.budget?.amount;
  return {
    ocid: cr.ocid ?? ocid,
    title: t.title ?? null,
    buyer: t.procuringEntity?.name ?? cr.buyer?.name ?? firstPartyName(cr) ?? null,
    value: value?.amount ?? null,
    currency: value?.currency ?? null,
    status: t.status ?? null,
    cpv: t.classification?.scheme === 'CPV' ? t.classification?.id : t.classification?.id ?? null,
    cpv_description: t.classification?.description ?? null,
    date: cr.date ?? null,
  };
}

// Full detail used by moldova_get_tender.
function shapeFull(cr: Record<string, any>): Record<string, unknown> {
  const t = cr.tender ?? {};
  const value = t.value ?? cr.planning?.budget?.amount;
  const items = Array.isArray(t.items)
    ? t.items.map((it: any) => ({
        id: it.id,
        description: it.description,
        quantity: it.quantity,
        unit: it.unit?.name,
        cpv: it.classification?.id,
        cpv_description: it.classification?.description,
      }))
    : [];
  return {
    ocid: cr.ocid,
    title: t.title ?? null,
    description: t.description ?? null,
    buyer: t.procuringEntity?.name ?? cr.buyer?.name ?? firstPartyName(cr) ?? null,
    buyer_id: t.procuringEntity?.id ?? null,
    value: value ? { amount: value.amount ?? null, currency: value.currency ?? null } : null,
    status: t.status ?? null,
    status_details: t.statusDetails ?? null,
    procurement_method: t.procurementMethodDetails ?? t.procurementMethod ?? null,
    procurement_category: t.mainProcurementCategory ?? null,
    cpv: t.classification?.id ?? null,
    cpv_description: t.classification?.description ?? null,
    tender_period: t.tenderPeriod ? { start: t.tenderPeriod.startDate ?? null, end: t.tenderPeriod.endDate ?? null } : null,
    enquiry_period: t.enquiryPeriod ? { start: t.enquiryPeriod.startDate ?? null, end: t.enquiryPeriod.endDate ?? null } : null,
    budget: cr.planning?.budget?.amount
      ? {
          amount: cr.planning.budget.amount.amount ?? null,
          currency: cr.planning.budget.amount.currency ?? null,
          eu_funded: cr.planning.budget.isEuropeanUnionFunded ?? null,
        }
      : null,
    items_count: items.length,
    items,
    parties: Array.isArray(cr.parties)
      ? cr.parties.map((p: any) => ({ name: p.name, id: p.id, roles: p.roles }))
      : [],
    published: cr.date ?? null,
    source_url: `${BASE}/tenders/${cr.ocid}`,
  };
}

function firstPartyName(cr: Record<string, any>): string | undefined {
  return Array.isArray(cr.parties) && cr.parties.length ? cr.parties[0]?.name : undefined;
}

async function mtGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MTender API: ${res.status} ${text.slice(0, 200)}`.trim());
  }
  if (!text.trim()) return { data: [] }; // MTender occasionally returns an empty body at a cursor edge
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`MTender API: invalid JSON for ${path}`);
  }
}

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  return undefined;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  let n = def;
  if (typeof v === 'number' && Number.isFinite(v)) n = Math.floor(v);
  else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) n = Math.floor(Number(v));
  return Math.max(min, Math.min(max, n));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
