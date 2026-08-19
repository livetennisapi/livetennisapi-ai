/**
 * Every tool must return data matching the schema it advertises — on BOTH the
 * success path and the no-key path.
 *
 * Why this test is not optional
 * -----------------------------
 * The AI SDK does NOT validate `outputSchema` when `execute` returns; a grep of
 * `ai@7`'s source shows it consulted only when replaying UI messages. So unlike
 * the MCP server — where the SDK itself throws on a schema violation and the
 * transport surfaces it — nothing at runtime here would ever notice a tool whose
 * declared schema and actual output had drifted apart. This test is that check:
 * it parses every result through the tool's own `outputSchema`.
 *
 * The second thing it exists to protect is the guard contract. A tier wall, a
 * rejected key and a MISSING key are deliberately not exceptions — they are
 * returned values carrying `ok: false` and an actionable message. If any of them
 * ever became a throw, a model mid-conversation would lose the upgrade path and
 * the user would see a crash instead of "you need the PRO plan". So every tool
 * is driven twice: once with no key at all, and once against a stub upstream.
 *
 * Run: node test/tools-output.mjs        (no credentials, no network)
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';

const UPSTREAM_PORT = 8129;
const BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
const fail = (m) => { throw new Error(m); };

// A key inherited from the developer's shell would silently turn the "no key"
// half of this test into a live, credentialed call. Remove it before importing.
delete process.env.LIVETENNISAPI_KEY;
delete process.env.LIVETENNISAPI_BASE_URL;

const { livetennisTools, getLiveMatches } = await import('../dist/index.js');

/** Paths the upstream was asked for — printed on failure so a 404 is obvious. */
const asked = [];

const MATCH = {
  id: 101,
  tournament: 'Test Open',
  round: 'QF',
  status: 'live',
  surface: 'hard',
  indoor: false,
  winner: null,
  event_status: 'Interrupted',
  event_status_updated_at: '2026-08-19T09:15:00Z',
  players: { p1: { id: 1, name: 'Player One' }, p2: { id: 2, name: 'Player Two' } },
  score: { sets: [1, 0], server: 1, is_tiebreak: false, win_probability_p1: 0.61, games: [[6, 4], [3, 2]] },
};
const PLAYER = {
  id: 1, name: 'Player One', country: 'ESP', ranking: 3, ranking_points: 7000,
  ranking_movement: 'up', hand: 'R', birthday: '2003-05-05', tour: 'ATP',
};
const FIXTURE = {
  event_date: '2026-07-23T12:00:00Z', tournament: 'Test Open', round: 'SF',
  player1_name: 'Player One', player2_name: 'Player Two',
};
const MARKET = {
  question: 'Who wins?', status: 'open', volume: 1000, liquidity: 500,
  prices: [{ side: 1, mid: 0.6, bid: 0.59, ask: 0.61, timestamp: '2026-07-22T00:00:00Z' }],
};
const ANALYSIS = {
  profile: { win_probability_p1: 0.61, expected_closeness: 0.4, volatility_rating: 'medium', key_factors: ['serve'] },
  thesis: { pick_side: 1, confidence: 0.7, state: 'active', reasoning: 'Better on hard courts.' },
};
const TOURNAMENT = {
  id: 'test-open', name: 'Test Open', tour: 'atp', surface: 'hard', indoor: false,
  city: 'Testville', country: 'NL', category: 'atp_250',
};
const ARCHIVE_MATCH = {
  id: 555, tour: 'atp', tournament: 'Wimbledon', event_date: '1980-06-23', round: 'F', level: 'G',
  surface: 'grass', score: '1-6 7-5 6-3 6-7(16) 8-6', outcome: 'completed',
  winner: { name: 'Bjorn Borg', country: 'SWE', rank: 1, seed: 1, player_id: 9001, hand: 'R', height_cm: 180, age: 24, entry: null },
  loser: { name: 'John McEnroe', country: 'USA', rank: 2, seed: 2, player_id: 9002, hand: 'L', height_cm: 180, age: 21, entry: null },
  stats: { winner: { aces: 10, double_faults: 2 }, loser: { aces: 12, double_faults: 4 } },
};
const ARCHIVE_BIO = {
  id: 9001, tour: 'atp', name: 'Bjorn Borg', hand: 'R', dob: '1956-06-06', country: 'SWE',
  height_cm: 180, career_high_rank: 1, career_high_date: '1977-08-23',
};
const ARCHIVE_CAREER = {
  player: { name: 'Bjorn Borg' },
  span: { first: '1971-05-03', last: '1993-07-05' },
  record: { wins: 654, losses: 140, titles: 66, by_surface: { clay: { wins: 251, losses: 41 } }, by_level: { G: { wins: 141, losses: 16 } } },
  by_year: [{ year: 1980, wins: 70, losses: 6 }],
  serve: { matches_with_stats: 12, aces: 60, aces_per_match: 5, first_in_pct: 0.68, first_won_pct: 0.75, bp_saved_pct: 0.66 },
};
const H2H = {
  players: { p1: { name: 'Roger Federer' }, p2: { name: 'Rafael Nadal' } },
  totals: { p1_wins: 16, p2_wins: 24, meetings: 40, undecided: 0 },
  by_surface: { clay: { p1: 2, p2: 14 }, hard: { p1: 11, p2: 9 } },
  meetings: [{ era: 'archive', date: '2019-06-07', tournament: 'Roland Garros', round: 'SF', surface: 'clay', score: '6-3 6-4 6-2', outcome: 'completed', winner: 2, match_id: null }],
};
const RANKING_ROW = {
  player_id: 1, player_name: 'Player One', system: 'atp', rank: 3, points: 7000,
  previous_rank: 4, rank_movement: null, rating: null, effective_date: '2026-08-03',
};
const RANKINGS_META = {
  limit: 1, offset: 0, count: 1,
  coverage: { as_of: null, players_requested: 1, players_resolved: 1, systems_requested: ['atp'], systems_resolved: ['atp'] },
};
const STATISTICS = {
  match_id: 101, coverage: 'live', as_of: '2026-08-07T10:00:00Z', games_counted: 14,
  freshness: { derived: { coverage: 'live' }, measured: { coverage: 'live' }, measured_divergence: null },
  players: {
    p1: { service_games_played: 7, service_games_won: 6, hold_pct: 85.7, measured: { aces: 5, double_faults: 1 } },
    p2: { service_games_played: 7, service_games_won: 5, hold_pct: 71.4, measured: { aces: 2, double_faults: 3 } },
  },
};
const CHARTING_PLAYER = {
  player: { name: 'Roger Federer' }, matches_charted: 500, coverage: 'curated',
  families: { serve_influence: { pts: 100 }, shot_direction: { fh: 50 } },
};
const CHARTING_MATCH = {
  charting_match_id: 77, mcp_id: '20080706-M-Wimbledon-F', gender: 'M',
  players: { p1: { name: 'Rafael Nadal' }, p2: { name: 'Roger Federer' } },
  families: { overview: { sets: 5 } },
};

const page = (row) => ({ data: [row], meta: { limit: 1, offset: 0, count: 1 } });

/** Answer whatever the client asks for, shaped by what the path looks like. */
const upstream = createServer((req, res) => {
  const url = req.url ?? '';
  asked.push(url);
  const send = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const path = url.split('?')[0];
  if (path.includes('/health')) return send({ status: 'ok', version: 'v1' });
  // Most-specific paths first: several of these contain '/matches' or
  // '/players' as a substring and would otherwise be shadowed.
  if (path.includes('/statistics')) return send(STATISTICS);
  if (path.includes('/charting/players')) return send(CHARTING_PLAYER);
  if (path.includes('/charting/matches')) return send(CHARTING_MATCH);
  if (path.includes('/history/archive/career')) return send(ARCHIVE_CAREER);
  if (path.includes('/history/archive/players')) return send(page(ARCHIVE_BIO));
  if (path.includes('/history/archive/matches')) return send(/\/\d+$/.test(path) ? ARCHIVE_MATCH : page(ARCHIVE_MATCH));
  if (path.includes('/h2h')) return send(H2H);
  if (path.includes('/rankings')) return send({ data: [RANKING_ROW], meta: RANKINGS_META });
  if (path.includes('/tournaments')) return send(/\/[^/]+$/.test(path) && !path.endsWith('/tournaments') ? TOURNAMENT : page(TOURNAMENT));
  if (path.includes('/events')) return send(page({ timestamp: '2026-07-22T00:00:00Z', type: 'break', player: 1 }));
  if (path.includes('/analysis')) return send(ANALYSIS);
  if (path.includes('/markets') || path.includes('/prices')) return send(MARKET);
  if (path.includes('/score')) return send(MATCH.score);
  if (path.includes('/fixtures')) return send(page(FIXTURE));
  // A trailing numeric segment means one item; otherwise a collection.
  const single = /\/\d+$/.test(path);
  if (path.includes('/players')) return send(single ? PLAYER : page(PLAYER));
  if (path.includes('/matches')) return send(single ? MATCH : page(MATCH));
  send(page(MATCH));
});

try {
  const stray = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(800) });
  if (stray.ok) { console.error(`FAIL: port ${UPSTREAM_PORT} is already serving`); process.exit(1); }
} catch { /* nothing listening, which is what we want */ }

await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

/**
 * The 24 tools, and plausible arguments for each, so none is skipped for lack
 * of input. `payload` is the field that proves the stub's data actually made it
 * through the mapper rather than the tool merely returning `ok: true`.
 */
const EXPECTED = {
  get_live_matches: { args: { limit: 2 }, payload: 'matches' },
  get_upcoming_matches: { args: { limit: 2 }, payload: 'matches' },
  get_match: { args: { match_id: 101 }, payload: 'match' },
  get_match_score: { args: { match_id: 101 }, payload: 'score' },
  search_players: { args: { query: 'player', limit: 2 }, payload: 'players' },
  get_player: { args: { player_id: 1 }, payload: 'player' },
  get_fixtures: { args: { limit: 2 }, payload: 'fixtures' },
  search_tournaments: { args: { query: 'test', limit: 2 }, payload: 'tournaments' },
  get_tournament: { args: { tournament_id: 'test-open' }, payload: 'tournament' },
  get_recent_results: { args: { limit: 2 }, payload: 'matches' },
  search_archive_matches: { args: { player_name: 'borg', limit: 2 }, payload: 'results' },
  get_archive_match: { args: { archive_match_id: 555 }, payload: 'result' },
  search_archive_players: { args: { query: 'borg', limit: 2 }, payload: 'players' },
  get_archive_career: { args: { name: 'borg' }, payload: 'record' },
  get_h2h: { args: { player1: 'federer', player2: 'nadal' }, payload: 'totals' },
  get_match_events: { args: { match_id: 101, limit: 2 }, payload: 'events' },
  get_match_odds: { args: { match_id: 101, limit: 2 }, payload: 'market' },
  get_rankings: { args: { system: 'atp', limit: 2 }, payload: 'rankings' },
  get_match_analysis: { args: { match_id: 101 }, payload: 'profile' },
  get_player_rankings: { args: { player_ids: [1] }, payload: 'rankings' },
  get_match_statistics: { args: { match_id: 101 }, payload: 'statistics' },
  get_charting_player: { args: { name: 'federer' }, payload: 'families' },
  get_charting_match: { args: { charting_match_id: 77 }, payload: 'families' },
  check_api_status: { args: {}, payload: 'reachable' },
};

/** `execute` is normally called by the SDK, which supplies these. */
const EXEC_OPTS = { toolCallId: 'test-call', messages: [] };

async function main() {
  const tools = livetennisTools({ apiKey: 'twjp_test_key', baseUrl: BASE_URL });
  const names = Object.keys(tools);

  // 1. Parity with the MCP server. A tool that exists on one surface and not
  //    the other is a bug in whichever one was edited last, and 24 is the number
  //    both READMEs, both registries and the MCP test all quote.
  if (names.length !== 24) fail(`expected 24 tools, got ${names.length}: ${names.join(', ')}`);
  const missing = Object.keys(EXPECTED).filter((k) => !names.includes(k));
  const extra = names.filter((k) => !EXPECTED[k]);
  if (missing.length || extra.length) {
    fail(`tool set differs from expected — missing: [${missing}] unexpected: [${extra}]`);
  }

  // Parity with the MCP server — the real invariant, not just tool names.
  //
  // These are two copies of the same 24 tools. A description improved in one and
  // not the other is the drift that actually costs users, and it is invisible to
  // a name-only check. So compare against what the MCP server ACTUALLY
  // advertises over the protocol, rather than regexing its source: source
  // parsing breaks silently when the formatting changes, and a check that
  // quietly stops checking is worse than no check.
  //
  // Optional by design — this package publishes standalone, so a missing or
  // unbuilt sibling must not fail the suite. But it says so out loud.
  const mcpEntry = new URL('../../livetennisapi-mcp/dist/index.js', import.meta.url).pathname;
  if (existsSync(mcpEntry)) {
    const mcp = spawn('node', [mcpEntry], { stdio: ['pipe', 'pipe', 'ignore'] });
    const say = (o) => mcp.stdin.write(JSON.stringify(o) + '\n');
    const replies = new Map();
    let buf = '';
    mcp.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        try { const m = JSON.parse(line); if (m.id != null) replies.set(m.id, m); } catch { /* partial */ }
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    say({ jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'parity', version: '1' } } });
    say({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    for (let i = 0; i < 100 && !replies.has(2); i++) await new Promise((r) => setTimeout(r, 50));
    mcp.kill('SIGKILL');

    const mcpTools = replies.get(2)?.result?.tools;
    if (!mcpTools) fail('could not read tools/list from the MCP server — parity check could not run');
    if (mcpTools.length !== 24) fail(`MCP server advertises ${mcpTools.length} tools, expected 24`);

    const drift = [];
    const mcpByName = new Map(mcpTools.map((t) => [t.name, t]));
    for (const [name, t] of Object.entries(tools)) {
      const m = mcpByName.get(name);
      if (!m) { drift.push(`only here: ${name}`); continue; }
      if (m.description !== t.description) {
        drift.push(`${name}: description differs from the MCP server`);
      }
    }
    for (const n of mcpByName.keys()) if (!tools[n]) drift.push(`only in MCP: ${n}`);
    if (drift.length) {
      fail(`DRIFTED from livetennisapi-mcp — the two packages must describe the same tools ` +
           `identically:\n    ` + drift.join('\n    '));
    }
    console.log('  parity: 24 tools + descriptions identical to livetennisapi-mcp');
  } else {
    console.log('  (livetennisapi-mcp not built alongside — PARITY CHECK SKIPPED)');
  }

  // 2. Metadata a model needs in order to choose and fill in the tool.
  for (const [name, t] of Object.entries(tools)) {
    if (!t.description) fail(`${name} has no description`);
    if (!t.inputSchema) fail(`${name} has no inputSchema`);
    if (!t.outputSchema) fail(`${name} declares no outputSchema`);
    if (typeof t.execute !== 'function') fail(`${name} has no execute`);
    // Every declared parameter needs a description, or the model is guessing.
    for (const [param, spec] of Object.entries(t.inputSchema.shape ?? {})) {
      if (!spec.description) fail(`${name}.${param} has no description`);
    }
    // The declared args must actually satisfy the declared schema.
    const parsed = t.inputSchema.safeParse(EXPECTED[name].args);
    if (!parsed.success) fail(`${name}: test args rejected by its own inputSchema — ${parsed.error.message}`);
  }

  // 3. THE PATH THAT BREAKS. No key at all: this must be an explanatory VALUE,
  //    never a throw, or a model loses the "here is how to get a key" remedy.
  const keyless = livetennisTools({ apiKey: '', baseUrl: BASE_URL });
  for (const [name, t] of Object.entries(keyless)) {
    const args = t.inputSchema.parse(EXPECTED[name].args);
    let result;
    try {
      result = await t.execute(args, EXEC_OPTS);
    } catch (err) {
      fail(`${name} (no key) THREW instead of returning an explanation: ${err?.message ?? err}`);
    }
    const check = t.outputSchema.safeParse(result);
    if (!check.success) fail(`${name} (no key) output violates its own schema — ${check.error.message}`);
    if (typeof result.message !== 'string' || !result.message.length) {
      fail(`${name} (no key) returned no explanatory message`);
    }
    if (name === 'check_api_status') {
      // The one tool that legitimately WORKS without a key — diagnosing "why is
      // everything else refusing data" is precisely its job, so it reports the
      // API as reachable and says the key is absent rather than refusing.
      if (result.ok !== true) fail('check_api_status should still succeed without a key — it is the diagnostic tool');
      if (result.has_key !== false) fail('check_api_status (no key) should report has_key:false');
      if (result.tier !== null) fail(`check_api_status (no key) should report tier:null, got ${result.tier}`);
    } else {
      if (result.ok !== false) fail(`${name} (no key) should report ok:false, got ${result.ok}`);
      if (!/api key/i.test(result.message)) {
        fail(`${name} (no key) message does not mention the API key: ${result.message.slice(0, 120)}`);
      }
    }
  }

  // 4. The success path, against the stub. This is where a mapper that dropped
  //    a field or a schema that drifted shows up.
  for (const [name, t] of Object.entries(tools)) {
    const args = t.inputSchema.parse(EXPECTED[name].args);
    const result = await t.execute(args, EXEC_OPTS);
    const check = t.outputSchema.safeParse(result);
    if (!check.success) fail(`${name} (with key) output violates its own schema — ${check.error.message}`);
    if (result.ok !== true) fail(`${name} (with key) returned ok:${result.ok} — ${result.message}`);
    if (typeof result.message !== 'string' || !result.message.length) fail(`${name} (with key) has no message`);
    const payload = EXPECTED[name].payload;
    if (result[payload] === undefined) {
      fail(`${name} returned ok:true but no ${payload} — the stub's data did not reach the caller`);
    }
    if (Array.isArray(result[payload]) && !result[payload].length) {
      fail(`${name} returned an empty ${payload} — the stub fed it nothing`);
    }
  }

  // 5. Spot-check the mappers against the stub's known values, so "the schema
  //    was satisfied" cannot pass on nulls all the way down.
  const live = await tools.get_live_matches.execute({ limit: 2 }, EXEC_OPTS);
  const m = live.matches[0];
  if (m.id !== 101) fail(`expected match id 101, got ${m.id}`);
  if (m.player1 !== 'Player One' || m.player2 !== 'Player Two') fail(`players not mapped: ${JSON.stringify(m)}`);
  if (m.win_probability_p1 !== 0.61) fail(`win probability not mapped: ${m.win_probability_p1}`);
  if (m.event_status !== 'Interrupted') fail(`event_status not mapped: ${m.event_status}`);
  if (m.event_status_updated_at !== '2026-08-19T09:15:00Z') {
    fail(`event_status_updated_at not mapped: ${m.event_status_updated_at}`);
  }
  if (!m.score || m.score === '') fail('score not formatted');
  if (!live.message.includes('Player One')) fail('message does not summarise the match');

  const odds = await tools.get_match_odds.execute({ match_id: 101, limit: 2 }, EXEC_OPTS);
  if (odds.market.prices[0].mid !== 0.6) fail(`market mid not mapped: ${JSON.stringify(odds.market)}`);

  const analysis = await tools.get_match_analysis.execute({ match_id: 101 }, EXEC_OPTS);
  if (analysis.thesis.pick_side !== 1) fail(`thesis not mapped: ${JSON.stringify(analysis.thesis)}`);

  // The 1.1.0 surface, spot-checked the same way.
  const h2h = await tools.get_h2h.execute({ player1: 'federer', player2: 'nadal' }, EXEC_OPTS);
  if (h2h.totals.p2_wins !== 24) fail(`h2h totals not mapped: ${JSON.stringify(h2h.totals)}`);
  if (h2h.players.p1 !== 'Roger Federer') fail(`h2h names not resolved: ${JSON.stringify(h2h.players)}`);
  if (h2h.meetings[0].winner !== 2) fail(`h2h meeting winner not mapped: ${JSON.stringify(h2h.meetings[0])}`);

  const rankings = await tools.get_rankings.execute({ system: 'atp', limit: 2 }, EXEC_OPTS);
  if (rankings.rankings[0].rank !== 3 || rankings.rankings[0].points !== 7000) {
    fail(`ranking row not mapped: ${JSON.stringify(rankings.rankings[0])}`);
  }

  const pr = await tools.get_player_rankings.execute({ player_ids: [1] }, EXEC_OPTS);
  if (pr.coverage?.players_resolved !== 1) fail(`rankings coverage meta not surfaced: ${JSON.stringify(pr.coverage)}`);

  const arch = await tools.search_archive_matches.execute({ player_name: 'borg', limit: 2 }, EXEC_OPTS);
  if (arch.results[0].winner.name !== 'Bjorn Borg') fail(`archive winner not mapped: ${JSON.stringify(arch.results[0])}`);

  const stats = await tools.get_match_statistics.execute({ match_id: 101 }, EXEC_OPTS);
  const p1stats = stats.statistics.players.p1;
  if (p1stats.derived.hold_pct !== 85.7) fail(`derived stats not mapped: ${JSON.stringify(p1stats.derived)}`);
  if (p1stats.measured.aces !== 5) fail(`measured stats not mapped: ${JSON.stringify(p1stats.measured)}`);

  const charted = await tools.get_charting_player.execute({ name: 'federer' }, EXEC_OPTS);
  if (charted.matches_charted !== 500) fail(`charting sample not mapped: ${JSON.stringify(charted)}`);

  // 6. The individual exports must behave identically to the set — they are the
  //    documented way to ship a subset, so they cannot be a second-class path.
  const solo = getLiveMatches({ apiKey: 'twjp_test_key', baseUrl: BASE_URL });
  const soloResult = await solo.execute({ limit: 2 }, EXEC_OPTS);
  if (soloResult.ok !== true || soloResult.matches[0].id !== 101) {
    fail(`the individually-exported getLiveMatches disagrees with the set: ${JSON.stringify(soloResult).slice(0, 200)}`);
  }

  console.log(
    'OK - 24 tools · description + described params + outputSchema · ' +
      'output parsed by its own schema on the no-key AND success paths · ' +
      'mappers spot-checked · individual exports match the set',
  );
}

main()
  .then(() => shutdown(0))
  .catch((e) => {
    console.error('FAIL:', e.message);
    console.error('--- upstream paths asked ---\n ', [...new Set(asked)].join('\n  '));
    shutdown(1);
  });

function shutdown(code) {
  upstream.closeAllConnections?.();
  upstream.close();
  process.exit(code);
}
