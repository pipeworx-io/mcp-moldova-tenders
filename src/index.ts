interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Moldova Government Procurement');
}

const BASE = 'https://public.mtender.gov.md';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'moldova_recent_tenders',
    description:
      "Most recent government procurement tenders from Moldova's national e-procurement platform (MTender), published as Open Contracting (OCDS) data. Returns each tender with ocid, title, buyer (procuring entity), value + currency (MDL — the ORIGINAL ASKING PRICE, not necessarily spent), award_value/award_currency (the amount actually awarded, when the process has reached that stage), status, an `interpretation` line stating plainly whether the value was ever spent, CPV classification, and publication/period dates. Titles and descriptions are in Romanian. Use moldova_get_tender for the full award/contract detail of one tender.",
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
      "Full detail for a single Moldova (MTender) government procurement tender by its OCDS contracting id (ocid, e.g. \"ocds-b3wdp1-MD-1539840280133\"). Returns title, description, buyer/procuring entity, status, an `interpretation` line stating plainly whether tender_value was ever spent, tender_value (the ORIGINAL ASKING PRICE — not money spent), procurement method and category, CPV classification, tender period dates, budget, parties, and the OCDS award stage: `award` (the operative award — status, date, value, winning supplier, and a reason when nothing was awarded; null when no award has happened) plus the full `awards` history across every lot. Get an ocid from moldova_recent_tenders or moldova_search_tenders.",
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
async function fetchNewest(count: number, deadlineAt = Infinity): Promise<FeedEntry[]> {
  const MAX_PAGES = 12; // safety cap on forward walk (each page = 100 ids)
  // Start at ONE day, not three. The walk is sequential and its cost is driven
  // entirely by how many pages sit between the seed and "now" — the `count`
  // argument does not reduce it, because the newest entries are at the TAIL, so
  // we always have to walk to the end. Measured 2026-08-28: a 3-day seed cost
  // ~28 SECONDS even for `moldova_recent_tenders {limit: 3}`, which is most of
  // the request budget spent before a single tender is fetched. A 1-day seed is
  // usually one or two pages; the existing widening fallback still covers a
  // quiet period, so nothing is lost when Moldova publishes little.
  for (const lookbackDays of [1, 3, 10, 45, 180]) {
    if (Date.now() >= deadlineAt) break;
    const seed = new Date(Date.now() - lookbackDays * 86400_000).toISOString();
    let offset: string | undefined = seed;
    const collected: FeedEntry[] = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const qs = offset ? `?offset=${encodeURIComponent(offset)}` : '';
      const page = (await mtGet(`/tenders${qs}`)) as { data?: FeedEntry[]; offset?: string };
      const data = page.data ?? [];
      collected.push(...data);
      if (!page.offset || data.length < 100) break; // reached the tail / "now"
      // Out of time mid-walk: keep what we have rather than discarding the
      // whole window. These are the oldest entries in the window, so callers
      // get a real answer instead of nothing.
      if (Date.now() >= deadlineAt) break;
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
  // This tool was taking ~28s before the shorter seed landed — inside the limit,
  // so nothing ever flagged it, but one slow day upstream would have tipped it
  // into the same timeout search was already dying of. Bound it explicitly.
  const feed = await fetchNewest(limit, Date.now() + 15_000);
  const tenders = await Promise.all(feed.map((e) => shapeSummary(e.ocid).catch(() => ({ ocid: e.ocid, date: e.date, error: 'detail fetch failed' }))));
  return { count: tenders.length, source: 'MTender (mtender.gov.md) OCDS feed', tenders };
}

async function getTender(args: Record<string, unknown>): Promise<unknown> {
  const ocid = strArg(args.ocid);
  if (!ocid) throw new Error('moldova_get_tender requires "ocid" — an OCDS id like "ocds-b3wdp1-MD-1539840280133". Get one from moldova_recent_tenders.');
  const pkg = await fetchTenderPackage(ocid);
  if (!pkg) return { error: 'tender not found', ocid };
  return shapeFull(pkg.main, pkg.awards);
}

/**
 * Fetch summaries with bounded concurrency and a wall-clock deadline.
 *
 * The MTender feed carries only {ocid, date} — no title — so filtering by
 * keyword requires fetching each tender's detail. The previous version did that
 * as one `Promise.all` over the whole scan window: **200 simultaneous requests
 * to mtender.gov.md**, which blew the request budget. Measured 2026-08-28,
 * `moldova_search_tenders` timed out at 45s on every call.
 *
 * Correction to a first reading of this bug: the fan-out was NOT the whole
 * story, and `moldova_recent_tenders` was not actually healthy. Timed after the
 * concurrency fix, `recent_tenders {limit: 3}` still took **27.9 seconds** — the
 * sequential feed walk in `fetchNewest` was eating nearly the entire budget on
 * its own, for every tool in this pack. It only ever LOOKED fine because it
 * finished just inside the limit while search did not. Both halves are fixed:
 * bounded concurrency here, and a shorter default seed plus a deadline in
 * `fetchNewest`.
 *
 * Stopping at a deadline and saying how far we got beats timing out with
 * nothing: a partial answer is useful and an honest `scanned` count tells the
 * caller whether to narrow the query or raise `scan`.
 */
async function shapeMany(
  entries: FeedEntry[],
  deadlineAt: number,
  concurrency = 8,
): Promise<{ shaped: Record<string, unknown>[]; scanned: number; timedOut: boolean }> {
  const shaped: Record<string, unknown>[] = [];
  let next = 0;
  let timedOut = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (Date.now() >= deadlineAt) { timedOut = true; return; }
      const i = next++;
      if (i >= entries.length) return;
      const t = await shapeSummary(entries[i].ocid).catch(() => null);
      if (t) shaped.push(t);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return { shaped, scanned: shaped.length, timedOut };
}

async function searchTenders(args: Record<string, unknown>): Promise<unknown> {
  const query = strArg(args.query);
  if (!query) throw new Error('moldova_search_tenders requires "query" — a keyword like "medicamente".');
  const limit = clampInt(args.limit, 20, 1, 50);
  const scan = clampInt(args.scan, 200, 50, 500);
  const q = query.toLowerCase();
  // Leave headroom inside the gateway's request budget for the feed walk that
  // already happened plus serialising the response.
  const deadlineAt = Date.now() + 25_000;
  // Cap the feed walk at half the budget so detail fetching always gets a turn.
  const feed = await fetchNewest(scan, Date.now() + 12_000);
  const { shaped, scanned, timedOut } = await shapeMany(feed, deadlineAt);
  const matches = shaped
    .filter((t) => {
      const hay = [t.title, t.buyer, t.cpv_description].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    })
    .slice(0, limit);
  const note = timedOut
    ? `Client-side keyword filter over recent MTender tenders (no native full-text search). Titles/buyers are in Romanian. ` +
      `Stopped early at the time budget after scanning ${scanned} of ${feed.length} requested — these are the newest ones, ` +
      `so results are complete for the most recent tenders but may miss older matches. Lower "scan" for a faster, fully-scanned window.`
    : 'Client-side keyword filter over recent MTender tenders (no native full-text search). Titles/buyers are in Romanian.';
  return {
    query,
    scanned,
    requested_scan: feed.length,
    complete: !timedOut,
    count: matches.length,
    note,
    tenders: matches,
  };
}

// MTender's /tenders/{ocid} does NOT return one merged "compiled" release for
// the process. It returns a `records` array — one entry per OCDS sub-process
// (planning notice "-PN-…", the main tender, an evaluation stage "-EV-…", a
// contract stage, etc.) — each with its OWN `ocid`. The previous code took
// `records[0]` unconditionally, which is very often the PLANNING NOTICE, not
// the tender itself: it can carry a stale/copied `tender.status` (we observed
// a planning-notice record reporting status "complete" while the real,
// simultaneously-returned tender record was "unsuccessful"), and it never has
// award data. Meanwhile the awards for a process live on a DIFFERENT sibling
// record (tag "tenderCancellation" or similar evaluation-stage tag), which
// this endpoint already returns in the SAME response — it was just never read.
// Fixed 2026-09 (fleet #1166): pick the record whose `ocid` exactly matches
// the one requested (falling back to a `tag: ["compiled"]` record, then
// records[0] if neither exists) as the authoritative tender, and union
// `awards` across every sibling record in the package.
async function fetchTenderPackage(ocid: string): Promise<{ main: Record<string, any>; awards: any[] } | null> {
  const pkg = (await mtGet(`/tenders/${encodeURIComponent(ocid)}`)) as { records?: any[] };
  const records = pkg.records ?? [];
  if (!records.length) return null;
  let exact: Record<string, any> | undefined;
  let tagged: Record<string, any> | undefined;
  const awards: any[] = [];
  for (const r of records) {
    const cr = r?.compiledRelease;
    if (!cr) continue;
    if (cr.ocid === ocid) exact = cr;
    else if (!tagged && Array.isArray(cr.tag) && cr.tag.includes('compiled')) tagged = cr;
    if (Array.isArray(cr.awards)) awards.push(...cr.awards);
  }
  const main = exact ?? tagged ?? records[0]?.compiledRelease;
  if (!main) return null;
  return { main, awards };
}

// The operative award: the currently ACTIVE one if any (an award can be
// cancelled/unsuccessful and superseded by a later one on the same lot),
// else the most recent attempt so a caller can see why nothing was awarded.
function pickOperativeAward(awards: any[]): any | null {
  if (!awards.length) return null;
  return awards.find((a) => a?.status === 'active') ?? awards[awards.length - 1];
}

function shapeAward(a: any): Record<string, unknown> {
  const supplier = Array.isArray(a?.suppliers) ? a.suppliers[0] : undefined;
  return {
    id: a?.id ?? null,
    status: a?.status ?? null, // pending | active | cancelled | unsuccessful
    date: a?.date ?? null,
    value: a?.value ? { amount: a.value.amount ?? null, currency: a.value.currency ?? null } : null,
    supplier: supplier ? { name: supplier.name ?? null, id: supplier.id ?? null } : null,
    // Why there is no active award, when applicable — present on non-active
    // awards (e.g. "Other reasons (discontinuation of procedure)"), absent
    // on an active one.
    reason: a?.status !== 'active' ? (a?.description ?? a?.title ?? null) : undefined,
  };
}

// OCDS lifecycle: a tender is proposed, then awarded, then contracted — the
// money only actually moves at the award/contract stage. Reading only the
// tender-stage value conflates "asked for" with "spent": a cancelled or
// unsuccessful tender still carries a fully populated tender value even
// though zero money moved.
function statusInterpretation(status: string | undefined | null): string {
  switch (status) {
    case 'cancelled':
      return 'Tender CANCELLED before any award — no money was ever committed. value/currency above is the original asking price, not spend.';
    case 'unsuccessful':
      return 'Tender UNSUCCESSFUL — no qualifying offer; no award, no contract, no money spent. value/currency above is the original asking price, not spend.';
    case 'complete':
      return 'Tender COMPLETE — see award for the amount actually spent and to whom; it can differ from the tender value.';
    case 'active':
      return 'Tender still IN PROGRESS — no final award yet. value/currency above is the asking price, not a settled amount.';
    case 'planning':
      return 'Tender still in PLANNING — not yet published for bids. No award or spend exists yet.';
    default:
      return '';
  }
}

// Compact summary used by list/search tools.
async function shapeSummary(ocid: string): Promise<Record<string, unknown>> {
  const pkg = await fetchTenderPackage(ocid);
  if (!pkg) return { ocid, error: 'not found' };
  const cr = pkg.main;
  const t = cr.tender ?? {};
  const value = t.value ?? cr.planning?.budget?.amount;
  const award = pickOperativeAward(pkg.awards);
  return {
    ocid: cr.ocid ?? ocid,
    title: t.title ?? null,
    buyer: t.procuringEntity?.name ?? cr.buyer?.name ?? firstPartyName(cr) ?? null,
    value: value?.amount ?? null,
    currency: value?.currency ?? null,
    status: t.status ?? null,
    interpretation: statusInterpretation(t.status),
    award_value: award?.value?.amount ?? null,
    award_currency: award?.value?.currency ?? null,
    cpv: t.classification?.scheme === 'CPV' ? t.classification?.id : t.classification?.id ?? null,
    cpv_description: t.classification?.description ?? null,
    date: cr.date ?? null,
  };
}

// Full detail used by moldova_get_tender.
function shapeFull(cr: Record<string, any>, awards: any[]): Record<string, unknown> {
  const t = cr.tender ?? {};
  const value = t.value ?? cr.planning?.budget?.amount;
  const award = pickOperativeAward(awards);
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
    status: t.status ?? null,
    status_details: t.statusDetails ?? null,
    interpretation: statusInterpretation(t.status),
    // The ORIGINAL ASKING PRICE at tender/planning stage — not what was
    // spent. See `award` below for the amount actually committed.
    tender_value: value ? { amount: value.amount ?? null, currency: value.currency ?? null } : null,
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
    // The operative award — the ACTIVE one if any, else the most recent
    // attempt. Explicitly null — never omitted — when no award has
    // happened, so a caller cannot mistake "field absent" for "not checked".
    award: award ? shapeAward(award) : null,
    // Full award history across every lot/attempt in the process, including
    // cancelled/unsuccessful ones, sourced from the sibling evaluation
    // record MTender returns alongside the main tender record.
    awards: awards.map(shapeAward),
    published: cr.date ?? null,
    source_url: `${BASE}/tenders/${cr.ocid}`,
  };
}

function firstPartyName(cr: Record<string, any>): string | undefined {
  return Array.isArray(cr.parties) && cr.parties.length ? cr.parties[0]?.name : undefined;
}

async function mtGet(path: string): Promise<unknown> {
  const res = await pwFetch(`${BASE}${path}`, {
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
