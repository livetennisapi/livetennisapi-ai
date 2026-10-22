/**
 * The failure paths, one upstream response at a time.
 *
 * tools-output.mjs proves every tool returns its schema on the happy path and
 * with no key. This file covers what the upstream can send back instead of
 * data: 429s in their three shapes (including malformed bodies), 404s, empty
 * lists, an ambiguous name, a key that cannot be sent in a header, and a tier
 * probe that hits a rate limit. The rule under test is the same everywhere: a
 * tool returns a value, it never throws, and it never echoes the API key.
 *
 * Run: node test/errors.mjs        (no credentials, no network)
 */

import { createServer } from 'node:http';

const PORT = 8130;
const BASE_URL = `http://127.0.0.1:${PORT}`;

delete process.env.LIVETENNISAPI_KEY;
delete process.env.LIVETENNISAPI_BASE_URL;

const { livetennisTools } = await import('../dist/index.js');

/** What the stub answers next: { status, body, headers? }, or a function of the path. */
let reply = () => ({ status: 200, body: { data: [], meta: { limit: 1, offset: 0, count: 0 } } });

/** Every path the stub was asked for, in order. */
let asked = [];

const upstream = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  asked.push(path);
  const { status, body, raw, json, headers = {} } = reply(path);
  // Retry-After: 0 keeps the client's own per-minute retry loop instant.
  const type = raw === undefined || json ? 'application/json' : 'text/html';
  res.writeHead(status, { 'content-type': type, 'retry-after': '0', ...headers });
  res.end(raw ?? JSON.stringify(body));
});
await new Promise((r) => upstream.listen(PORT, '127.0.0.1', r));

const EXEC = { toolCallId: 'test-call', messages: [] };
// Every key in this file contains SECRET, and no result may.
const KEY = 'twjp_SECRET_test_key';
const tools = livetennisTools({ apiKey: KEY, baseUrl: BASE_URL });

let failures = 0;

/** Whether any string or property name in a value contains SECRET. Iterative: results can nest deeply. */
function mentionsSecret(value) {
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') { if (v.includes('SECRET')) return true; }
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) { if (k.includes('SECRET')) return true; stack.push(x); }
    }
  }
  return false;
}
async function check(label, tool, args, expect) {
  let result;
  try {
    result = await tool.execute(tool.inputSchema.parse(args), EXEC);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${label}: THREW ${err?.name}: ${err?.message}`);
    return;
  }
  const problems = [];
  const parsed = tool.outputSchema.safeParse(result);
  if (!parsed.success) problems.push(`output violates its schema: ${parsed.error.message}`);
  if (typeof result?.message !== 'string' || !result.message) problems.push('no message');
  if (mentionsSecret(result)) problems.push('result contains the API key');
  for (const problem of expect(result) ?? []) problems.push(problem);
  if (problems.length) {
    failures += 1;
    console.error(`FAIL ${label}:\n    ${problems.join('\n    ')}\n    got: ${String(result?.message).slice(0, 400)}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

const has = (r, re, what) => (re.test(r.message) ? [] : [`message should mention ${what}: ${r.message}`]);
const lacks = (r, re, what) => (re.test(r.message) ? [`message should not contain ${what}: ${r.message}`] : []);
const isOk = (r, want) => (r.ok === want ? [] : [`expected ok:${want}, got ok:${r.ok}`]);
const live = tools.get_live_matches;

// -- 429 abuse_throttled ------------------------------------------------------

reply = () => ({ status: 429, body: { error: 'abuse_throttled', retry_at_epoch: 1767225600 } });
await check('abuse_throttled with a valid retry_at_epoch', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /abuse_throttled/, 'abuse_throttled'),
  ...has(r, /2026-01-01T00:00:00\.000Z/, 'the resume instant'),
]);

reply = () => ({ status: 429, body: { error: 'abuse_throttled', retry_at_epoch: 'soon' } });
await check('abuse_throttled with a non-numeric retry_at_epoch', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /abuse_throttled/, 'abuse_throttled'),
  ...has(r, /Do NOT retry/, 'the do-not-retry instruction'),
  ...lacks(r, /resume at|Invalid/i, 'an invented resume time'),
]);

reply = () => ({ status: 429, body: { error: 'abuse_throttled', retry_at_epoch: '1767225600' } });
await check('abuse_throttled with retry_at_epoch as a numeric string', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /2026-01-01T00:00:00\.000Z/, 'the resume instant'),
]);

reply = () => ({ status: 429, body: { error: 'abuse_throttled', retry_at_epoch: { at: 1 } } });
await check('abuse_throttled with an object retry_at_epoch', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /abuse_throttled/, 'abuse_throttled'),
  ...lacks(r, /object Object/, '[object Object]'),
]);

// A finite number too large for a Date. The livetennisapi client itself fails
// to build its error for this one (it formats the date in the constructor), so
// what reaches the tool is a RangeError. It must still be a value.
reply = () => ({ status: 429, body: { error: 'abuse_throttled', retry_at_epoch: 1e20 } });
await check('abuse_throttled with an out-of-range retry_at_epoch', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /abuse_throttled/, 'abuse_throttled'),
  ...has(r, /Do NOT retry/, 'the do-not-retry instruction'),
  ...lacks(r, /Invalid time value|resume at/, 'a RangeError or a resume time'),
]);

reply = () => ({ status: 429, body: { error: 'abuse_throttled' } });
await check('abuse_throttled with no retry_at_epoch', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /abuse_throttled/, 'abuse_throttled'),
]);

// A 429 that is not labelled abuse_throttled but carries a broken
// retry_at_epoch: the client retries it as per-minute, then gives up.
reply = () => ({ status: 429, body: { error: 'rate_limited', retry_at_epoch: 'NaN' } });
await check('rate_limited carrying a malformed retry_at_epoch', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /Per-minute/, 'the per-minute limit (rate_limited wins over the stray field)'),
  ...lacks(r, /Invalid|NaN|abuse/, 'Invalid/NaN/abuse'),
]);

reply = () => ({
  status: 429,
  body: { error: 'rate_limited', scope: 'day', resets_at: '2026-10-23T21:00:00Z', retry_at_epoch: 'NaN' },
});
await check('daily quota carrying a malformed retry_at_epoch', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /Daily request quota/, 'the daily quota'),
  ...has(r, /2026-10-23T21:00:00Z/, 'resets_at'),
  ...lacks(r, /abuse/, 'an abuse block'),
]);

// -- 429 daily and per-minute -----------------------------------------------------

reply = () => ({
  status: 429,
  body: { error: 'rate_limited', scope: 'day', limit_per_day: 100, resets_at: '2026-10-23T21:00:00Z' },
});
await check('daily quota', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /100 requests\/day/, 'the daily limit'),
  ...has(r, /2026-10-23T21:00:00Z/, 'resets_at'),
]);

reply = () => ({ status: 429, body: { error: 'rate_limited', scope: 'day', limit_per_day: 'lots', resets_at: { t: 1 } } });
await check('daily quota with malformed fields', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /Daily request quota/, 'the daily quota'),
  ...lacks(r, /object Object|lots/, 'the malformed values'),
]);

reply = () => ({ status: 429, body: { error: 'rate_limited' } });
await check('per-minute limit', live, {}, (r) => [...isOk(r, false), ...has(r, /Per-minute/, 'the per-minute limit')]);

reply = () => ({ status: 429, body: 'not json at all' });
await check('429 with a string body', live, {}, (r) => isOk(r, false));

// -- other statuses -------------------------------------------------------------

reply = () => ({ status: 404, body: { error: 'not_found' } });
await check('unknown match id (404)', tools.get_match, { match_id: 999999 }, (r) => [
  ...isOk(r, false),
  ...has(r, /No data found/, 'not found'),
]);

reply = () => ({ status: 403, body: { error: 'upgrade_required' } });
await check('plan gate (403)', tools.get_match_analysis, { match_id: 1 }, (r) => [
  ...isOk(r, false),
  ...has(r, /ULTRA plan/, 'the required plan'),
]);

reply = () => ({ status: 401, body: { error: 'unauthorized' } });
await check('rejected key (401)', live, {}, (r) => [...isOk(r, false), ...has(r, /rejected/, 'the rejection')]);

reply = () => ({ status: 400, body: { error: 'ambiguous_name', candidates: ['Andy Murray', 'Jamie Murray'] } });
await check('ambiguous name, string candidates', tools.get_h2h, { player1: 'murray', player2: 'federer' }, (r) => [
  ...isOk(r, false),
  ...has(r, /Andy Murray, Jamie Murray/, 'the candidates'),
]);

reply = () => ({ status: 400, body: { error: 'ambiguous_name', candidates: [{ name: 'Andy Murray', id: 1 }, { name: 'Jamie Murray', id: 2 }] } });
await check('ambiguous name, object candidates', tools.get_archive_career, { name: 'murray' }, (r) => [
  ...isOk(r, false),
  ...has(r, /Andy Murray, Jamie Murray/, 'the candidate names'),
  ...lacks(r, /object Object/, '[object Object]'),
]);

// -- empty results are ok:true ---------------------------------------------------

reply = () => ({ status: 200, body: { data: [], meta: { limit: 20, offset: 0, count: 0 } } });
await check('empty live list', live, {}, (r) => [
  ...isOk(r, true),
  ...(Array.isArray(r.matches) && r.matches.length === 0 ? [] : ['matches should be an empty array']),
]);
await check('empty player search', tools.search_players, { query: 'zzzz' }, (r) => [
  ...isOk(r, true),
  ...(Array.isArray(r.players) && r.players.length === 0 ? [] : ['players should be an empty array']),
]);

// -- network failure --------------------------------------------------------------

const offline = livetennisTools({ apiKey: KEY, baseUrl: 'http://127.0.0.1:9' });
await check('network error', offline.get_live_matches, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /^Request failed/, 'a request failure'),
]);

// -- a key that cannot be sent in a header ---------------------------------------
// fetch rejects it with an error that quotes the header value, key included.

for (const bad of ['twjp_SECRET\nkey', 'twjp_SECRET\u0000key', 'twjp_SECRET key']) {
  const broken = livetennisTools({ apiKey: bad, baseUrl: BASE_URL });
  await check(`malformed key ${JSON.stringify(bad)}`, broken.get_live_matches, {}, (r) => [
    ...isOk(r, false),
    ...has(r, /API key/, 'the API key'),
  ]);
  reply = () => ({ status: 200, body: { status: 'ok', version: 'v1' } });
  await check(`check_api_status, malformed key ${JSON.stringify(bad)}`, broken.check_api_status, {}, (r) => [
    ...has(r, /API key/, 'the API key'),
    ...(r.has_key === true ? [] : ['has_key should be true']),
  ]);
}

// -- check_api_status when the tier probe is rate limited -------------------------

reply = (path) =>
  path.includes('/health')
    ? { status: 200, body: { status: 'ok', version: 'v1' } }
    : { status: 429, body: { error: 'rate_limited', scope: 'day', limit_per_day: 100, resets_at: '2026-10-23T21:00:00Z' } };
await check('check_api_status, probe hits the daily quota', tools.check_api_status, {}, (r) => [
  ...isOk(r, false),
  ...(r.reachable === true ? [] : [`reachable should be true, got ${r.reachable}`]),
  ...has(r, /Daily request quota/, 'the daily quota'),
]);

reply = (path) =>
  path.includes('/health')
    ? { status: 200, body: { status: 'ok', version: 'v1' } }
    : { status: 429, body: { error: 'abuse_throttled', retry_at_epoch: 'soon' } };
await check('check_api_status, probe hits abuse_throttled with a malformed epoch', tools.check_api_status, {}, (r) => [
  ...isOk(r, false),
  ...(r.reachable === true ? [] : [`reachable should be true, got ${r.reachable}`]),
  ...has(r, /abuse_throttled/, 'abuse_throttled'),
]);

await check('check_api_status, API unreachable', offline.check_api_status, {}, (r) => [
  ...isOk(r, false),
  ...(r.reachable === false ? [] : [`reachable should be false, got ${r.reachable}`]),
]);

// -- check_api_status reads the plan --------------------------------------------

const HEALTH = { status: 200, body: { status: 'ok', version: 'v1' } };

reply = (path) => (path.includes('/health') ? HEALTH : path.endsWith('/usage') ? { status: 200, body: { tier: 'pro', base_tier: 'pro' } } : { status: 500, body: {} });
await check('check_api_status, plan from /usage', tools.check_api_status, {}, (r) => [
  ...isOk(r, true),
  ...(r.tier === 'PRO' ? [] : [`tier should be PRO, got ${r.tier}`]),
]);

reply = (path) => (path.includes('/health') ? HEALTH : path.endsWith('/usage') ? { status: 200, body: { tier: 'ultra', base_tier: 'free', tier_expires_at: '2026-11-01T00:00:00Z' } } : { status: 500, body: {} });
await check('check_api_status, temporary grant', tools.check_api_status, {}, (r) => [
  ...isOk(r, true),
  ...(r.tier === 'ULTRA' ? [] : [`tier should be ULTRA, got ${r.tier}`]),
  ...has(r, /temporary grant over the FREE subscription, until 2026-11-01/, 'the grant'),
]);

reply = (path) => (path.includes('/health') ? HEALTH : { status: 401, body: { error: 'unauthorized' } });
await check('check_api_status, rejected key', tools.check_api_status, {}, (r) => [
  ...has(r, /rejected/, 'the rejection'),
  ...(r.tier === null ? [] : [`tier should be null, got ${r.tier}`]),
]);

// A server without /usage: a FREE key answers 403 on history and must read as FREE.
reply = (path) =>
  path.includes('/health')
    ? HEALTH
    : path.endsWith('/usage')
      ? { status: 404, body: { error: 'not_found' } }
      : path.includes('/history') || path.includes('/matches')
        ? { status: 403, body: { error: 'upgrade_required', free_history_taste: 'used' } }
        : { status: 500, body: {} };
await check('check_api_status, FREE key without /usage', tools.check_api_status, {}, (r) => [
  ...isOk(r, true),
  ...(r.tier === 'FREE' ? [] : [`tier should be FREE, got ${r.tier}`]),
]);

for (const answer of [{ raw: '<html>proxy</html>' }, { body: null }, { body: '<html>as a JSON string</html>' }]) {
  reply = (path) => (path.includes('/health') ? { status: 200, ...answer } : { status: 500, body: {} });
  await check(`check_api_status, health answers ${JSON.stringify(answer)}`, tools.check_api_status, {}, (r) => [
    ...isOk(r, false),
    ...(r.reachable === false ? [] : [`reachable should be false, got ${r.reachable}`]),
  ]);
}

// -- 403 that is not a plan gate, and the free history allowance ------------------

reply = () => ({ status: 403, body: { error: 'forbidden' } });
await check('403 that is not upgrade_required', live, {}, (r) => [
  ...isOk(r, false),
  ...lacks(r, /Upgrade|requires/, 'an upgrade pitch'),
  ...has(r, /not a plan limit/, 'that it is not a plan limit'),
]);

reply = () => ({ status: 403, body: { error: 'upgrade_required', free_history_taste: 'used' } });
await check('403 after the free history calls are spent', tools.get_recent_results, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /BASIC plan/, 'BASIC'),
  ...has(r, /20 free history calls/, 'the free allowance'),
]);

// -- server objects with extra or missing fields still match the schema -----------

reply = () => ({
  status: 200,
  body: {
    player: { name: 'Bjorn Borg' },
    record: { wins: 1, losses: 0, titles: 0, by_surface: { clay: { wins: 3 } }, by_level: { G: { wins: 1, losses: 'x' } } },
    by_year: [{ year: 1980, wins: '70', losses: 6 }],
    serve: { matches_with_stats: 2, aces: 5, note: 'text' },
  },
});
await check('get_archive_career with ragged server objects', tools.get_archive_career, { name: 'borg' }, (r) => [
  ...isOk(r, true),
  ...(r.record?.by_surface?.clay?.losses === null ? [] : ['missing losses should map to null']),
  ...(r.serve && !('note' in r.serve) ? [] : ['non-numeric serve field should be dropped']),
]);

reply = () => ({
  status: 200,
  body: {
    match_id: 1, coverage: 'live', as_of: '2026-10-22T00:00:00Z', games_counted: 2,
    players: { p1: { hold_pct: 50, label: 'p1', measured: { aces: 1, source: 'x' } }, p2: null },
  },
});
await check('get_match_statistics with non-numeric fields', tools.get_match_statistics, { match_id: 1 }, (r) => isOk(r, true));

// -- Codex review regressions ---------------------------------------------------------

// The server echoing the key back must not put it in a result.
reply = () => ({ status: 429, body: { error: 'rate_limited', scope: 'day', resets_at: KEY } });
await check('daily quota echoing the key in resets_at', live, {}, (r) => isOk(r, false));
reply = () => ({ status: 400, body: { error: 'ambiguous_name', candidates: [KEY, 'B Name'] } });
await check('ambiguous name echoing the key', tools.get_h2h, { player1: 'abc', player2: 'def' }, (r) => isOk(r, false));
reply = (path) => (path.includes('/health') ? { status: 200, body: { status: KEY, version: KEY } } : { status: 200, body: { tier: 'pro', tier_expires_at: KEY } });
await check('check_api_status echoing the key', tools.check_api_status, {}, (r) => isOk(r, true));
reply = () => ({ status: 200, body: { data: [{ id: 1, tournament: KEY, players: {} }], meta: {} } });
await check('a data field echoing the key', live, {}, (r) => isOk(r, true));

// Wrongly typed fields: a string "false" is not a boolean and must not read as true.
reply = () => ({ status: 200, body: { data: [{ id: 1, has_analysis: 'false', has_market: 1, indoor: 'no', players: {} }], meta: {} } });
await check('match row with wrongly typed flags', live, {}, (r) => [
  ...isOk(r, true),
  ...(r.matches?.[0]?.has_analysis === null ? [] : ['has_analysis "false" should map to null']),
  ...lacks(r, /Analysis: available/, 'an invented analysis line'),
]);
reply = () => ({ status: 200, body: { player: { name: 'B' }, record: { wins: '654', losses: 1 } } });
await check('archive career with a string win count', tools.get_archive_career, { name: 'borg' }, (r) => [
  ...isOk(r, true),
  ...(r.record?.wins === null ? [] : ['string wins should map to null']),
]);
reply = () => ({ status: 200, body: { id: 5, name: 7, tour: 'atp' } });
await check('a result the schema cannot hold', tools.get_tournament, { tournament_id: 'x' }, (r) => [
  ...isOk(r, false),
  ...has(r, /^Request failed: the API answered, but tournament\.(id|name) was not/, 'the shape failure'),
]);

// A 429 on /usage is reported, and nothing else is requested after it.
asked = [];
reply = (path) =>
  path.includes('/health')
    ? { status: 200, body: { status: 'ok', version: 'v1' } }
    : path.endsWith('/usage')
      ? { status: 429, body: { error: 'abuse_throttled', retry_at_epoch: 1767225600 } }
      : { status: 200, body: { data: [{ id: 1 }], meta: {} } };
await check('check_api_status, /usage answers abuse_throttled', tools.check_api_status, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /abuse_throttled/, 'abuse_throttled'),
  ...(asked.some((p) => p.includes('/history') || p.includes('/matches')) ? [`probed on after the block: ${asked.join(' ')}`] : []),
]);

// A 403 that is not the API's plan gate.
reply = () => ({ status: 403, raw: '<html>Forbidden by the firewall</html>' });
await check('raw HTML 403', tools.get_match_analysis, { match_id: 1 }, (r) => [
  ...isOk(r, false),
  ...has(r, /not a plan limit/, 'that it is not a plan limit'),
  ...lacks(r, /Upgrade|ULTRA/, 'an upgrade pitch'),
]);
reply = (path) =>
  path.includes('/health')
    ? { status: 200, body: { status: 'ok', version: 'v1' } }
    : path.endsWith('/usage')
      ? { status: 404, body: { error: 'not_found' } }
      : { status: 403, body: { error: 'forbidden' } };
await check('check_api_status, history 403 that is not a plan gate', tools.check_api_status, {}, (r) => [
  ...isOk(r, false),
  ...(r.tier === null ? [] : [`tier should be null, got ${r.tier}`]),
]);

// -- second Codex review regressions -----------------------------------------------

// Deep nesting as JSON text: JSON.stringify itself would overflow building it.
const deep = (n) => '['.repeat(n) + '0' + ']'.repeat(n);

reply = () => ({ status: 200, body: { players: { p1: { name: 'A' }, p2: { name: 'B' } }, by_surface: { [KEY]: { p1: 'bad', p2: 2 } } } });
await check('schema failure naming a record key that is the API key', tools.get_h2h, { player1: 'abc', player2: 'def' }, (r) => isOk(r, false));

asked = [];
reply = () => ({ status: 429, json: true, raw: `{"error":"abuse_throttled","retry_at_epoch":1767225600,"extra":${deep(10000)}}` });
await check('abuse_throttled with a deeply nested extra field', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /abuse_throttled/, 'abuse_throttled'),
  ...(asked.length === 1 ? [] : [`expected one request, got ${asked.length}`]),
]);

asked = [];
reply = () => ({ status: 429, json: true, raw: `{"error":"abuse_throttled","retry_at_epoch":1e20,"extra":${deep(10000)}}` });
await check('out-of-range epoch with a deeply nested extra field', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /abuse_throttled/, 'abuse_throttled'),
  ...(asked.length === 1 ? [] : [`expected one request, got ${asked.length}`]),
]);

reply = () => ({ status: 200, json: true, raw: `{"player":{"name":"A"},"matches_charted":1,"coverage":"curated","families":{"overview":${deep(5000)}}}` });
await check('deeply nested charting families', tools.get_charting_player, { name: 'abcd' }, (r) => isOk(r, true));

for (const shortKey of ['ok', 'message']) {
  const t = livetennisTools({ apiKey: shortKey, baseUrl: BASE_URL });
  reply = () => ({ status: 401, body: { error: 'unauthorized' } });
  await check(`a short key (${shortKey}) leaves the result intact`, t.get_live_matches, {}, (r) => [
    ...isOk(r, false),
    ...has(r, /rejected/, 'the rejection'),
  ]);
}

// -- third Codex review regressions -------------------------------------------------

asked = [];
reply = () => ({ status: 429, body: { retry_at_epoch: 1767225600 } });
await check('unlabelled abuse 429 is not retried', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /Do NOT retry/, 'the do-not-retry instruction'),
  ...(asked.length === 1 ? [] : [`expected one request, got ${asked.length}`]),
]);

asked = [];
reply = () => ({ status: 429, body: { error: 'rate_limited', resets_at: '2026-10-23T00:00:00Z' } });
await check('daily 429 without scope is not retried', live, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /Daily request quota/, 'the daily quota'),
  ...(asked.length === 1 ? [] : [`expected one request, got ${asked.length}`]),
]);

reply = () => ({ status: 429, body: { error: 'abuse_throttled', retry_at_epoch: 1e20 } });
await check('check_api_status, health answers abuse_throttled', tools.check_api_status, {}, (r) => [
  ...isOk(r, false),
  ...has(r, /Do NOT retry/, 'the do-not-retry instruction'),
  ...(r.reachable === true ? [] : [`reachable should be true, got ${r.reachable}`]),
]);

asked = [];
reply = () => (asked.length === 1 ? { status: 429, body: { error: 'rate_limited', resets_at: '  ' } } : { status: 200, body: { data: [], meta: {} } });
await check('blank resets_at stays a per-minute 429 and is retried', live, {}, (r) => [
  ...isOk(r, true),
  ...(asked.length === 2 ? [] : [`expected a retry (2 requests), got ${asked.length}`]),
]);

upstream.closeAllConnections?.();
upstream.close();
if (failures) {
  console.error(`\n${failures} failure path check(s) failed`);
  process.exit(1);
}
console.log('OK - failure paths return values, never throw, never echo the key');
