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
 * The 12 tools, and plausible arguments for each, so none is skipped for lack
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
  get_recent_results: { args: { limit: 2 }, payload: 'matches' },
  get_match_events: { args: { match_id: 101, limit: 2 }, payload: 'events' },
  get_match_odds: { args: { match_id: 101, limit: 2 }, payload: 'market' },
  get_match_analysis: { args: { match_id: 101 }, payload: 'profile' },
  check_api_status: { args: {}, payload: 'reachable' },
};

/** `execute` is normally called by the SDK, which supplies these. */
const EXEC_OPTS = { toolCallId: 'test-call', messages: [] };

async function main() {
  const tools = livetennisTools({ apiKey: 'twjp_test_key', baseUrl: BASE_URL });
  const names = Object.keys(tools);

  // 1. Parity with the MCP server. A tool that exists on one surface and not
  //    the other is a bug in whichever one was edited last, and 12 is the number
  //    both READMEs, both registries and the MCP test all quote.
  if (names.length !== 12) fail(`expected 12 tools, got ${names.length}: ${names.join(', ')}`);
  const missing = Object.keys(EXPECTED).filter((k) => !names.includes(k));
  const extra = names.filter((k) => !EXPECTED[k]);
  if (missing.length || extra.length) {
    fail(`tool set differs from expected — missing: [${missing}] unexpected: [${extra}]`);
  }

  // Parity with the MCP server — the real invariant, not just tool names.
  //
  // These are two copies of the same 12 tools. A description improved in one and
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
    if (mcpTools.length !== 12) fail(`MCP server advertises ${mcpTools.length} tools, expected 12`);

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
    console.log('  parity: 12 tools + descriptions identical to livetennisapi-mcp');
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
  if (!m.score || m.score === '') fail('score not formatted');
  if (!live.message.includes('Player One')) fail('message does not summarise the match');

  const odds = await tools.get_match_odds.execute({ match_id: 101, limit: 2 }, EXEC_OPTS);
  if (odds.market.prices[0].mid !== 0.6) fail(`market mid not mapped: ${JSON.stringify(odds.market)}`);

  const analysis = await tools.get_match_analysis.execute({ match_id: 101 }, EXEC_OPTS);
  if (analysis.thesis.pick_side !== 1) fail(`thesis not mapped: ${JSON.stringify(analysis.thesis)}`);

  // 6. The individual exports must behave identically to the set — they are the
  //    documented way to ship a subset, so they cannot be a second-class path.
  const solo = getLiveMatches({ apiKey: 'twjp_test_key', baseUrl: BASE_URL });
  const soloResult = await solo.execute({ limit: 2 }, EXEC_OPTS);
  if (soloResult.ok !== true || soloResult.matches[0].id !== 101) {
    fail(`the individually-exported getLiveMatches disagrees with the set: ${JSON.stringify(soloResult).slice(0, 200)}`);
  }

  console.log(
    'OK - 12 tools · description + described params + outputSchema · ' +
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
