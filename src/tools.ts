/**
 * The 25 Live Tennis API tools, as Vercel AI SDK tools.
 *
 * These are a deliberate port of the MCP server's tools
 * (`livetennisapi-mcp/src/server.ts`) — same names, same descriptions, same
 * input schemas, same output shapes. Two surfaces over one API should not
 * disagree about what a tool is called or what it returns, and the MCP wording
 * has already been through real model traffic. Where this file diverges from
 * that one it is because the AI SDK differs, and each divergence is commented.
 *
 * The API key is a PARAMETER, not a module-level `process.env` read
 * ----------------------------------------------------------------
 * Every tool is built inside a closure bound to one key, so an app that serves
 * several users can build one tool set per user and share no mutable state
 * between them. A module-level key would silently serve every caller on
 * whichever key happened to load first — at that key's tier.
 *
 * Failures are VALUES, not exceptions
 * -----------------------------------
 * A tier wall, a rejected key, a missing key, a rate limit and an unknown id are
 * all normal states with a clear remedy. `guard()` below turns each into a
 * returned object carrying `ok: false` and an actionable `message`. An empty
 * result is not a failure at all: it comes back as `ok: true` with an empty
 * list, because "nothing is live right now" is an answer. This is the single most
 * important behaviour inherited from the MCP server: marking a tier wall as an
 * error makes models retry it or abandon the task, instead of relaying the
 * upgrade path to the user, who is the only one who can act on it.
 */

import { tool } from 'ai';
import {
  BadRequest,
  LiveTennisAPI,
  NotFound,
  RateLimited,
  Unauthorized,
  UpgradeRequired,
  formatScore,
  type ArchiveMatch,
  type ArchiveParticipant,
  type Match,
  type MatchStatisticsSide,
  type RankingRecord,
  type Tournament,
} from 'livetennisapi';
import { z } from 'zod';

export const VERSION = '1.3.1';

/** Options accepted by `livetennisTools()` and by every individual tool factory. */
export interface LiveTennisToolOptions {
  /**
   * Your `twjp_` key. Falls back to `process.env.LIVETENNISAPI_KEY`.
   * A free key, no card, is at https://livetennisapi.com/subscribe/free
   */
  apiKey?: string;
  /**
   * Override the API origin. Falls back to `process.env.LIVETENNISAPI_BASE_URL`.
   * Exists for self-hosted deployments and for testing against a stub.
   */
  baseUrl?: string;
}

/**
 * Read an environment variable without assuming `process` exists.
 *
 * AI SDK tools frequently run on edge runtimes where `process` is absent, and a
 * bare `process.env.X` there is a ReferenceError at import time — i.e. the
 * package would fail to load rather than fail to authenticate.
 */
function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

/**
 * A non-error, no-data result: tier walls, key problems, empty responses.
 *
 * Assignable to every output schema in this file, because all of them require
 * only `ok` and `message` and mark every data field optional.
 */
type Failure = { ok: false; message: string };

/** What the closure below hands to each tool: one client, one guard, one key. */
type Context = {
  apiKey: string;
  /** Why the configured key cannot be used as it is, or null when it can (or when there is none). */
  keyProblem: string | null;
  client: LiveTennisAPI;
  guard: <T extends { ok: boolean; message: string }>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    run: () => Promise<T>,
  ) => Promise<T | Failure>;
  /** A copy of a result with every occurrence of the API key replaced. */
  scrub: <T>(value: T) => T;
  /** The message for anything a client call threw, with the key cut out. */
  describeFailure: (err: unknown) => string;
};

/**
 * Unix epoch seconds as an ISO instant, or null when the value is not one.
 *
 * `retry_at_epoch` comes straight out of a 429 body. A string, an object or a
 * number outside Date's range would make `toISOString()` throw a RangeError, and
 * a throw from inside the error handler escapes `guard` and the tool with it.
 */
function epochToIso(value: unknown): string | null {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A body field as text for a message, or null when it is not a plain string or number. */
function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * True when the key can be sent in an HTTP header as it is. Keys are printable
 * ASCII with no spaces. Anything else makes fetch reject the request with an
 * error that quotes the whole header value, key included.
 */
const sendableKey = (key: string) => /^[\x21-\x7e]+$/.test(key);

const MALFORMED_KEY =
  'The configured API key contains a space, a line break or another character that cannot go in ' +
  'an HTTP header. No request was made. Check the value passed as { apiKey } or set in ' +
  'LIVETENNISAPI_KEY: a key is one unbroken line of printable characters starting with twjp_. ' +
  'Keys are at https://livetennisapi.com';

/**
 * Keys shorter than this are not real keys (they are `twjp_` plus a long
 * token), and cutting a short string like "ok" out of every text and property
 * name would wreck the result instead of protecting anything.
 */
const MIN_REDACT_LENGTH = 12;

/**
 * Replace every occurrence of `key` in the strings and property names of a
 * result, in place, and return it. Iterative, so a deeply nested server object
 * cannot overflow the stack. Results are built fresh for each call from parsed
 * JSON, so changing them in place touches nothing the caller holds.
 */
function redact<T>(value: T, key: string): T {
  if (key.length < MIN_REDACT_LENGTH) return value;
  const clean = (text: string) => (text.includes(key) ? text.split(key).join('[redacted]') : text);
  if (typeof value === 'string') return clean(value) as T;
  const seen = new Set<object>();
  const stack: object[] = [];
  if (value && typeof value === 'object') stack.push(value);
  while (stack.length) {
    const node = stack.pop() as Record<string, unknown> | unknown[];
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const item = node[i];
        if (typeof item === 'string') node[i] = clean(item);
        else if (item && typeof item === 'object') stack.push(item);
      }
      continue;
    }
    for (const name of Object.keys(node)) {
      let item = node[name];
      if (typeof item === 'string') item = node[name] = clean(item);
      else if (item && typeof item === 'object') stack.push(item);
      if (name.includes(key)) {
        delete node[name];
        node[clean(name)] = item;
      }
    }
  }
  return value;
}

/**
 * fetch for the client, with one repair. The livetennisapi client formats
 * `retry_at_epoch` as a date while it builds its AbuseThrottled error. A number
 * outside the Date range makes that constructor throw a RangeError, and the
 * 429 body (with its do-not-retry meaning) is lost. For such a body the client
 * gets a small copy with the fields a 429 is read by, and `retry_at_epoch` as a
 * string, which the client ignores and `epochToIso` rejects. Unlabelled abuse
 * and daily 429s get their label (see below). Every other response passes
 * through untouched.
 */
const safeFetch: typeof fetch = async (input, init) => {
  const res = await globalThis.fetch(input, init);
  if (res.status !== 429) return res;
  const rebuild = (body: string) =>
    new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  let text = '';
  try {
    text = await res.text();
  } catch {
    return rebuild('');
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rebuild(text);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return rebuild(text);
  const b = body as Record<string, unknown>;
  const badEpoch = typeof b.retry_at_epoch === 'number' && epochToIso(b.retry_at_epoch) === null;
  // The client stops retrying a 429 only when it says abuse_throttled or
  // scope "day". A body that only carries retry_at_epoch, or a rate_limited
  // body with resets_at but no scope, means the same thing to describeFailure,
  // so it is labelled here and the client does not retry it twice first.
  const unlabelledAbuse = b.error === undefined && b.scope !== 'day' && b.retry_at_epoch != null;
  const unlabelledDay =
    b.scope === undefined && typeof b.resets_at === 'string' && b.resets_at.trim() !== '' && b.error !== 'abuse_throttled';
  if (!badEpoch && !unlabelledAbuse && !unlabelledDay) return rebuild(text);
  const small: Record<string, unknown> = {};
  for (const field of ['error', 'scope', 'limit_per_day', 'resets_at', 'retry_at_epoch']) {
    const v = b[field];
    if (typeof v === 'string' || typeof v === 'number') small[field] = v;
  }
  if (badEpoch) small.retry_at_epoch = String(b.retry_at_epoch);
  if (unlabelledAbuse) small.error = 'abuse_throttled';
  if (unlabelledDay) small.scope = 'day';
  return rebuild(JSON.stringify(small));
};

/**
 * Whether a 403 is the API's plan gate. The client turns every 403 into
 * UpgradeRequired, including a firewall's HTML page, but the API itself always
 * says `{"error": "upgrade_required"}`.
 */
const isPlanGate = (err: unknown): err is UpgradeRequired =>
  err instanceof UpgradeRequired && err.errorCode === 'upgrade_required';

/**
 * Turn anything a client call can throw into the message a tool returns.
 *
 * Shared by `guard` and `check_api_status`, so a 429 reads the same whichever
 * tool hit it. Never throws, and never repeats the API key: `apiKey` is cut out
 * of any text taken from an error, in case a lower layer quoted it.
 */
function describeFailure(err: unknown, apiKey: string): string {
  if (err instanceof UpgradeRequired) {
    const code = err.errorCode;
    if (!isPlanGate(err)) {
      // A 403 that is not a plan gate (a firewall, a disabled surface). Saying
      // "upgrade" here would send the user to pay for something that cannot help.
      const shown = scalar(code);
      return (
        `The API refused this request (403${shown ? ` ${redact(shown, apiKey)}` : ''}). ` +
        'This is not a plan limit. Check the API key and the base URL, or ask hello@livetennisapi.com.'
      );
    }
    const body = err.body && typeof err.body === 'object' ? (err.body as Record<string, unknown>) : {};
    const taste =
      body.free_history_taste === 'used'
        ? ' This API key has already used its 20 free history calls for this calendar month.'
        : '';
    const needs = err.requiredTier ? `the ${err.requiredTier} plan` : 'a higher plan';
    return (
      `This data requires ${needs}, and the configured API key is on a lower tier.${taste} ` +
      `Nothing is wrong with the API key. The current plan does not ` +
      `include this endpoint. Upgrade at https://livetennisapi.com/#pricing\n\n` +
      `Plans: FREE has live and upcoming matches, scores, players, fixtures and tournaments. ` +
      `BASIC adds historical results, the results archive (1968 to 2022) and head-to-head. ` +
      `PRO adds match events, market prices, the rankings listing and player records. ` +
      `ULTRA adds model analysis, win probability, per-player as-of rankings, in-play statistics, ` +
      `shot-level charting and the live WebSocket feed.`
    );
  }
  if (err instanceof Unauthorized) {
    return (
      'The API key was rejected: it is missing, unknown or disabled. Check the API key passed ' +
      'to the tool factory or set in LIVETENNISAPI_KEY. Keys are at https://livetennisapi.com'
    );
  }
  if (err instanceof NotFound) {
    return 'No data found for that request. The id may be wrong, or there may be no data yet.';
  }
  if (err instanceof RateLimited) {
    // Three distinct 429s, each with a different correct reaction. Collapsing
    // them into "rate limited, retry" makes a model retry through a daily cap
    // or an abuse block — the one thing that must not happen. Every body field
    // is checked for type before use: the body is whatever the server sent.
    const raw = err.body;
    const body: Record<string, unknown> = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    // abuse_throttled is named by its error code. A retry_at_epoch decides only
    // when the body names nothing else: an explicit rate_limited or a daily
    // scope keeps its own, shorter, meaning.
    const code = err.errorCode;
    const abuse =
      code === 'abuse_throttled' || (code === undefined && body.scope !== 'day' && body.retry_at_epoch != null);
    if (abuse) {
      const resumes = epochToIso(body.retry_at_epoch);
      return (
        `This API key is temporarily blocked (abuse_throttled). It is a 24-hour block for clients that ` +
        `keep hammering the API after repeated rate-limit responses.${resumes ? ` Requests resume at ${resumes}.` : ''} ` +
        `Do NOT retry until then. Fix the retry loop that kept requesting through 429s instead.`
      );
    }
    const resetsAt = typeof body.resets_at === 'string' ? scalar(body.resets_at) : null;
    if (body.scope === 'day' || resetsAt) {
      const perDay = typeof body.limit_per_day === 'number' ? scalar(body.limit_per_day) : null;
      return (
        `Daily request quota reached for this plan${perDay ? ` (${perDay} requests/day)` : ''}.` +
        `${resetsAt ? ` The quota resets at ${resetsAt}.` : ''} Retrying before then cannot succeed. ` +
        `Wait for the reset, or upgrade at https://livetennisapi.com/subscribe/upgrade`
      );
    }
    const wait = err.retryAfter ? ` Retry in about ${err.retryAfter}s.` : '';
    return `Per-minute rate limit reached for this plan.${wait}`;
  }
  if (err instanceof BadRequest && err.errorCode === 'ambiguous_name') {
    // /h2h, /history/archive/career and /charting/players refuse a fragment
    // matching more than one player — two people summed into one record
    // would be a wrong answer, not a convenience. Relay the candidates so
    // the model can disambiguate instead of retrying blind.
    const candidates = (err.body as { candidates?: unknown } | undefined)?.candidates;
    const names = Array.isArray(candidates)
      ? candidates
          .map((c) => scalar(c) ?? (c && typeof c === 'object' ? scalar((c as { name?: unknown }).name) : null))
          .filter((c): c is string => c != null)
      : [];
    return (
      `That name fragment matches more than one player.${names.length ? ` Candidates: ${names.join(', ')}.` : ''} ` +
      'The API refuses to sum two people into one record, so nothing was guessed. ' +
      'Retry with a more specific name (one of the candidates above).'
    );
  }
  if (err instanceof BadRequest && err.errorCode === 'doubles_not_supported') {
    // player_stats covers singles only. The remedy is a different id, not a
    // retry, so it is a value with that remedy, as an ambiguous name is.
    return 'That id is a doubles team. Player stats cover singles only, so query each member player id instead.';
  }
  // A genuine fault. The MCP server flags these with `isError: true`, which
  // has no AI SDK equivalent other than throwing — and a throw out of
  // `execute` can abort the caller's whole generation over one bad request.
  // So it stays a value here, distinguishable by the message prefix.
  const text = err instanceof Error ? err.message : String(err);
  return `Request failed: ${redact(text, apiKey)}`;
}

/** Build the per-key context every tool in a set shares. */
export function createContext(options: LiveTennisToolOptions = {}): Context {
  const apiKey = (options.apiKey ?? env('LIVETENNISAPI_KEY') ?? '').trim();
  const keyProblem = apiKey && !sendableKey(apiKey) ? MALFORMED_KEY : null;
  const baseUrl = options.baseUrl ?? env('LIVETENNISAPI_BASE_URL');
  // A key that cannot go in a header never reaches the client: every request
  // would fail with the key quoted in the error. check_api_status still runs
  // its keyless health check and reports the problem.
  const client = new LiveTennisAPI({ apiKey: keyProblem ? '' : apiKey, baseUrl, fetch: safeFetch });

  const fail = (message: string): Failure => ({ ok: false, message });

  const scrub = <T,>(value: T): T => redact(value, apiKey);

  async function guard<T extends { ok: boolean; message: string }>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    run: () => Promise<T>,
  ): Promise<T | Failure> {
    if (!apiKey) {
      return fail(
        'No API key configured. Pass { apiKey } to the tool factory, or set LIVETENNISAPI_KEY in ' +
          'the environment. Get a free key, no card, at https://livetennisapi.com/subscribe/free',
      );
    }
    if (keyProblem) return fail(keyProblem);
    let result: T;
    try {
      result = await run();
    } catch (err) {
      return scrub(fail(describeFailure(err, apiKey)));
    }
    // The last two checks before a result leaves the package. The server shapes
    // some objects freely, so a result is parsed against the schema the tool
    // advertises: the AI SDK checks saved outputs against it when a chat is
    // reloaded (validateUIMessages), and one stray value would break that chat.
    // And no string in it may carry the key, even if the server echoed it.
    const parsed = schema.safeParse(result);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? issue.path.join('.') : 'the result';
      // The path can hold record keys the server chose, so it is scrubbed too.
      return scrub(
        fail(
          `Request failed: the API answered, but ${where} was not in the expected shape. ` +
            'Retrying will not help. Report it at https://github.com/livetennisapi/livetennisapi-ai/issues',
        ),
      );
    }
    return scrub(result);
  }

  return {
    apiKey,
    keyProblem,
    client,
    guard,
    scrub,
    describeFailure: (err: unknown) => describeFailure(err, apiKey),
  };
}

// -- shared field definitions --------------------------------------------------
// Declared once so all 25 tools describe the same concept the same way.

const okField = z
  .boolean()
  .describe(
    'True when the request succeeded, including when the answer is an empty list. False for a ' +
      'missing or rejected key, a plan that does not include this data, an unknown id, a rate ' +
      'limit or a network error. The message then says what to do. check_api_status is the ' +
      'exception: it is true whenever the API answered, and reports API key problems in the message.',
  );

const messageField = z
  .string()
  .describe('Human-readable summary of the result, safe to relay to the user verbatim.');

/** Every output in this package is `ok` + `message` plus optional payload fields. */
const outputOf = <S extends z.ZodRawShape>(shape: S) => z.object({ ok: okField, message: messageField, ...shape });

const MatchOut = z.object({
  // Nullable, not required: the upstream type allows a match without an id, and
  // asserting otherwise would make the schema lie rather than make the data safe.
  id: z.number().nullable().describe('Match id. Pass to get_match, get_match_score, get_match_events or get_match_odds.'),
  tour: z
    .string()
    .nullable()
    .describe('atp, wta, challenger, itf or juniors. Null when the feed never stated one (exhibitions, team events).'),
  tournament: z.string().nullable().describe('Event name, e.g. "Wimbledon".'),
  tournament_id: z.string().nullable().describe('Stable tournament id. Pass to get_tournament. Null where uncatalogued.'),
  round: z.string().nullable().describe('Round within the event, e.g. "QF".'),
  round_code: z
    .string()
    .nullable()
    .describe('Round in the normalized vocabulary (F, SF, QF, R16 ... Q). Null when the label is unrecognised, never guessed.'),
  player1: z.string().nullable().describe('Name of player 1.'),
  player2: z.string().nullable().describe('Name of player 2.'),
  score: z.string().nullable().describe('Formatted score line, e.g. "6-4 3-6 2-1".'),
  status: z.string().nullable().describe('One of live, upcoming, completed or cancelled.'),
  scheduled_time: z
    .string()
    .nullable()
    .describe('Scheduled start, UTC ISO-8601. Null when the feed has not published one.'),
  surface: z.string().nullable().describe('Court surface, e.g. hard, clay, grass.'),
  indoor: z.boolean().nullable().describe('True when played indoors.'),
  serving: z.number().nullable().describe('1 or 2 while a point is in play, otherwise null.'),
  winner: z.number().nullable().describe('1 or 2 once decided, otherwise null.'),
  event_status: z
    .string()
    .nullable()
    .describe(
      'How the match ended (or paused) when it did not run its course: Retired, Cancelled, Walk Over, ' +
        'Postponed or Interrupted. Null means completed normally OR never resolved. Branch settlement logic here.',
    ),
  event_status_updated_at: z
    .string()
    .nullable()
    .describe(
      'The instant the current event_status was recorded, UTC ISO-8601 (added 2026-08-19). ' +
        'Null while the status has never changed since the field was introduced. Never backfilled.',
    ),
  withdrew: z
    .number()
    .nullable()
    .describe(
      'Completed matches only: which player retired or conceded the walkover, 1 or 2. ' +
        'Null means "not a withdrawal, or no evidence", never a guess.',
    ),
  has_analysis: z
    .boolean()
    .nullable()
    .describe(
      'Whether a model thesis or profile exists for this match (added 2026-09-02, every tier). ' +
        'Filter on this before calling get_match_analysis, which reports the same absence. ' +
        'Null only when the server predates the field.',
    ),
  has_market: z
    .boolean()
    .nullable()
    .describe(
      'Whether a match-winner market is mapped to this match (added 2026-09-02, every tier). ' +
        'Filter on this before calling get_match_odds, which reports the same absence. ' +
        'Null only when the server predates the field.',
    ),
  win_probability_p1: z
    .number()
    .nullable()
    .describe('Model probability that player 1 wins, 0-1. Requires the ULTRA plan, null otherwise.'),
});

const PlayerOut = z.object({
  id: z.number().nullable().describe('Player id. Pass to get_player.'),
  name: z.string().nullable().describe('Player name.'),
  country: z.string().nullable().describe('Country code.'),
  ranking: z.number().nullable().describe('Current singles ranking.'),
  ranking_points: z.number().nullable().describe('Ranking points.'),
  ranking_movement: z.string().nullable().describe('Recent movement in the rankings.'),
  hand: z.string().nullable().describe('"R" or "L".'),
  birthday: z.string().nullable().describe('Date of birth, ISO date.'),
  tour: z.string().nullable().describe('ATP, WTA, Challenger or ITF.'),
});

const FixtureOut = z.object({
  event_date: z.string().nullable().describe('Scheduled date, YYYY-MM-DD.'),
  start_time: z
    .string()
    .nullable()
    .describe('Scheduled start, UTC ISO-8601. Null until the order of play assigns a time.'),
  tournament: z.string().nullable().describe('Event name.'),
  round: z.string().nullable().describe('Round within the event.'),
  player1: z.string().nullable().describe('Name of player 1.'),
  player2: z.string().nullable().describe('Name of player 2.'),
});

const PriceOut = z.object({
  side: z.number().nullable().describe('Which player this price is for, 1 or 2.'),
  mid: z.number().nullable().describe('Mid price, 0-1, readable as implied probability.'),
  bid: z.number().nullable().describe('Best bid.'),
  ask: z.number().nullable().describe('Best ask.'),
  timestamp: z.string().nullable().describe('When the price was observed.'),
});

const TournamentOut = z.object({
  id: z.string().nullable().describe('Stable tournament id, the same id match objects carry as tournament_id.'),
  name: z.string().nullable().describe('Tournament name.'),
  tour: z.string().nullable().describe('atp, wta, challenger, itf or juniors.'),
  surface: z.string().nullable().describe('Court surface: hard, clay or grass.'),
  indoor: z.boolean().nullable().describe('True when played indoors.'),
  city: z.string().nullable().describe('Host city, from a curated table. Null where not curated.'),
  country: z.string().nullable().describe('Host country, ISO-3166 alpha-2. Null where not curated.'),
  category: z
    .string()
    .nullable()
    .describe(
      'Tournament category (grand_slam, masters_1000, tour_finals, atp_500, atp_250, wta_1000, ' +
        'wta_500, wta_250, wta_125, challenger, itf, juniors). Set only where the catalogues agree ' +
        'unambiguously. Null otherwise, never derived from the name.',
    ),
});

const ArchiveSideOut = z.object({
  name: z.string().nullable().describe('Player name as the corpus records it.'),
  country: z.string().nullable().describe('3-letter country code.'),
  rank: z.number().nullable().describe('Rank AT THE TIME of the match, as published.'),
  seed: z.number().nullable().describe('Seeding, where seeded.'),
  player_id: z
    .number()
    .nullable()
    .describe('Corpus person id. Join it to search_archive_players results for bios. NOT a roster player id.'),
  hand: z.string().nullable().describe('"R" or "L".'),
  height_cm: z.number().nullable().describe('Height in cm, where recorded.'),
  age: z.number().nullable().describe('Age at the time of the match.'),
  entry: z.string().nullable().describe('Draw entry where recorded (WC, Q, LL, ...). Null for direct acceptances.'),
});

const ArchiveMatchOut = z.object({
  id: z.number().nullable().describe('Archive match id. Pass to get_archive_match for the detail read with stats.'),
  tour: z.string().nullable().describe('atp or wta. The results archive covers those two tours.'),
  tournament: z.string().nullable().describe('Tournament name.'),
  event_date: z
    .string()
    .nullable()
    .describe("The tournament START date. Per-match dates do not exist in this era's records."),
  round: z.string().nullable().describe('Round code: F, SF, QF, R16 … Q1-Q4.'),
  level: z.string().nullable().describe('Source tier code: G, M, A, F, D, C, O, or a futures category code.'),
  surface: z.string().nullable().describe('Court surface.'),
  score: z.string().nullable().describe('The final score as published, e.g. "6-4 7-6(5)", "6-3 RET", "W/O".'),
  outcome: z
    .string()
    .nullable()
    .describe('completed, retired, walkover, default or abandoned. Parsed, null when unparseable.'),
  winner: ArchiveSideOut.describe('The winner, a stored field in the corpus, never an inference.'),
  loser: ArchiveSideOut.describe('The loser.'),
});

const ArchiveBioOut = z.object({
  id: z
    .number()
    .nullable()
    .describe('Corpus person id, the id archive match rows carry as winner/loser player_id. NOT a roster id.'),
  tour: z.string().nullable().describe('atp or wta.'),
  name: z.string().nullable().describe('Player name.'),
  hand: z.string().nullable().describe('"R" or "L".'),
  dob: z.string().nullable().describe('Date of birth, ISO date.'),
  country: z.string().nullable().describe('3-letter country code.'),
  height_cm: z.number().nullable().describe('Height in cm.'),
  career_high_rank: z.number().nullable().describe("Career-high rank, from the corpus's own weekly tables."),
  career_high_date: z.string().nullable().describe('The earliest week the career-high rank was reached.'),
});

const H2HMeetingOut = z.object({
  era: z
    .string()
    .nullable()
    .describe('"archive" (results archive, 1968-2022) or "current" (our own completed matches, 2023 onward).'),
  date: z.string().nullable().describe('Match date (current era) or tournament start date (archive era).'),
  tournament: z.string().nullable().describe('Tournament name.'),
  round: z.string().nullable().describe('Round.'),
  surface: z.string().nullable().describe('Court surface.'),
  score: z.string().nullable().describe('Final score (archive rows only. Read current rows from get_match).'),
  outcome: z.string().nullable().describe('completed, retired, walkover, ... Exclude non-completed yourself if needed.'),
  winner: z
    .number()
    .nullable()
    .describe('1 or 2 OF THE REQUEST (player1/player2 as you passed them), not of the underlying match row.'),
  match_id: z.number().nullable().describe('Our match id (current era rows). Pass to get_match.'),
});

const RankingRowOut = z.object({
  player_id: z.number().nullable().describe('Roster player id. Null on listing rows for players outside our roster.'),
  player_name: z.string().nullable().describe('Name as the ranking publisher printed it (listing rows).'),
  system: z.string().nullable().describe('atp, wta, itf_jt, itf_mt, itf_wt or utr. Systems are never comparable.'),
  rank: z.number().nullable().describe('Null for UTR (a rating, not a ranking).'),
  points: z.number().nullable().describe('Null for UTR.'),
  previous_rank: z.number().nullable().describe('Rank at the preceding snapshot week (ATP/WTA only, null elsewhere).'),
  rank_movement: z.number().nullable().describe("The circuit's own signed weekly movement (ITF systems only)."),
  rating: z.number().nullable().describe('UTR only, null elsewhere.'),
  effective_date: z.string().nullable().describe('The publication week this record took effect, YYYY-MM-DD.'),
});

const StatsSideOut = z.object({
  derived: z
    .record(z.number().nullable())
    .describe(
      'Rebuilt from the point-by-point record: service/return games and points, hold_pct, break_pct, ' +
        'break points faced/saved/converted. Null percentages mean a zero denominator, never 0.',
    ),
  measured: z
    .record(z.number().nullable())
    .nullable()
    .describe(
      'Counted upstream: aces, double_faults, the serve split, winners/unforced errors where covered. ' +
        'Absent fields are omitted, never zero-filled. Quantities named in both families are computed two ' +
        'different ways: a cross-check, not a duplication.',
    ),
});

/** Normalise `undefined` to `null` — the schemas above are nullable, not optional. */
const n = <T,>(v: T | undefined | null): T | null => (v == null ? null : v);

/** A finite number, or null. For fields copied from objects the server shapes freely. */
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A string, or null. */
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** A boolean, or null. The string "false" is not false, and must not read as true either. */
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/**
 * Only the numeric (or null) entries of a server object, or null when it is not
 * an object. Stat blocks are passed through by key, and one extra string field
 * would break the declared `record(number | null)` schema. The AI SDK checks
 * saved tool outputs against that schema when a chat is reloaded
 * (`validateUIMessages`), so a stray field fails there.
 */
function numRecord(v: unknown): Record<string, number | null> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, number | null> = {};
  for (const [k, x] of Object.entries(v)) if (x === null || num(x) !== null) out[k] = x === null ? null : (x as number);
  return out;
}

/** A plain server object, or null for anything else (an array, a string, null). */
const plainObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** One W/L row of player_stats, each field read by type, or null when the row is not an object. */
function winLossOut(v: unknown): z.infer<typeof WinLossOut> | null {
  const row = plainObject(v);
  if (!row) return null;
  return { matches: num(row.matches), wins: num(row.wins), losses: num(row.losses), win_pct: num(row.win_pct) };
}

/** A player_stats W/L table by key (surface, venue, level, season). Rows that are not objects are dropped. */
function winLossRecord(v: unknown): Record<string, z.infer<typeof WinLossOut>> | null {
  const table = plainObject(v);
  if (!table) return null;
  // fromEntries, not assignment: a "__proto__" key from JSON.parse would set
  // the prototype of a plain object instead of adding a row.
  return Object.fromEntries(
    Object.entries(table).flatMap(([k, row]) => {
      const wl = winLossOut(row);
      return wl ? [[k, wl] as const] : [];
    }),
  );
}

/** "56-2 (96.6%)", or "no matches" on an empty sample. */
function winLossLine(wl: z.infer<typeof WinLossOut> | null): string {
  if (!wl || !wl.matches) return 'no matches';
  return `${wl.wins ?? 0}-${wl.losses ?? 0}${wl.win_pct != null ? ` (${wl.win_pct}%)` : ''}`;
}

/**
 * A player_stats recent-match score from the player's side, "6-4 3-6 6-2", or
 * null when the server held no score row. Games come as [[player], [opponent]],
 * and each value may be null, which reads as "?".
 */
function sideScore(score: unknown): string | null {
  const games = plainObject(score)?.games;
  if (!Array.isArray(games) || games.length !== 2 || !Array.isArray(games[0])) return null;
  const mine = games[0] as unknown[];
  const theirs = Array.isArray(games[1]) ? (games[1] as unknown[]) : [];
  if (!mine.length) return null;
  return mine.map((v, i) => `${num(v) ?? '?'}-${num(theirs[i]) ?? '?'}`).join(' ');
}

/** A W-L table by key (surface, level), each row reduced to two numbers. */
function wlRecord(v: unknown): Record<string, { wins: number | null; losses: number | null }> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return Object.fromEntries(
    Object.entries(v).map(([k, wl]) => {
      const row = (wl && typeof wl === 'object' ? wl : {}) as { wins?: unknown; losses?: unknown };
      return [k, { wins: num(row.wins), losses: num(row.losses) }];
    }),
  );
}

function matchOut(m: Match): z.infer<typeof MatchOut> {
  // Every field read by type rather than passed through: match rows are the
  // most common output, and one odd value would otherwise fail the whole list
  // at the schema check in guard().
  return {
    id: num(m.id),
    tour: str(m.tour),
    tournament: str(m.tournament),
    tournament_id: str(m.tournament_id),
    round: str(m.round),
    round_code: str(m.round_code),
    player1: str(m.players?.p1?.name),
    player2: str(m.players?.p2?.name),
    score: str(formatScore(m.score)),
    status: str(m.status),
    scheduled_time: str(m.scheduled_time),
    surface: str(m.surface),
    indoor: bool(m.indoor),
    serving: num(m.score?.server),
    winner: num(m.winner),
    event_status: str(m.event_status),
    // Typed in livetennisapi >= 1.5 and >= 1.9. With the ^1.4.0 floor these are
    // only reachable through the Extensible index signature.
    event_status_updated_at: str(m.event_status_updated_at),
    withdrew: num(m.withdrew),
    has_analysis: bool(m.has_analysis),
    has_market: bool(m.has_market),
    win_probability_p1: num(m.score?.win_probability_p1),
  };
}

function tournamentOut(t: Tournament): z.infer<typeof TournamentOut> {
  return {
    id: n(t.id),
    name: n(t.name),
    tour: n(t.tour),
    surface: n(t.surface),
    indoor: n(t.indoor),
    city: n(t.city),
    country: n(t.country),
    category: n(t.category),
  };
}

function archiveSideOut(p: ArchiveParticipant | undefined): z.infer<typeof ArchiveSideOut> {
  return {
    name: n(p?.name),
    country: n(p?.country),
    rank: n(p?.rank),
    seed: n(p?.seed),
    player_id: n(p?.player_id),
    hand: n(p?.hand),
    height_cm: n(p?.height_cm),
    age: n(p?.age),
    entry: n(p?.entry),
  };
}

function archiveMatchOut(m: ArchiveMatch): z.infer<typeof ArchiveMatchOut> {
  return {
    id: n(m.id),
    tour: n(m.tour),
    tournament: n(m.tournament),
    event_date: n(m.event_date),
    round: n(m.round),
    level: n(m.level),
    surface: n(m.surface),
    score: n(m.score),
    outcome: n(m.outcome),
    winner: archiveSideOut(m.winner),
    loser: archiveSideOut(m.loser),
  };
}

/** Compact one-line archive-result summary, mirroring `summarise()` for live matches. */
function summariseArchive(m: ArchiveMatch): string {
  const w = m.winner?.name ?? '?';
  const l = m.loser?.name ?? '?';
  const rank = (p: ArchiveParticipant | undefined) => (p?.rank != null ? ` (rank ${p.rank})` : '');
  const bits = [
    `[${m.id}] ${m.event_date ?? '?'} ${m.tournament ?? 'Unknown event'}${m.round ? `, ${m.round}` : ''}`,
    `  ${w}${rank(m.winner)} d. ${l}${rank(m.loser)}  ${m.score ?? ''}`.trimEnd(),
  ];
  if (m.surface) bits.push(`  Surface: ${m.surface}`);
  if (m.outcome && m.outcome !== 'completed') bits.push(`  Outcome: ${m.outcome}`);
  return bits.join('\n');
}

function rankingRowOut(r: RankingRecord): z.infer<typeof RankingRowOut> {
  return {
    player_id: n(r.player_id),
    player_name: n(r.player_name),
    system: n(r.system),
    rank: n(r.rank),
    points: n(r.points),
    previous_rank: n(r.previous_rank),
    rank_movement: n(r.rank_movement),
    rating: n(r.rating),
    effective_date: n(r.effective_date),
  };
}

/** One-line prose for a ranking record — `#3 Player Name · 7,000 pts (prev 4) · eff. 2026-08-03`. */
function rankingLine(r: RankingRecord): string {
  const who = r.player_name ?? (r.player_id != null ? `player ${r.player_id}` : '?');
  const bits = [
    r.rank != null ? `#${r.rank}` : r.rating != null ? `UTR ${r.rating}` : '#?',
    who,
    r.points != null ? `· ${r.points} pts` : '',
    r.previous_rank != null ? `(prev ${r.previous_rank})` : '',
    r.rank_movement != null && r.rank_movement !== 0 ? `(${r.rank_movement > 0 ? '+' : ''}${r.rank_movement})` : '',
  ].filter(Boolean);
  return bits.join(' ');
}

/** Compact one-line match summary — token-efficient for a model to read. */
function summarise(match: Match): string {
  const p1 = match.players?.p1?.name ?? '?';
  const p2 = match.players?.p2?.name ?? '?';
  const serving = match.score?.server === 1 ? ' (serving)' : '';
  const serving2 = match.score?.server === 2 ? ' (serving)' : '';
  const bits = [
    `[${match.id}] ${match.tournament ?? 'Unknown event'}${match.round ? `, ${match.round}` : ''}` +
      `${match.tour ? ` · ${match.tour}` : ''}`,
    `  ${p1}${serving} vs ${p2}${serving2}`,
    `  Score: ${formatScore(match.score)}`,
  ];
  if (match.surface) bits.push(`  Surface: ${match.surface}${match.indoor ? ' (indoor)' : ''}`);
  if (match.status && match.status !== 'live') bits.push(`  Status: ${match.status}`);
  if (match.status === 'upcoming' && match.scheduled_time) bits.push(`  Starts: ${match.scheduled_time}`);
  if (match.winner) bits.push(`  Winner: ${match.winner === 1 ? p1 : p2}`);
  if (match.event_status) {
    bits.push(`  Event status: ${match.event_status}${match.withdrew ? ` (player ${match.withdrew} withdrew)` : ''}`);
  }
  // Only when the server sent them (added 2026-09-02) — an older server omits
  // both, and the summary must not invent a coverage claim.
  const hasAnalysis = bool(match.has_analysis);
  const hasMarket = bool(match.has_market);
  if (hasAnalysis != null) bits.push(`  Analysis: ${hasAnalysis ? 'available' : 'none'}`);
  if (hasMarket != null) bits.push(`  Market: ${hasMarket ? 'mapped' : 'none'}`);
  if (match.score?.win_probability_p1 != null) {
    bits.push(`  Model win probability (${p1}): ${(match.score.win_probability_p1 * 100).toFixed(1)}%`);
  }
  return bits.join('\n');
}

// -- shared input fields -------------------------------------------------------

const limitField = (max: number, fallback: number, what: string) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Maximum ${what} to return (1-${max}).`);

const matchIdField = z
  .number()
  .int()
  .describe('Match id, as returned by get_live_matches, get_upcoming_matches or get_recent_results.');

// -- shared list filters, declared once so every list tool describes them the same way --

const tourField = z
  .enum(['atp', 'wta', 'challenger', 'itf', 'juniors'])
  .optional()
  .describe(
    'Tour filter. Each name covers its doubles variants. Exhibition/team events carry no tour and are ' +
      'excluded whenever the filter is used.',
  );
const playerFilterField = z
  .array(z.number().int())
  .max(50)
  .optional()
  .describe('Player ids (from search_players), max 50. Keeps matches where ANY listed player is either participant.');
const countryField = z
  .string()
  .length(3)
  .optional()
  .describe(
    "Either participant's country: the lowercase 3-letter IOC-style code the Player object returns " +
      '(e.g. ned, sui, gre), NOT ISO-3166. Players with no recorded country never match.',
  );
const fromField = z.string().optional().describe('Earliest play date: YYYY-MM-DD (a whole UTC day) or ISO-8601 datetime.');
const toField = z.string().optional().describe('Latest play date: YYYY-MM-DD or ISO-8601. Must not precede from.');

// -- output schemas ------------------------------------------------------------
// Named rather than inlined so each tool's `execute` can be annotated with its
// own return type. That annotation is what makes TypeScript enforce that the
// value a tool returns actually matches the schema it advertises. The AI SDK
// does not validate tool output when `execute` returns. It does when an app
// reloads a saved chat through `validateUIMessages`, so an output that drifts
// from its schema breaks there, long after the call. Server objects copied by
// key go through numRecord/wlRecord for the same reason.

const LiveMatchesOutput = outputOf({
  matches: z.array(MatchOut).optional().describe('The live matches, most relevant first.'),
});

const UpcomingMatchesOutput = outputOf({
  matches: z.array(MatchOut).optional().describe('Matches due to start, soonest first.'),
});

const MatchOutput = outputOf({
  match: MatchOut.optional().describe('The match.'),
  market: z
    .object({
      question: z.string().nullable().describe('The market being priced.'),
      prices: z.array(PriceOut).describe('Current prices per player.'),
    })
    .optional()
    .describe('Match-winner market. Requires the PRO plan, absent otherwise.'),
  analysis: z
    .object({
      win_probability_p1: z.number().nullable().describe('Model probability player 1 wins, 0-1.'),
      key_factors: z.array(z.string()).describe('Drivers behind the model view.'),
    })
    .optional()
    .describe('Model analysis. Requires the ULTRA plan, absent otherwise.'),
});

const MatchScoreOutput = outputOf({
  score: z
    .object({
      formatted: z.string().describe('Formatted score line.'),
      sets: z.array(z.number()).nullable().describe('Sets won per player.'),
      serving: z.number().nullable().describe('Which player is serving, 1 or 2.'),
      is_tiebreak: z.boolean().nullable().describe('True during a tiebreak.'),
      win_probability_p1: z.number().nullable().describe('Model probability player 1 wins, 0-1. ULTRA only.'),
    })
    .optional()
    .describe('The current score.'),
});

const SearchPlayersOutput = outputOf({
  players: z.array(PlayerOut).optional().describe('Matching players, best match first.'),
});

const PlayerOutput = outputOf({
  player: PlayerOut.optional().describe('The player.'),
});

const FixturesOutput = outputOf({
  fixtures: z.array(FixtureOut).optional().describe('Scheduled fixtures, earliest first.'),
});

const RecentResultsOutput = outputOf({
  matches: z.array(MatchOut).optional().describe('Completed matches, most recent first.'),
});

const MatchEventsOutput = outputOf({
  events: z
    .array(
      z.object({
        timestamp: z.string().nullable().describe('When the event occurred.'),
        type: z.string().nullable().describe('Event type, e.g. break, game, set.'),
        player: z.number().nullable().describe('Player the event belongs to, 1 or 2.'),
      }),
    )
    .optional()
    .describe('Events, newest first, as the API returns them.'),
});

const MatchOddsOutput = outputOf({
  market: z
    .object({
      question: z.string().nullable().describe('The market being priced.'),
      status: z.string().nullable().describe('Market status, e.g. open or resolved.'),
      volume: z.number().nullable().describe('24h traded volume.'),
      liquidity: z.number().nullable().describe('Resting liquidity.'),
      prices: z.array(PriceOut).describe('Recent prices, newest first.'),
    })
    .optional()
    .describe('The match-winner market.'),
});

const MatchAnalysisOutput = outputOf({
  profile: z
    .object({
      win_probability_p1: z.number().nullable().describe('Model probability player 1 wins, 0-1.'),
      expected_closeness: z.number().nullable().describe('How close the model expects the match to be.'),
      volatility_rating: z.string().nullable().describe('Expected swing in the match state.'),
      key_factors: z.array(z.string()).describe('Drivers behind the model view.'),
    })
    .optional()
    .describe('Quantitative view.'),
  thesis: z
    .object({
      pick_side: z.number().nullable().describe('Player the model favours, 1 or 2.'),
      confidence: z.number().nullable().describe('Model confidence, 0-1.'),
      state: z.string().nullable().describe('Current state of the thesis.'),
      reasoning: z.string().nullable().describe('Narrative reasoning.'),
    })
    .optional()
    .describe('Narrative view.'),
});

const ApiStatusOutput = outputOf({
  reachable: z.boolean().optional().describe('True when the API answered its health check.'),
  api_version: z.string().nullable().optional().describe('API version reported by the health check.'),
  tier: z
    .string()
    .nullable()
    .optional()
    .describe('Detected plan: FREE, BASIC, PRO or ULTRA. Null when no key is configured.'),
  has_key: z.boolean().optional().describe('Whether a key was configured for this tool set.'),
});

const TournamentsOutput = outputOf({
  tournaments: z.array(TournamentOut).optional().describe('Matching tournaments, name order.'),
});

const TournamentOutput = outputOf({
  tournament: TournamentOut.optional().describe('The tournament.'),
});

const ArchiveMatchesOutput = outputOf({
  results: z.array(ArchiveMatchOut).optional().describe('Archive results, newest tournament first.'),
});

const ArchiveMatchOutput = outputOf({
  result: ArchiveMatchOut.optional().describe('The archive result.'),
  stats: z
    .object({
      winner: z.record(z.number().nullable()).nullable().describe('Serve stats for the winner, where recorded.'),
      loser: z.record(z.number().nullable()).nullable().describe('Serve stats for the loser, where recorded.'),
    })
    .nullable()
    .optional()
    .describe(
      'Per-match serve statistics (aces, double_faults, serve_points, first_in, first_won, second_won, ' +
        'serve_games, bp_saved, bp_faced). Null for most pre-1991 rows.',
    ),
});

const ArchivePlayersOutput = outputOf({
  players: z.array(ArchiveBioOut).optional().describe('Matching archive people, ordered by name.'),
});

const ArchiveCareerOutput = outputOf({
  player_name: z.string().nullable().optional().describe('The resolved player.'),
  span: z
    .object({
      first: z.string().nullable().describe('First archive match date.'),
      last: z.string().nullable().describe('Last archive match date.'),
    })
    .optional()
    .describe('Career span inside the archive.'),
  record: z
    .object({
      wins: z.number().nullable().describe('Career wins.'),
      losses: z.number().nullable().describe('Career losses.'),
      titles: z.number().nullable().describe('Finals won (excluding abandoned finals).'),
      by_surface: z
        .record(z.object({ wins: z.number().nullable(), losses: z.number().nullable() }))
        .nullable()
        .describe('W-L per surface.'),
      by_level: z
        .record(z.object({ wins: z.number().nullable(), losses: z.number().nullable() }))
        .nullable()
        .describe('W-L per source tier code.'),
    })
    .optional()
    .describe('The W-L record.'),
  by_year: z
    .array(z.object({ year: z.number().nullable(), wins: z.number().nullable(), losses: z.number().nullable() }))
    .optional()
    .describe('Per-season W-L.'),
  serve: z
    .record(z.number().nullable())
    .nullable()
    .optional()
    .describe(
      'Summed serve stats + derived ratios. matches_with_stats states the coverage. Ratios are null where ' +
        'the denominator is zero.',
    ),
});

const H2HOutput = outputOf({
  players: z
    .object({
      p1: z.string().nullable().describe('Resolved name for player1.'),
      p2: z.string().nullable().describe('Resolved name for player2.'),
    })
    .nullable()
    .optional()
    .describe('The resolved names. Null when no player matches the fragments.'),
  totals: z
    .object({
      p1_wins: z.number().nullable().describe('Wins for player1 (of the request).'),
      p2_wins: z.number().nullable().describe('Wins for player2 (of the request).'),
      meetings: z.number().nullable().describe('Meetings with a known winner.'),
      undecided: z.number().nullable().describe('Meetings with no derivable winner. Never counted in wins.'),
    })
    .optional()
    .describe('The headline record.'),
  by_surface: z
    .record(z.object({ p1: z.number().nullable(), p2: z.number().nullable() }))
    .optional()
    .describe('Decided wins per surface. The keys are surface names plus "unknown".'),
  meetings: z.array(H2HMeetingOut).optional().describe('Individual meetings, newest first, capped at 200.'),
});

const RankingsOutput = outputOf({
  rankings: z.array(RankingRowOut).optional().describe('The table in rank order.'),
});

const WinLossOut = z.object({
  matches: z.number().nullable().describe('Matches in the sample.'),
  wins: z.number().nullable().describe('Wins.'),
  losses: z.number().nullable().describe('Losses.'),
  win_pct: z.number().nullable().describe('Win percentage, one decimal; null (never 0) on an empty sample.'),
});

const PlayerStatsOutput = outputOf({
  player: z
    .object({ id: z.number().nullable(), name: z.string().nullable() })
    .optional()
    .describe('The player.'),
  window: z
    .object({ from: z.string().nullable(), to: z.string().nullable() })
    .optional()
    .describe('The window applied, UTC.'),
  overall: WinLossOut.nullable().optional().describe('W/L over the window.'),
  last_12_months: WinLossOut.nullable().optional().describe('W/L over the 12 months ending at the window end.'),
  by_surface: z.record(WinLossOut).nullable().optional().describe('W/L keyed hard, clay, grass, unknown.'),
  by_venue: z.record(WinLossOut).nullable().optional().describe('W/L keyed indoor, outdoor, unknown.'),
  by_level: z.record(WinLossOut).nullable().optional().describe('W/L keyed by match tour, or unknown.'),
  by_season: z.record(WinLossOut).nullable().optional().describe('W/L keyed by UTC calendar year.'),
  sets: z
    .record(z.unknown())
    .nullable()
    .optional()
    .describe(
      'Set-based record: sample, tiebreaks, deciding_sets, after_winning_first_set, ' +
        'after_losing_first_set, comebacks, sets.',
    ),
  withdrawals: z
    .record(z.unknown())
    .nullable()
    .optional()
    .describe('Retired / walkover / default, each as given (this player) and received (the opponent).'),
  recent: z
    .array(
      z.object({
        match_id: z.number().nullable().describe('Match id. Pass to get_match.'),
        date: z.string().nullable().describe('Match date.'),
        tournament: z.string().nullable().describe('Event name.'),
        round: z.string().nullable().describe('Round.'),
        surface: z.string().nullable().describe('Court surface.'),
        opponent: z.string().nullable().describe('Opponent name.'),
        opponent_id: z.number().nullable().describe('Opponent player id.'),
        won: z.boolean().nullable().describe('True when this player won.'),
        outcome: z.string().nullable().describe('completed, retired, walkover or default.'),
        score: z.string().nullable().describe('Final score from this player\'s side, e.g. "6-4 3-6 6-2".'),
      }),
    )
    .optional()
    .describe('The last N matches, newest first.'),
  serve_return: z
    .record(z.unknown())
    .nullable()
    .optional()
    .describe(
      'ULTRA only, null below: summed serve and return statistics, each ratio as ' +
        'numerator/denominator/pct with its match count.',
    ),
});

const PlayerRankingsOutput = outputOf({
  rankings: z.array(RankingRowOut).optional().describe('One record per player × system held.'),
  coverage: z
    .record(z.any())
    .nullable()
    .optional()
    .describe(
      'What resolved against what was asked (players_resolved, systems_resolved, oldest_available ' +
        'per system). Read before trusting an empty result.',
    ),
});

const MatchStatisticsOutput = outputOf({
  statistics: z
    .object({
      coverage: z
        .string()
        .nullable()
        .describe('live | final | stale | none | diverged. Summarises the response.'),
      as_of: z.string().nullable().describe('When the underlying record was last updated (UTC).'),
      games_counted: z
        .number()
        .nullable()
        .describe('Games the derived family covers (tiebreaks excluded, counted separately).'),
      players: z
        .object({ p1: StatsSideOut.nullable(), p2: StatsSideOut.nullable() })
        .nullable()
        .describe('Null when coverage is none. The match exists, and holding nothing is the honest answer.'),
      freshness: z
        .record(z.any())
        .nullable()
        .describe(
          'Per-family coverage/as_of/age. The two ages use DIFFERENT clocks (derived: against the ' +
            'newest score row, measured: wall clock) and must not be compared. On diverged the ' +
            'measured values are withheld and measured_divergence says why.',
        ),
    })
    .optional()
    .describe('The statistics.'),
});

const ChartingPlayerOutput = outputOf({
  player: z.record(z.any()).nullable().optional().describe('The resolved charted player.'),
  matches_charted: z.number().nullable().optional().describe('The sample every summed field covers.'),
  coverage: z.string().nullable().optional().describe('A reminder that charting coverage is curated, not full-slate.'),
  families: z
    .record(z.any())
    .optional()
    .describe("Per-family summed numeric columns: raw sums over the player's charted Total rows."),
});

const ChartingMatchOutput = outputOf({
  charting_match_id: z.number().nullable().optional().describe('The charted match.'),
  mcp_id: z.string().nullable().optional().describe("The Match Charting Project's own row identifier."),
  gender: z.string().nullable().optional(),
  players: z.record(z.any()).nullable().optional().describe('Both players as charted.'),
  families: z.record(z.any()).optional().describe('Every stat family, per player, with the per-set split.'),
});

// -- the tools -----------------------------------------------------------------
// Each `define*` takes the shared context so a whole tool set costs one client.
// The public factories in index.ts build a context per call.

// -- FREE / BASIC --

export const defineGetLiveMatches = (ctx: Context) =>
  tool({
    description:
      'List tennis matches currently in progress, with live scores. Covers ATP, WTA, Challenger, ' +
      'ITF and juniors. Use this for "what tennis is on right now". Works on the FREE plan (no card ' +
      'needed).',
    inputSchema: z.object({
      tour: tourField,
      player: playerFilterField,
      country: countryField,
      limit: limitField(200, 20, 'matches'),
    }),
    outputSchema: LiveMatchesOutput,
    execute: ({ tour, player, country, limit }): Promise<z.infer<typeof LiveMatchesOutput>> =>
      ctx.guard(LiveMatchesOutput, async () => {
        const page = await ctx.client.listMatches({ status: 'live', tour, player, country: country?.toLowerCase(), limit });
        if (!page.data.length) {
          return { ok: true as const, message: 'No matches are live right now.', matches: [] };
        }
        return {
          ok: true as const,
          message: `${page.data.length} live match(es):\n\n${page.data.map(summarise).join('\n\n')}`,
          matches: page.data.map(matchOut),
        };
      }),
  });

export const defineGetUpcomingMatches = (ctx: Context) =>
  tool({
    description:
      'List tennis matches scheduled to start soon, with players, tournament and start time. Use ' +
      'this for "who plays next" or to find a match id before it starts. Works on the FREE plan (no ' +
      'card needed).',
    inputSchema: z.object({
      tour: tourField,
      player: playerFilterField,
      country: countryField,
      from: fromField,
      to: toField,
      limit: limitField(200, 20, 'matches'),
    }),
    outputSchema: UpcomingMatchesOutput,
    execute: ({ tour, player, country, from, to, limit }): Promise<z.infer<typeof UpcomingMatchesOutput>> =>
      ctx.guard(UpcomingMatchesOutput, async () => {
        const page = await ctx.client.listMatches({
          status: 'upcoming',
          tour,
          player,
          country: country?.toLowerCase(),
          from,
          to,
          limit,
        });
        if (!page.data.length) {
          return { ok: true as const, message: 'No upcoming matches are scheduled.', matches: [] };
        }
        return {
          ok: true as const,
          message: `${page.data.length} upcoming match(es):\n\n${page.data.map(summarise).join('\n\n')}`,
          matches: page.data.map(matchOut),
        };
      }),
  });

export const defineGetMatch = (ctx: Context) =>
  tool({
    description:
      'Full detail for one match by id: players, score, surface, round and status. Includes market ' +
      'prices on PRO and model analysis on ULTRA. Works on the FREE plan (no card needed).',
    inputSchema: z.object({ match_id: matchIdField }),
    outputSchema: MatchOutput,
    execute: ({ match_id }): Promise<z.infer<typeof MatchOutput>> =>
      ctx.guard(MatchOutput, async () => {
        const match = await ctx.client.getMatch(match_id);
        if (!match) return { ok: true as const, message: 'No data returned for that match id.' };
        // `message` is assembled alongside the structured fields and written to
        // `out` last, so the prose and the data can never describe different
        // halves of the same response.
        let message = summarise(match);
        const out: z.infer<typeof MatchOutput> = { ok: true, message: '', match: matchOut(match) };
        if (match.market) {
          message += `\n\nMarket: ${match.market.question ?? '-'}`;
          for (const price of match.market.prices ?? []) {
            message += `\n  Side ${price.side}: mid ${price.mid ?? '-'} (bid ${price.bid ?? '-'} / ask ${price.ask ?? '-'})`;
          }
          out.market = {
            question: n(match.market.question),
            prices: (match.market.prices ?? []).map((p) => ({
              side: n(p.side),
              mid: n(p.mid),
              bid: n(p.bid),
              ask: n(p.ask),
              timestamp: n(p.timestamp),
            })),
          };
        }
        if (match.analysis?.profile) {
          const profile = match.analysis.profile;
          message += `\n\nModel analysis:`;
          if (profile.win_probability_p1 != null) {
            message += `\n  Win probability (player 1): ${(profile.win_probability_p1 * 100).toFixed(1)}%`;
          }
          if (profile.key_factors?.length) message += `\n  Main factors: ${profile.key_factors.join(' · ')}`;
          out.analysis = {
            win_probability_p1: n(profile.win_probability_p1),
            key_factors: profile.key_factors ?? [],
          };
        }
        out.message = message;
        return out;
      }),
  });

export const defineGetMatchScore = (ctx: Context) =>
  tool({
    description:
      'Current score for one match. This is the fastest read, with the lowest latency. Use it when ' +
      'you only need the score and already know the match id. Works on the FREE plan (no card ' +
      'needed).',
    inputSchema: z.object({ match_id: matchIdField }),
    outputSchema: MatchScoreOutput,
    execute: ({ match_id }): Promise<z.infer<typeof MatchScoreOutput>> =>
      ctx.guard(MatchScoreOutput, async () => {
        const score = await ctx.client.getMatchScore(match_id);
        if (!score) return { ok: true as const, message: 'No score available for that match yet.' };
        const parts = [`Score: ${formatScore(score)}`];
        if (score.sets) parts.push(`Sets: ${score.sets.join('-')}`);
        if (score.server) parts.push(`Serving: player ${score.server}`);
        if (score.is_tiebreak) parts.push('In a tiebreak');
        if (score.win_probability_p1 != null) {
          parts.push(`Model win probability (player 1): ${(score.win_probability_p1 * 100).toFixed(1)}%`);
        }
        return {
          ok: true as const,
          message: parts.join('\n'),
          score: {
            formatted: formatScore(score),
            sets: n(score.sets),
            serving: n(score.server),
            is_tiebreak: n(score.is_tiebreak),
            win_probability_p1: n(score.win_probability_p1),
          },
        };
      }),
  });

export const defineSearchPlayers = (ctx: Context) =>
  tool({
    description:
      'Search tennis players by name. Returns id, country, ranking and tour. Use the returned id ' +
      'with get_player. Works on the FREE plan (no card needed).',
    inputSchema: z.object({
      query: z.string().min(1).describe('Full or partial player name, e.g. "alcaraz".'),
      limit: limitField(200, 10, 'players'),
    }),
    outputSchema: SearchPlayersOutput,
    execute: ({ query, limit }): Promise<z.infer<typeof SearchPlayersOutput>> =>
      ctx.guard(SearchPlayersOutput, async () => {
        const page = await ctx.client.searchPlayers(query, { limit });
        if (!page.data.length) {
          return { ok: true as const, message: `No players matched "${query}".`, players: [] };
        }
        return {
          ok: true as const,
          message: page.data
            .map(
              (p) =>
                `[${p.id}] ${p.name ?? '?'}${p.country ? ` (${p.country})` : ''}` +
                `${p.ranking != null ? `, rank ${p.ranking}` : ''}${p.tour ? ` · ${p.tour}` : ''}`,
            )
            .join('\n'),
          players: page.data.map((p) => ({
            id: n(p.id),
            name: n(p.name),
            country: n(p.country),
            ranking: n(p.ranking),
            ranking_points: n(p.ranking_points),
            ranking_movement: n(p.ranking_movement),
            hand: n(p.hand),
            birthday: n(p.birthday),
            tour: n(p.tour),
          })),
        };
      }),
  });

export const defineGetPlayer = (ctx: Context) =>
  tool({
    description:
      'One player\'s profile: ranking, country, handedness, date of birth and cached stats. Works on ' +
      'the FREE plan (no card needed).',
    inputSchema: z.object({
      player_id: z.number().int().describe('Player id, as returned by search_players.'),
    }),
    outputSchema: PlayerOutput,
    execute: ({ player_id }): Promise<z.infer<typeof PlayerOutput>> =>
      ctx.guard(PlayerOutput, async () => {
        const p = await ctx.client.getPlayer(player_id);
        if (!p) return { ok: true as const, message: 'No data returned for that player id.' };
        const rows = [
          `${p.name ?? 'Unknown'} [${p.id}]`,
          p.country ? `Country: ${p.country}` : null,
          p.ranking != null ? `Ranking: ${p.ranking}${p.ranking_points ? ` (${p.ranking_points} pts)` : ''}` : null,
          p.ranking_movement ? `Movement: ${p.ranking_movement}` : null,
          p.hand ? `Plays: ${p.hand === 'R' ? 'right-handed' : 'left-handed'}` : null,
          p.birthday ? `Born: ${p.birthday}` : null,
          p.tour ? `Tour: ${p.tour}` : null,
        ].filter(Boolean);
        return {
          ok: true as const,
          message: rows.join('\n'),
          player: {
            id: n(p.id),
            name: n(p.name),
            country: n(p.country),
            ranking: n(p.ranking),
            ranking_points: n(p.ranking_points),
            ranking_movement: n(p.ranking_movement),
            hand: n(p.hand),
            birthday: n(p.birthday),
            tour: n(p.tour),
          },
        };
      }),
  });

export const defineGetFixtures = (ctx: Context) =>
  tool({
    description:
      'Upcoming scheduled tennis fixtures, earliest first. This is the forward schedule, filterable ' +
      'by tour. Use this for "what is on this week". Works on the FREE plan (no card needed).',
    inputSchema: z.object({ tour: tourField, limit: limitField(200, 20, 'fixtures') }),
    outputSchema: FixturesOutput,
    execute: ({ tour, limit }): Promise<z.infer<typeof FixturesOutput>> =>
      ctx.guard(FixturesOutput, async () => {
        const page = await ctx.client.listFixtures({ tour, limit });
        if (!page.data.length) return { ok: true as const, message: 'No upcoming fixtures.', fixtures: [] };
        return {
          ok: true as const,
          message: page.data
            .map(
              (f) =>
                `${f.start_time ?? f.event_date ?? '?'} · ${f.tournament ?? '?'}` +
                `${f.round ? ` (${f.round})` : ''}: ${f.player1_name ?? '?'} vs ${f.player2_name ?? '?'}`,
            )
            .join('\n'),
          fixtures: page.data.map((f) => ({
            event_date: n(f.event_date),
            start_time: n(f.start_time),
            tournament: n(f.tournament),
            round: n(f.round),
            player1: n(f.player1_name),
            player2: n(f.player2_name),
          })),
        };
      }),
  });

export const defineSearchTournaments = (ctx: Context) =>
  tool({
    description:
      'Search the tournament catalogue. Its ids are the tournament_id that match objects carry. ' +
      'Returns surface, indoor, host city/country and category where curated. Works on the FREE ' +
      'plan (no card needed).',
    inputSchema: z.object({
      query: z.string().optional().describe('Full or partial tournament name, e.g. "wimbledon". Omit to list all.'),
      tour: z
        .enum(['atp', 'wta', 'challenger', 'itf', 'juniors'])
        .optional()
        .describe('Restrict to one tour.'),
      limit: limitField(200, 20, 'tournaments'),
    }),
    outputSchema: TournamentsOutput,
    execute: ({ query, tour, limit }): Promise<z.infer<typeof TournamentsOutput>> =>
      ctx.guard(TournamentsOutput, async () => {
        const page = await ctx.client.listTournaments({ search: query, tour, limit });
        if (!page.data.length) {
          return {
            ok: true as const,
            message: query ? `No tournaments matched "${query}".` : 'No tournaments found.',
            tournaments: [],
          };
        }
        return {
          ok: true as const,
          message: page.data
            .map(
              (t) =>
                `[${t.id}] ${t.name ?? '?'}${t.tour ? ` · ${t.tour}` : ''}` +
                `${t.surface ? ` · ${t.surface}${t.indoor ? ' (indoor)' : ''}` : ''}` +
                `${t.city ? ` · ${t.city}${t.country ? `, ${t.country}` : ''}` : ''}` +
                `${t.category ? ` · ${t.category}` : ''}`,
            )
            .join('\n'),
          tournaments: page.data.map(tournamentOut),
        };
      }),
  });

export const defineGetTournament = (ctx: Context) =>
  tool({
    description:
      'One tournament by its stable id, the tournament_id carried on match objects. Name, tour, ' +
      'surface, indoor, plus host city/country and category where curated. Works on the FREE plan ' +
      '(no card needed).',
    inputSchema: z.object({
      tournament_id: z
        .string()
        .describe('Stable tournament id, as returned by search_tournaments or carried on a match as tournament_id.'),
    }),
    outputSchema: TournamentOutput,
    execute: ({ tournament_id }): Promise<z.infer<typeof TournamentOutput>> =>
      ctx.guard(TournamentOutput, async () => {
        const t = await ctx.client.getTournament(tournament_id);
        if (!t) return { ok: true as const, message: 'No data returned for that tournament id.' };
        const rows = [
          `${t.name ?? 'Unknown'} [${t.id}]`,
          t.tour ? `Tour: ${t.tour}` : null,
          t.surface ? `Surface: ${t.surface}${t.indoor ? ' (indoor)' : ''}` : null,
          t.city ? `Location: ${t.city}${t.country ? `, ${t.country}` : ''}` : null,
          t.category ? `Category: ${t.category}` : null,
        ].filter(Boolean);
        return { ok: true as const, message: rows.join('\n'), tournament: tournamentOut(t) };
      }),
  });

export const defineGetRecentResults = (ctx: Context) =>
  tool({
    description:
      'Recently completed tennis matches with final scores and winners. Filterable by tour, player, ' +
      'nationality and play date. Requires the BASIC plan or any History plan.',
    inputSchema: z.object({
      tour: tourField,
      player: playerFilterField,
      country: countryField,
      from: fromField,
      to: toField,
      limit: limitField(200, 20, 'matches'),
    }),
    outputSchema: RecentResultsOutput,
    execute: ({ tour, player, country, from, to, limit }): Promise<z.infer<typeof RecentResultsOutput>> =>
      ctx.guard(RecentResultsOutput, async () => {
        const page = await ctx.client.listCompletedMatches({
          tour,
          player,
          country: country?.toLowerCase(),
          from,
          to,
          limit,
        });
        if (!page.data.length) {
          return { ok: true as const, message: 'No completed matches available.', matches: [] };
        }
        return {
          ok: true as const,
          message: page.data.map(summarise).join('\n\n'),
          matches: page.data.map(matchOut),
        };
      }),
  });

export const defineSearchArchiveMatches = (ctx: Context) =>
  tool({
    description:
      'Search the results archive: completed-match RESULTS from 1968 through 2022. ATP and WTA, ' +
      'main draws, qualifying and the ITF/futures tiers. Each record has winner and loser, final ' +
      'score, and seeds and ranks AT THE TIME of the match. Use this for historical questions ' +
      '("Borg\'s Wimbledon finals"). The archive ends 2022-12-31, where our own results ' +
      '(get_recent_results) begin. Requires the BASIC plan or any History plan.',
    inputSchema: z.object({
      player_name: z
        .string()
        .min(3)
        .optional()
        .describe('Case-insensitive fragment of EITHER player\'s name, min 3 chars, e.g. "borg".'),
      tour: z.enum(['atp', 'wta']).optional().describe('atp or wta.'),
      from: z.string().optional().describe('Earliest tournament START date, YYYY-MM-DD.'),
      to: z.string().optional().describe('Latest tournament START date, YYYY-MM-DD.'),
      round: z
        .enum(['F', 'SF', 'QF', 'R16', 'R32', 'R64', 'R128', 'RR', 'BR', 'Q1', 'Q2', 'Q3', 'Q4', 'ER'])
        .optional()
        .describe('Round code, e.g. F for finals.'),
      level: z
        .string()
        .optional()
        .describe(
          'Source tier code: G=grand slam, M=masters, A=tour, F=finals, D=davis cup, C=challenger, ' +
            'O=olympics. Or a futures category code (e.g. 15).',
        ),
      limit: limitField(200, 20, 'results'),
    }),
    outputSchema: ArchiveMatchesOutput,
    execute: ({ player_name, tour, from, to, round, level, limit }): Promise<z.infer<typeof ArchiveMatchesOutput>> =>
      ctx.guard(ArchiveMatchesOutput, async () => {
        const page = await ctx.client.listArchiveMatches({ name: player_name, tour, from, to, round, level, limit });
        if (!page.data.length) {
          return {
            ok: true as const,
            message:
              'No archive results matched. The results archive covers 1968 through 2022. For 2023 ' +
              'onward use get_recent_results.',
            results: [],
          };
        }
        return {
          ok: true as const,
          message: page.data.map(summariseArchive).join('\n\n'),
          results: page.data.map(archiveMatchOut),
        };
      }),
  });

export const defineGetArchiveMatch = (ctx: Context) =>
  tool({
    description:
      'One result from the results archive (1968 to 2022), with per-match serve statistics where ' +
      'the era recorded them. Stats are null for most rows before 1991, never synthesised. Requires ' +
      'the BASIC plan or any History plan.',
    inputSchema: z.object({
      archive_match_id: z.number().int().describe('Archive match id, as returned by search_archive_matches.'),
    }),
    outputSchema: ArchiveMatchOutput,
    execute: ({ archive_match_id }): Promise<z.infer<typeof ArchiveMatchOutput>> =>
      ctx.guard(ArchiveMatchOutput, async () => {
        const m = await ctx.client.getArchiveMatch(archive_match_id);
        if (!m) return { ok: true as const, message: 'No data returned for that archive match id.' };
        let message = summariseArchive(m);
        const out: z.infer<typeof ArchiveMatchOutput> = { ok: true, message: '', result: archiveMatchOut(m) };
        if (m.stats) {
          const line = (label: string, s: Record<string, unknown> | null | undefined) =>
            s ? `  ${label}: ${Object.entries(s).map(([k, v]) => `${k}=${v ?? '-'}`).join(' · ')}` : null;
          message += ['\n\nServe statistics:', line('winner', m.stats.winner), line('loser', m.stats.loser)]
            .filter(Boolean)
            .join('\n');
          out.stats = {
            winner: numRecord(m.stats.winner),
            loser: numRecord(m.stats.loser),
          };
        } else {
          message += '\n\nNo serve statistics. The corpus records them from 1991 only, so this null is honest.';
          out.stats = null;
        }
        out.message = message;
        return out;
      }),
  });

export const defineSearchArchivePlayers = (ctx: Context) =>
  tool({
    description:
      'The people of the results archive (1968 to 2022): hand, date of birth, country, height, and ' +
      'career-high rank with the week it was first reached. Their ids are corpus person ids (the ' +
      'winner/loser player_id on archive results), not roster ids. For current players use ' +
      'search_players. Requires the BASIC plan or any History plan.',
    inputSchema: z.object({
      query: z.string().min(3).describe('Full or partial player name, min 3 chars, e.g. "navratilova".'),
      tour: z.enum(['atp', 'wta']).optional().describe('atp or wta.'),
      limit: limitField(200, 10, 'players'),
    }),
    outputSchema: ArchivePlayersOutput,
    execute: ({ query, tour, limit }): Promise<z.infer<typeof ArchivePlayersOutput>> =>
      ctx.guard(ArchivePlayersOutput, async () => {
        const page = await ctx.client.listArchivePlayers({ name: query, tour, limit });
        if (!page.data.length) {
          return { ok: true as const, message: `No archive players matched "${query}".`, players: [] };
        }
        return {
          ok: true as const,
          message: page.data
            .map(
              (p) =>
                `[${p.id}] ${p.name ?? '?'}${p.country ? ` (${p.country})` : ''}${p.tour ? ` · ${p.tour}` : ''}` +
                `${p.hand ? ` · ${p.hand}` : ''}${p.dob ? ` · b. ${p.dob}` : ''}` +
                `${p.career_high_rank != null ? ` · career high ${p.career_high_rank}${p.career_high_date ? ` (${p.career_high_date})` : ''}` : ''}`,
            )
            .join('\n'),
          players: page.data.map((p) => ({
            id: n(p.id),
            tour: n(p.tour),
            name: n(p.name),
            hand: n(p.hand),
            dob: n(p.dob),
            country: n(p.country),
            height_cm: n(p.height_cm),
            career_high_rank: n(p.career_high_rank),
            career_high_date: n(p.career_high_date),
          })),
        };
      }),
  });

export const defineGetArchiveCareer = (ctx: Context) =>
  tool({
    description:
      'One player\'s whole career over the results archive (1968 to 2022). W-L record in total and ' +
      'by surface/level/year, titles, and summed serve statistics. The corpus records serve stats ' +
      'from 1991 only, so matches_with_stats says how many matches the serve block covers. The name ' +
      'must resolve to one person. An ambiguous fragment returns the candidate list to choose from. ' +
      'Requires the BASIC plan or any History plan.',
    inputSchema: z.object({
      name: z.string().min(3).describe('Player name fragment, min 3 chars. Must resolve to exactly one person.'),
    }),
    outputSchema: ArchiveCareerOutput,
    execute: ({ name }): Promise<z.infer<typeof ArchiveCareerOutput>> =>
      ctx.guard(ArchiveCareerOutput, async () => {
        const career = await ctx.client.getArchiveCareer(name);
        if (!career) return { ok: true as const, message: 'No archive career found for that name.' };
        const rec = career.record ?? {};
        const lines = [
          `${career.player?.name ?? name}, results archive (1968 to 2022)`,
          `Record: ${rec.wins ?? 0}-${rec.losses ?? 0}, ${rec.titles ?? 0} title(s)` +
            `${career.span?.first ? ` · ${career.span.first} → ${career.span.last ?? '?'}` : ''}`,
        ];
        if (rec.by_surface && Object.keys(rec.by_surface).length) {
          lines.push(
            `By surface: ${Object.entries(rec.by_surface)
              .map(([s, wl]) => `${s} ${wl?.wins ?? 0}-${wl?.losses ?? 0}`)
              .join(' · ')}`,
          );
        }
        const serve = career.serve;
        if (serve?.matches_with_stats) {
          lines.push(
            `Serve (over ${serve.matches_with_stats} matches with stats): ` +
              `${serve.aces ?? 0} aces (${serve.aces_per_match ?? '-'}/match) · ` +
              `1st in ${serve.first_in_pct ?? '-'} · 1st won ${serve.first_won_pct ?? '-'} · ` +
              `BP saved ${serve.bp_saved_pct ?? '-'}`,
          );
        } else {
          lines.push('Serve stats: none. The corpus records them from 1991 only.');
        }
        return {
          ok: true as const,
          message: lines.join('\n'),
          player_name: n(career.player?.name),
          span: { first: n(career.span?.first), last: n(career.span?.last) },
          record: {
            wins: num(rec.wins),
            losses: num(rec.losses),
            titles: num(rec.titles),
            by_surface: wlRecord(rec.by_surface),
            by_level: wlRecord(rec.by_level),
          },
          by_year: (career.by_year ?? []).map((y) => ({ year: num(y.year), wins: num(y.wins), losses: num(y.losses) })),
          serve: numRecord(serve),
        };
      }),
  });

export const defineGetH2H = (ctx: Context) =>
  tool({
    description:
      'The all-time record between two players, across BOTH halves of the product. That is the ' +
      'results archive (1968 to 2022) plus our own completed matches (2023 onward). Names are the ' +
      'keys. An ambiguous fragment returns the candidate list to choose from, and nothing is ' +
      'guessed. Totals count only meetings with a known winner. Walkovers and retirements are part ' +
      'of the record, and each meeting carries its outcome. Requires the BASIC plan or any History ' +
      'plan.',
    inputSchema: z.object({
      player1: z.string().min(3).describe('First player name (fragment, min 3 chars), e.g. "federer".'),
      player2: z.string().min(3).describe('Second player name (fragment, min 3 chars), e.g. "nadal".'),
    }),
    outputSchema: H2HOutput,
    execute: ({ player1, player2 }): Promise<z.infer<typeof H2HOutput>> =>
      ctx.guard(H2HOutput, async () => {
        const h2h = await ctx.client.getH2H(player1, player2);
        if (!h2h || !h2h.players) {
          return {
            ok: true as const,
            message: `No player matched "${player1}" and/or "${player2}" in either era.`,
            players: null,
          };
        }
        const p1 = h2h.players.p1?.name ?? player1;
        const p2 = h2h.players.p2?.name ?? player2;
        const t = h2h.totals ?? {};
        const lines = [
          `${p1} vs ${p2}: ${t.p1_wins ?? 0}-${t.p2_wins ?? 0}` +
            `${t.undecided ? ` (+${t.undecided} undecided)` : ''}`,
        ];
        if (h2h.by_surface && Object.keys(h2h.by_surface).length) {
          lines.push(
            `By surface: ${Object.entries(h2h.by_surface)
              .map(([s, wl]) => `${s} ${wl?.p1 ?? 0}-${wl?.p2 ?? 0}`)
              .join(' · ')}`,
          );
        }
        const meetings = h2h.meetings ?? [];
        if (meetings.length) {
          lines.push('', `Meetings (newest first, ${meetings.length}):`);
          for (const m of meetings.slice(0, 20)) {
            const who = m.winner === 1 ? p1 : m.winner === 2 ? p2 : '?';
            lines.push(
              `  ${m.date ?? '?'} ${m.tournament ?? '?'}${m.round ? ` (${m.round})` : ''}: ` +
                `${who} won${m.score ? ` ${m.score}` : ''}${m.era === 'archive' ? ' · archive' : ''}` +
                `${m.outcome && m.outcome !== 'completed' ? ` · ${m.outcome}` : ''}`,
            );
          }
          if (meetings.length > 20) lines.push(`  … ${meetings.length - 20} more in the structured half.`);
        }
        return {
          ok: true as const,
          message: lines.join('\n'),
          players: { p1: n(h2h.players.p1?.name), p2: n(h2h.players.p2?.name) },
          totals: {
            p1_wins: n(t.p1_wins),
            p2_wins: n(t.p2_wins),
            meetings: n(t.meetings),
            undecided: n(t.undecided),
          },
          by_surface: Object.fromEntries(
            Object.entries(h2h.by_surface ?? {}).map(([s, wl]) => [s, { p1: n(wl?.p1), p2: n(wl?.p2) }]),
          ),
          meetings: meetings.map((m) => ({
            era: n(m.era),
            date: n(m.date),
            tournament: n(m.tournament),
            round: n(m.round ?? m.round_code),
            surface: n(m.surface),
            score: n(m.score),
            outcome: n(m.outcome),
            winner: n(m.winner),
            match_id: n(m.match_id),
          })),
        };
      }),
  });

// -- PRO --

export const defineGetMatchEvents = (ctx: Context) =>
  tool({
    description:
      'Timeline of events for a match: breaks, games won, sets won, momentum runs. Requires the PRO ' +
      'plan.',
    inputSchema: z.object({ match_id: matchIdField, limit: limitField(200, 30, 'events') }),
    outputSchema: MatchEventsOutput,
    execute: ({ match_id, limit }): Promise<z.infer<typeof MatchEventsOutput>> =>
      ctx.guard(MatchEventsOutput, async () => {
        const page = await ctx.client.listMatchEvents(match_id, { limit });
        if (!page.data.length) {
          return { ok: true as const, message: 'No events recorded for this match.', events: [] };
        }
        return {
          ok: true as const,
          message: page.data
            .map((e) => `${e.timestamp ?? '?'} · ${e.type ?? '?'}${e.player ? ` (player ${e.player})` : ''}`)
            .join('\n'),
          events: page.data.map((e) => ({ timestamp: n(e.timestamp), type: n(e.type), player: n(e.player) })),
        };
      }),
  });

export const defineGetMatchOdds = (ctx: Context) =>
  tool({
    description:
      'Match-winner market prices for a match: implied probability per player, with bid, ask and ' +
      'mid. Requires the PRO plan. Match rows carry has_market, so check it first. A match with no ' +
      'market mapped has no prices to return.',
    inputSchema: z.object({ match_id: matchIdField, limit: limitField(200, 10, 'price points') }),
    outputSchema: MatchOddsOutput,
    execute: ({ match_id, limit }): Promise<z.infer<typeof MatchOddsOutput>> =>
      ctx.guard(MatchOddsOutput, async () => {
        const market = await ctx.client.getMarketPrices(match_id, { limit });
        if (!market) return { ok: true as const, message: 'No market data for that match.' };
        const lines = [`Market: ${market.question ?? '-'}`];
        if (market.status) lines.push(`Status: ${market.status}`);
        if (market.volume != null) lines.push(`24h volume: ${market.volume}`);
        if (market.liquidity != null) lines.push(`Liquidity: ${market.liquidity}`);
        lines.push('', 'Recent prices (newest first):');
        for (const p of market.prices ?? []) {
          lines.push(
            `  side ${p.side}: mid ${p.mid ?? '-'} · bid ${p.bid ?? '-'} · ask ${p.ask ?? '-'}` +
              `${p.timestamp ? ` @ ${p.timestamp}` : ''}`,
          );
        }
        return {
          ok: true as const,
          message: lines.join('\n'),
          market: {
            question: n(market.question),
            status: n(market.status),
            volume: n(market.volume),
            liquidity: n(market.liquidity),
            prices: (market.prices ?? []).map((p) => ({
              side: n(p.side),
              mid: n(p.mid),
              bid: n(p.bid),
              ask: n(p.ask),
              timestamp: n(p.timestamp),
            })),
          },
        };
      }),
  });

export const defineGetRankings = (ctx: Context) =>
  tool({
    description:
      'The FULL published ranking table in rank order for one system, from the newest week at or ' +
      'before as_of. Rows carry player_name as published and a null player_id for players outside ' +
      'our roster, so the table has no silent holes. ATP/WTA history runs deep. The ITF circuits ' +
      'begin 2026-07-29. For point-in-time records of SPECIFIC players use get_player_rankings. ' +
      'Requires the PRO plan.',
    inputSchema: z.object({
      system: z
        .enum(['atp', 'wta', 'itf_jt', 'itf_mt', 'itf_wt'])
        .describe('Ranking system to list. utr has no listing, because it is a rating, not a ranking.'),
      as_of: z
        .string()
        .optional()
        .describe('YYYY-MM-DD. Serves the newest published week at or before this date. Omit for latest.'),
      limit: limitField(200, 20, 'ranking rows'),
    }),
    outputSchema: RankingsOutput,
    execute: ({ system, as_of, limit }): Promise<z.infer<typeof RankingsOutput>> =>
      ctx.guard(RankingsOutput, async () => {
        const res = await ctx.client.listRankings({ system, as_of, limit });
        const rows = res.data ?? [];
        if (!rows.length) {
          return {
            ok: true as const,
            message: `No ${system} ranking table for that date. ITF history begins 2026-07-29 and cannot be reconstructed earlier.`,
            rankings: [],
          };
        }
        const week = rows[0]?.effective_date;
        return {
          ok: true as const,
          message:
            `${system} rankings${week ? `, week of ${week}` : ''}${as_of ? ` (as of ${as_of})` : ''}:\n` +
            rows.map(rankingLine).join('\n'),
          rankings: rows.map(rankingRowOut),
        };
      }),
  });

export const definePlayerStats = (ctx: Context) =>
  tool({
    // Word for word the description of livetennisapi-mcp's player_stats.
    description:
      "One player's record over our own completed singles matches (2023 onward), by default the last " +
      '365 days. It gives W/L overall, over the last 12 months and by surface, venue, level and season. ' +
      'It also gives tiebreaks, deciding sets, the record after winning or losing the first set, ' +
      'comebacks, withdrawals and the last N matches. Every count carries its sample size, and a ' +
      'percentage on an empty sample is null, never 0. On ULTRA it adds serve_return: measured serve ' +
      'and return statistics summed over the window. Singles only, so a doubles-team id is refused. ' +
      'For 1968 to 2022 use get_archive_career. Requires the PRO plan (serve_return requires ULTRA).',
    inputSchema: z.object({
      player_id: z.number().int().describe('Player id, as returned by search_players.'),
      from: z
        .string()
        .optional()
        .describe('Window start: YYYY-MM-DD (start of that day) or a UTC ISO-8601 instant. Default to minus 365 days.'),
      to: z
        .string()
        .optional()
        .describe('Window end: YYYY-MM-DD (the whole of that day) or a UTC ISO-8601 instant. Default now.'),
      surface: z
        .enum(['hard', 'clay', 'grass', 'indoor'])
        .optional()
        .describe('hard, clay or grass read the match surface; indoor keeps matches stated indoor, on any surface.'),
      level: z
        .enum(['atp', 'wta', 'challenger', 'itf', 'juniors'])
        .optional()
        .describe('The match tour. A match with no stated tour matches no level.'),
      last: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('How many recent matches to list, newest first (1-50, default 20).'),
    }),
    outputSchema: PlayerStatsOutput,
    execute: ({ player_id, from, to, surface, level, last }): Promise<z.infer<typeof PlayerStatsOutput>> =>
      ctx.guard(PlayerStatsOutput, async () => {
        const body = await ctx.client.getPlayerStats(player_id, { from, to, surface, level, last });
        // Every block is read by type: the server shapes these objects freely,
        // and one stray value would fail the schema the result is parsed against.
        const r = plainObject(body?.records);
        if (!r) return { ok: true as const, message: 'No record returned for that player id.' };
        const player = { id: num(body.player?.id), name: str(body.player?.name) };
        const window = { from: str(body.window?.from), to: str(body.window?.to) };
        const overall = winLossOut(r.overall);
        const last12 = winLossOut(r.last_12_months);
        const bySurface = winLossRecord(r.by_surface);
        const recent = (Array.isArray(r.recent) ? r.recent : []).map((item: unknown) => {
          const m = plainObject(item) ?? {};
          const opponent = plainObject(m.opponent);
          return {
            match_id: num(m.match_id),
            date: str(m.date),
            tournament: str(m.tournament),
            round: str(m.round),
            surface: str(m.surface),
            opponent: str(opponent?.name),
            opponent_id: num(opponent?.id),
            won: bool(m.won),
            outcome: str(m.outcome),
            score: sideScore(m.score),
          };
        });
        const lines = [
          `${player.name ?? 'Player'} [${player.id ?? player_id}], ${window.from ?? '?'} → ${window.to ?? '?'}`,
          `Overall: ${winLossLine(overall)} · last 12 months: ${winLossLine(last12)}`,
        ];
        if (bySurface && Object.keys(bySurface).length) {
          lines.push(
            `By surface: ${Object.entries(bySurface)
              .map(([s, wl]) => `${s} ${winLossLine(wl)}`)
              .join(' · ')}`,
          );
        }
        if (recent.length) {
          lines.push(
            `Recent (${recent.length}):`,
            ...recent.map(
              (m) =>
                `  ${m.date ?? '?'} ${m.won === true ? 'W' : m.won === false ? 'L' : '?'} vs ${m.opponent ?? '?'}` +
                `${m.score ? ` ${m.score}` : ''}${m.outcome && m.outcome !== 'completed' ? ` (${m.outcome})` : ''}` +
                `${m.tournament ? `, ${m.tournament}` : ''}`,
            ),
          );
        }
        // serve_return is absent below ULTRA. It is passed through as the
        // server sent it, like the MCP server does.
        const serveReturn = plainObject(body.serve_return);
        if (serveReturn) {
          lines.push(
            `Serve/return: summed over ${num(serveReturn.matches_with_stats) ?? 0} of ` +
              `${num(serveReturn.matches) ?? 0} matches with statistics.`,
          );
        }
        return {
          ok: true as const,
          message: lines.join('\n'),
          player,
          window,
          overall,
          last_12_months: last12,
          by_surface: bySurface,
          by_venue: winLossRecord(r.by_venue),
          by_level: winLossRecord(r.by_level),
          by_season: winLossRecord(r.by_season),
          sets: plainObject(r.sets),
          withdrawals: plainObject(r.withdrawals),
          recent,
          serve_return: serveReturn,
        };
      }),
  });

// -- ULTRA --

export const defineGetMatchAnalysis = (ctx: Context) =>
  tool({
    description:
      'Model analysis for a match: predicted win probability, the model\'s thesis and the main ' +
      'factors behind it. Requires the ULTRA plan. Match rows carry has_analysis, so check it ' +
      'first. A match with no thesis or profile has nothing to return.',
    inputSchema: z.object({ match_id: matchIdField }),
    outputSchema: MatchAnalysisOutput,
    execute: ({ match_id }): Promise<z.infer<typeof MatchAnalysisOutput>> =>
      ctx.guard(MatchAnalysisOutput, async () => {
        const analysis = await ctx.client.getMatchAnalysis(match_id);
        if (!analysis || (!analysis.thesis && !analysis.profile)) {
          return { ok: true as const, message: 'No model analysis exists for this match yet.' };
        }
        const lines: string[] = [];
        const out: z.infer<typeof MatchAnalysisOutput> = { ok: true, message: '' };
        if (analysis.profile) {
          const p = analysis.profile;
          lines.push('Profile:');
          if (p.win_probability_p1 != null) {
            lines.push(`  Win probability (player 1): ${(p.win_probability_p1 * 100).toFixed(1)}%`);
          }
          if (p.expected_closeness != null) lines.push(`  Expected closeness: ${p.expected_closeness}`);
          if (p.volatility_rating) lines.push(`  Volatility: ${p.volatility_rating}`);
          if (p.key_factors?.length) lines.push(`  Main factors: ${p.key_factors.join(' · ')}`);
          out.profile = {
            win_probability_p1: n(p.win_probability_p1),
            expected_closeness: n(p.expected_closeness),
            volatility_rating: n(p.volatility_rating),
            key_factors: p.key_factors ?? [],
          };
        }
        if (analysis.thesis) {
          const t = analysis.thesis;
          lines.push('', 'Thesis:');
          if (t.pick_side) lines.push(`  Pick: player ${t.pick_side}`);
          if (t.confidence != null) lines.push(`  Confidence: ${(t.confidence * 100).toFixed(0)}%`);
          if (t.state) lines.push(`  State: ${t.state}`);
          if (t.reasoning) lines.push(`  Reasoning: ${t.reasoning}`);
          out.thesis = {
            pick_side: n(t.pick_side),
            confidence: n(t.confidence),
            state: n(t.state),
            reasoning: n(t.reasoning),
          };
        }
        out.message = lines.join('\n');
        return out;
      }),
  });

export const defineGetPlayerRankings = (ctx: Context) =>
  tool({
    description:
      'Point-in-time ranking records for SPECIFIC players. Per system, the newest record in force ' +
      'ON OR BEFORE as_of, never one dated after it. Every other ranking field in this API is the ' +
      'CURRENT value joined at read time. This one is the historical answer. Systems are never ' +
      'collapsed: ATP/WTA and the ITF circuits carry rank+points, UTR a rating. ITF and UTR history ' +
      'begins 2026-07-29. Requires the ULTRA plan.',
    inputSchema: z.object({
      player_ids: z
        .array(z.number().int())
        .min(1)
        .max(50)
        .describe('Roster player ids, as returned by search_players. Max 50.'),
      as_of: z
        .string()
        .optional()
        .describe('YYYY-MM-DD. The record in force on this date. Omit for the latest known.'),
      system: z
        .enum(['atp', 'wta', 'itf_jt', 'itf_mt', 'itf_wt', 'utr'])
        .optional()
        .describe('Restrict to one system. Omit for every system held for the player.'),
    }),
    outputSchema: PlayerRankingsOutput,
    execute: ({ player_ids, as_of, system }): Promise<z.infer<typeof PlayerRankingsOutput>> =>
      ctx.guard(PlayerRankingsOutput, async () => {
        const res = await ctx.client.listRankings({ player: player_ids, as_of, system });
        const rows = res.data ?? [];
        const coverage = res.meta?.coverage ?? null;
        if (!rows.length) {
          return {
            ok: true as const,
            message:
              'No ranking records in force for those players at that date. ITF and UTR history begins ' +
              '2026-07-29 and cannot be reconstructed earlier. Check the coverage field.',
            rankings: [],
            coverage,
          };
        }
        return {
          ok: true as const,
          message:
            `Ranking records${as_of ? ` in force on ${as_of}` : ' (latest known)'}:\n` +
            rows
              .map(
                (r) =>
                  `  [${r.player_id ?? '?'}] ${r.system ?? '?'}: ${rankingLine(r)}${r.effective_date ? ` · eff. ${r.effective_date}` : ''}`,
              )
              .join('\n'),
          rankings: rows.map(rankingRowOut),
          coverage,
        };
      }),
  });

export const defineGetMatchStatistics = (ctx: Context) =>
  tool({
    description:
      'In-play (or final) statistics for one match, in TWO families kept separate on purpose. ' +
      'DERIVED is rebuilt from the point-by-point record (holds/breaks, break points, ' +
      'service/return points). MEASURED is counted upstream. It includes what no point record can ' +
      'yield: aces, double faults, the serve split, winners/unforced errors. Measured coverage ' +
      'varies by tour. Absent fields are omitted, never zero-filled. Requires the ULTRA plan.',
    inputSchema: z.object({ match_id: matchIdField }),
    outputSchema: MatchStatisticsOutput,
    execute: ({ match_id }): Promise<z.infer<typeof MatchStatisticsOutput>> =>
      ctx.guard(MatchStatisticsOutput, async () => {
        const res = await ctx.client.getMatchStatistics(match_id);
        const shape = (side: MatchStatisticsSide | null | undefined): z.infer<typeof StatsSideOut> | null => {
          if (!side) return null;
          const { measured, ...derived } = side;
          return {
            derived: numRecord(derived) ?? {},
            measured: numRecord(measured),
          };
        };
        const players = res.players;
        const p1 = shape(players?.p1);
        const p2 = shape(players?.p2);
        const coverage = n(res.coverage);
        const freshness = n(res.freshness as Record<string, unknown> | undefined);
        if (!players || (!p1 && !p2)) {
          return {
            ok: true as const,
            message:
              `No statistics held for match ${match_id} (coverage: ${coverage ?? 'none'}). ` +
              'The match exists. Holding nothing for it is the honest answer, not an error.',
            statistics: { coverage, as_of: n(res.as_of), games_counted: null, players: null, freshness },
          };
        }
        const line = (label: string, s: z.infer<typeof StatsSideOut> | null): string => {
          if (!s) return `  ${label}: no data`;
          const d = s.derived;
          const parts: string[] = [];
          if (d.service_games_played != null) {
            parts.push(`holds ${d.service_games_won}/${d.service_games_played}${d.hold_pct != null ? ` (${d.hold_pct}%)` : ''}`);
          }
          if (d.return_games_played != null) {
            parts.push(`breaks ${d.return_games_won}/${d.return_games_played}${d.break_pct != null ? ` (${d.break_pct}%)` : ''}`);
          }
          if (d.break_points_faced != null) parts.push(`BP saved ${d.break_points_saved}/${d.break_points_faced}`);
          if (d.service_points_played != null) {
            parts.push(`svc pts ${d.service_points_won}/${d.service_points_played}${d.service_points_won_pct != null ? ` (${d.service_points_won_pct}%)` : ''}`);
          }
          if (s.measured) {
            const m = s.measured;
            const mm: string[] = [];
            if (m.aces != null) mm.push(`aces ${m.aces}`);
            if (m.double_faults != null) mm.push(`DFs ${m.double_faults}`);
            if (m.winners != null) mm.push(`winners ${m.winners}`);
            if (m.unforced_errors != null) mm.push(`UEs ${m.unforced_errors}`);
            if (mm.length) parts.push(`measured: ${mm.join(' · ')}`);
          }
          return `  ${label}: ${parts.join(' · ') || 'no data'}`;
        };
        const bits = [
          `Match ${match_id} statistics, coverage ${coverage ?? '?'}` +
            `${res.games_counted != null ? `, ${res.games_counted} games counted (tiebreaks excluded)` : ''}`,
          line('Player 1', p1),
          line('Player 2', p2),
        ];
        if (coverage === 'diverged') {
          bits.push(
            '  Measured values are withheld: the two families disagree about this match. See freshness.measured_divergence.',
          );
        }
        return {
          ok: true as const,
          message: bits.join('\n'),
          statistics: {
            coverage,
            as_of: n(res.as_of as string | undefined),
            games_counted: n(res.games_counted as number | undefined),
            players: { p1, p2 },
            freshness: n(res.freshness as Record<string, unknown> | undefined),
          },
        };
      }),
  });

export const defineGetChartingPlayer = (ctx: Context) =>
  tool({
    description:
      'Career shot-level profile from the Match Charting Project, summed over the player\'s charted ' +
      'matches. Serve placement (deuce/ad x wide/body/T), return depth and outcomes, net play, and ' +
      'clutch break/game/set-point serving. Also winners and errors by wing, and rally-length ' +
      'tendencies. COVERAGE IS CURATED, not full-slate: 11,646 charted matches back to the 1960s, ' +
      'concentrated on the majors. An ambiguous name returns the candidates to choose from. ' +
      'Requires the ULTRA plan.',
    inputSchema: z.object({
      name: z.string().min(3).describe('Player name fragment, min 3 chars. Must resolve to one charted person.'),
      gender: z.enum(['men', 'women']).optional().describe('Disambiguates a name charted on both tours.'),
    }),
    outputSchema: ChartingPlayerOutput,
    execute: ({ name, gender }): Promise<z.infer<typeof ChartingPlayerOutput>> =>
      ctx.guard(ChartingPlayerOutput, async () => {
        const res = await ctx.client.getChartingPlayer(name, { gender });
        const player = (res.player as Record<string, unknown> | undefined) ?? null;
        const families = res.families ?? {};
        const who = (player?.name as string | undefined) ?? name;
        return {
          ok: true as const,
          message:
            `${who}: ${res.matches_charted ?? '?'} charted match(es), summed from the Match Charting Project ` +
            `(curated coverage, not full-slate).\nStat families: ${Object.keys(families).join(', ') || 'none'}. ` +
            'The full sums are in the structured output.',
          player,
          matches_charted: n(res.matches_charted),
          coverage: n(res.coverage),
          families,
        };
      }),
  });

export const defineGetChartingMatch = (ctx: Context) =>
  tool({
    description:
      'Every Match Charting Project stat family for ONE charted match, both players, with the ' +
      'per-set split (set 1, set 2, ..., Total) exactly as charted. Charting ids are their own id ' +
      'space (1960 to 2026). Most of these matches have no counterpart in the live tables. Requires ' +
      'the ULTRA plan.',
    inputSchema: z.object({
      charting_match_id: z.number().int().describe('Charting match id, in its own id space. Not a match_id.'),
    }),
    outputSchema: ChartingMatchOutput,
    execute: ({ charting_match_id }): Promise<z.infer<typeof ChartingMatchOutput>> =>
      ctx.guard(ChartingMatchOutput, async () => {
        const res = await ctx.client.getChartingMatch(charting_match_id);
        const players = (res.players as Record<string, unknown> | undefined) ?? null;
        const families = (res.families as Record<string, unknown> | undefined) ?? {};
        const names = players
          ? Object.values(players)
              .map((v) => (typeof v === 'string' ? v : ((v as { name?: string })?.name ?? '?')))
              .join(' vs ')
          : '?';
        return {
          ok: true as const,
          message:
            `Charted match ${res.charting_match_id ?? charting_match_id}${res.mcp_id ? ` (${res.mcp_id})` : ''}: ${names}.\n` +
            `Stat families: ${Object.keys(families).join(', ') || 'none'}. Full per-set numbers are in the structured output.`,
          charting_match_id: n(res.charting_match_id),
          mcp_id: n(res.mcp_id),
          gender: n(res.gender),
          players,
          families,
        };
      }),
  });

// -- meta --

type Usage = { tier: string; base: string | null; expires: string | null };

/**
 * GET /usage for the configured key: the plan, read rather than inferred.
 * 'rejected' on a 401. A RateLimited error on a 429, so the caller reports it
 * and stops: probing on through a rate limit or an abuse block is the one thing
 * that must not happen. null for anything else (an older server without the
 * endpoint, a 5xx, a network error, an unexpected body), so the caller falls
 * back to probing. Never throws.
 */
async function readUsage(ctx: Context): Promise<Usage | 'rejected' | RateLimited | null> {
  const plan = (v: unknown) => {
    const t = typeof v === 'string' ? v.toUpperCase() : '';
    return ['FREE', 'BASIC', 'PRO', 'ULTRA'].includes(t) ? t : null;
  };
  try {
    const res = await fetch(`${ctx.client.baseUrl}/usage`, {
      headers: { Authorization: `Bearer ${ctx.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(ctx.client.timeout),
    });
    if (res.status === 401) return 'rejected';
    if (res.status === 429) {
      const body: unknown = await res.json().catch(() => undefined);
      const after = Number(res.headers.get('retry-after'));
      return new RateLimited('rate_limited', {
        status: 429,
        body,
        retryAfter: Number.isFinite(after) && after >= 0 ? after : undefined,
      });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const body: unknown = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return null;
    const b = body as { tier?: unknown; base_tier?: unknown; tier_expires_at?: unknown };
    const tier = plan(b.tier);
    return tier ? { tier, base: plan(b.base_tier), expires: scalar(b.tier_expires_at) } : null;
  } catch {
    return null;
  }
}

export const defineCheckApiStatus = (ctx: Context) =>
  tool({
    description:
      'Check whether the Live Tennis API is reachable and which plan the configured key is on. Use ' +
      'it to find out why other tools are refusing data. Works with no key.',
    inputSchema: z.object({}),
    outputSchema: ApiStatusOutput,
    // Deliberately NOT wrapped in `guard`: diagnosing "why is everything else
    // refusing data" is precisely this tool's job, so it must still answer when
    // no key is configured. `guard` would short-circuit it into the very
    // message the user is trying to debug.
    execute: async (): Promise<z.infer<typeof ApiStatusOutput>> => {
      try {
        return ctx.scrub(await checkStatus(ctx));
      } catch (err) {
        // checkStatus handles every failure it knows of. This is the backstop
        // that keeps the "execute never throws" promise if it ever misses one.
        return ctx.scrub({ ok: false, message: ctx.describeFailure(err), has_key: Boolean(ctx.apiKey) });
      }
    },
  });

/** check_api_status itself. Its result passes through ctx.scrub on the way out. */
async function checkStatus(ctx: Context): Promise<z.infer<typeof ApiStatusOutput>> {
  const scrub = (text: string) => redact(text, ctx.apiKey);
  let health: { status?: unknown; version?: unknown } | null = null;
  try {
    const raw: unknown = await ctx.client.health();
    if (raw && typeof raw === 'object') health = raw as { status?: unknown; version?: unknown };
  } catch (err) {
    // A 429 on the health check means the API is up and refusing this client.
    // It gets the same message every tool gives, with its do-not-retry advice.
    if (err instanceof RateLimited) {
      return {
        ok: false,
        message: `The API answered the health check with a rate limit. ${ctx.describeFailure(err)}`,
        reachable: true,
        has_key: Boolean(ctx.apiKey),
      };
    }
    // The MCP server returns `isError: true` here. This package has no such
    // channel, and an unreachable API is exactly the finding this tool
    // exists to report. So it is reported as data, not as a throw.
    return {
      ok: false,
      message: `Could not reach the API: ${scrub(err instanceof Error ? err.message : String(err))}`,
      reachable: false,
      has_key: Boolean(ctx.apiKey),
    };
  }
  if (!health) {
    // A 200 that is not JSON: a proxy page, or a baseUrl pointing somewhere else.
    return {
      ok: false,
      message:
        `Could not reach the API: the health check at ${scrub(ctx.client.baseUrl)}/health did not answer ` +
        'with JSON. Check the baseUrl option or LIVETENNISAPI_BASE_URL.',
      reachable: false,
      has_key: Boolean(ctx.apiKey),
    };
  }
  const version = scalar(health.version);
  const up = `API is reachable (status: ${scalar(health.status) ?? '?'}, version: ${version ?? '?'}).`;
  const base = { reachable: true, api_version: version, has_key: Boolean(ctx.apiKey) };
  if (ctx.keyProblem) return { ok: true, message: `${up}\n${ctx.keyProblem}`, ...base, tier: null };
  if (!ctx.apiKey) {
    return {
      ok: true,
      message:
        `${up}\nNo API key is configured, so only this check will work. Pass { apiKey } to the tool ` +
        'factory or set LIVETENNISAPI_KEY. Get a free key at https://livetennisapi.com/subscribe/free',
      ...base,
      tier: null,
    };
  }
  const rejected = {
    ok: true,
    message: `${up}\nThe configured API key was rejected (unauthorized). Keys are at https://livetennisapi.com`,
    ...base,
    tier: null,
  };
  const plans =
    '\n\nFREE  = live & upcoming matches, scores, players, fixtures, tournaments\n' +
    'BASIC = + historical results, the results archive (1968 to 2022), head-to-head\n' +
    'PRO   = + match events, market prices, rankings listing, player records\n' +
    'ULTRA = + model analysis, win probability, as-of rankings, match statistics, charting, live feed';

  // GET /usage names the plan outright and does not count against the quota.
  // The livetennisapi client has no method for it, so it is one plain fetch
  // with the same Bearer header the client sends.
  const usage = await readUsage(ctx);
  if (usage === 'rejected') return rejected;
  if (usage instanceof RateLimited) {
    return ctx.scrub({ ok: false, message: `${up} The plan check failed. ${ctx.describeFailure(usage)}`, ...base, tier: null });
  }
  if (usage) {
    const grant =
      usage.base && usage.base !== usage.tier
        ? ` That is a temporary grant over the ${usage.base} subscription${usage.expires ? `, until ${usage.expires}` : ''}.`
        : '';
    return {
      ok: true,
      message: `${up}\nThe configured API key is on the ${usage.tier} plan.${grant}${plans}`,
      ...base,
      tier: usage.tier,
    };
  }

  // No /usage answer (an older or self-hosted server, or a rate limit), so
  // probe upward. Only UpgradeRequired proves a plan is NOT held.
  try {
    let tier = 'BASIC';
    let historyPage: Awaited<ReturnType<typeof ctx.client.listCompletedMatches>> | null = null;
    try {
      historyPage = await ctx.client.listCompletedMatches({ limit: 1 });
    } catch (err) {
      if (err instanceof Unauthorized) return rejected;
      // FREE stops short of history, so a plan gate HERE identifies it. Any
      // other 403 (a firewall page) is a failure to report, not a plan.
      if (isPlanGate(err)) tier = 'FREE';
      else throw err;
    }
    const id = historyPage?.data?.[0]?.id;
    // A FREE key cannot hold PRO/ULTRA, so skip the climb entirely.
    if (tier !== 'FREE' && id != null) {
      // NotFound means the call was allowed but that match has no data, so
      // it is evidence of entitlement, not of a missing plan.
      try {
        await ctx.client.listMatchEvents(id, { limit: 1 });
        tier = 'PRO';
      } catch (err) {
        if (err instanceof NotFound) tier = 'PRO';
        else if (!isPlanGate(err)) throw err;
      }
      if (tier === 'PRO') {
        try {
          await ctx.client.getMatchAnalysis(id);
          tier = 'ULTRA';
        } catch (err) {
          if (err instanceof NotFound) tier = 'ULTRA';
          else if (!isPlanGate(err)) throw err;
        }
      }
    }
    // A FREE key may spend 20 history calls a month, served exactly like an
    // entitled call, so a history answer alone cannot tell BASIC from FREE.
    const caveat =
      tier === 'BASIC'
        ? ' A FREE API key that still has free history calls this month looks the same to this check.'
        : '';
    return {
      ok: true,
      message: `${up}\nThe configured API key appears to be on the ${tier} plan.${caveat}${plans}`,
      ...base,
      tier,
    };
  } catch (err) {
    // The health check answered, so the API is up: whatever failed was one
    // of the plan probes (a rate limit, an abuse block, a 5xx). Say which,
    // in the same words every other tool uses, rather than "unreachable".
    return {
      ok: false,
      message: `${up} The plan check failed. ${ctx.describeFailure(err)}`,
      ...base,
      tier: null,
    };
  }
}
