/**
 * The 12 Live Tennis API tools, as Vercel AI SDK tools.
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
 * A tier wall, a rejected key, a missing key and an empty result are all normal
 * states with a clear remedy. `guard()` below turns each into a returned object
 * carrying `ok: false` and an actionable `message`. This is the single most
 * important behaviour inherited from the MCP server: marking a tier wall as an
 * error makes models retry it or abandon the task, instead of relaying the
 * upgrade path to the user, who is the only one who can act on it.
 */

import { tool } from 'ai';
import {
  LiveTennisAPI,
  NotFound,
  RateLimited,
  Unauthorized,
  UpgradeRequired,
  formatScore,
  type Match,
} from 'livetennisapi';
import { z } from 'zod';

export const VERSION = '1.0.0';

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
  client: LiveTennisAPI;
  guard: <T extends { ok: boolean; message: string }>(run: () => Promise<T>) => Promise<T | Failure>;
};

/** Build the per-key context every tool in a set shares. */
export function createContext(options: LiveTennisToolOptions = {}): Context {
  const apiKey = (options.apiKey ?? env('LIVETENNISAPI_KEY') ?? '').trim();
  const baseUrl = options.baseUrl ?? env('LIVETENNISAPI_BASE_URL');
  const client = new LiveTennisAPI({ apiKey, baseUrl });

  const fail = (message: string): Failure => ({ ok: false, message });

  async function guard<T extends { ok: boolean; message: string }>(run: () => Promise<T>): Promise<T | Failure> {
    if (!apiKey) {
      return fail(
        'No API key configured. Pass { apiKey } to the tool factory, or set LIVETENNISAPI_KEY in ' +
          'the environment. Get a free key, no card, at https://livetennisapi.com/subscribe/free',
      );
    }
    try {
      return await run();
    } catch (err) {
      if (err instanceof UpgradeRequired) {
        return fail(
          `This data requires the ${err.requiredTier ?? 'a higher'} plan, and the configured ` +
            `API key is on a lower tier. Nothing is wrong with the key — the endpoint is ` +
            `simply not included in the current plan. Upgrade at https://livetennisapi.com/#pricing\n\n` +
            `Tiers: FREE = live & upcoming matches, scores, players, fixtures · ` +
            `BASIC = + historical results · ` +
            `PRO = + match events and market prices · ` +
            `ULTRA = + model analysis, win probability and the live WebSocket feed.`,
        );
      }
      if (err instanceof Unauthorized) {
        return fail(
          'The API key was rejected — it is missing, unknown, or disabled. Check the key passed ' +
            'to the tool factory or set in LIVETENNISAPI_KEY. Keys are at https://livetennisapi.com',
        );
      }
      if (err instanceof NotFound) {
        return fail('No data found for that request. The id may be wrong, or there may be no data yet.');
      }
      if (err instanceof RateLimited) {
        const wait = err.retryAfter ? ` Retry in about ${err.retryAfter}s.` : '';
        return fail(`Rate limit reached for this plan.${wait}`);
      }
      // A genuine fault. The MCP server flags these with `isError: true`, which
      // has no AI SDK equivalent other than throwing — and a throw out of
      // `execute` can abort the caller's whole generation over one bad request.
      // So it stays a value here, distinguishable by the message prefix.
      return fail(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { apiKey, client, guard };
}

// -- shared field definitions --------------------------------------------------
// Declared once so all 12 tools describe the same concept the same way.

const okField = z
  .boolean()
  .describe(
    'True when the call returned data. False for a tier wall, a missing or rejected key, ' +
      'or an empty result — all of which are normal states with a clear remedy, not failures.',
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
  tournament: z.string().nullable().describe('Event name, e.g. "Wimbledon".'),
  round: z.string().nullable().describe('Round within the event, e.g. "QF".'),
  player1: z.string().nullable().describe('Name of player 1.'),
  player2: z.string().nullable().describe('Name of player 2.'),
  score: z.string().nullable().describe('Formatted score line, e.g. "6-4 3-6 2-1".'),
  status: z.string().nullable().describe('One of live, upcoming or completed.'),
  surface: z.string().nullable().describe('Court surface, e.g. hard, clay, grass.'),
  indoor: z.boolean().nullable().describe('True when played indoors.'),
  serving: z.number().nullable().describe('1 or 2 while a point is in play, otherwise null.'),
  winner: z.number().nullable().describe('1 or 2 once decided, otherwise null.'),
  win_probability_p1: z
    .number()
    .nullable()
    .describe('Model probability that player 1 wins, 0-1. Requires the ULTRA plan; null otherwise.'),
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
  event_date: z.string().nullable().describe('Scheduled start, ISO timestamp.'),
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

/** Normalise `undefined` to `null` — the schemas above are nullable, not optional. */
const n = <T,>(v: T | undefined | null): T | null => (v == null ? null : v);

function matchOut(m: Match): z.infer<typeof MatchOut> {
  return {
    id: n(m.id),
    tournament: n(m.tournament),
    round: n(m.round),
    player1: n(m.players?.p1?.name),
    player2: n(m.players?.p2?.name),
    score: n(formatScore(m.score)),
    status: n(m.status),
    surface: n(m.surface),
    indoor: n(m.indoor),
    serving: n(m.score?.server),
    winner: n(m.winner),
    win_probability_p1: n(m.score?.win_probability_p1),
  };
}

/** Compact one-line match summary — token-efficient for a model to read. */
function summarise(match: Match): string {
  const p1 = match.players?.p1?.name ?? '?';
  const p2 = match.players?.p2?.name ?? '?';
  const serving = match.score?.server === 1 ? ' (serving)' : '';
  const serving2 = match.score?.server === 2 ? ' (serving)' : '';
  const bits = [
    `[${match.id}] ${match.tournament ?? 'Unknown event'}${match.round ? ` — ${match.round}` : ''}`,
    `  ${p1}${serving} vs ${p2}${serving2}`,
    `  Score: ${formatScore(match.score)}`,
  ];
  if (match.surface) bits.push(`  Surface: ${match.surface}${match.indoor ? ' (indoor)' : ''}`);
  if (match.status && match.status !== 'live') bits.push(`  Status: ${match.status}`);
  if (match.winner) bits.push(`  Winner: ${match.winner === 1 ? p1 : p2}`);
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

// -- output schemas ------------------------------------------------------------
// Named rather than inlined so each tool's `execute` can be annotated with its
// own return type. That annotation is what makes TypeScript enforce that the
// value a tool returns actually matches the schema it advertises — the AI SDK
// does NOT validate tool output at runtime, so this is the only thing standing
// between a schema and the data drifting apart.

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
    .describe('Match-winner market. Requires the PRO plan; absent otherwise.'),
  analysis: z
    .object({
      win_probability_p1: z.number().nullable().describe('Model probability player 1 wins, 0-1.'),
      key_factors: z.array(z.string()).describe('Drivers behind the model view.'),
    })
    .optional()
    .describe('Model analysis. Requires the ULTRA plan; absent otherwise.'),
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
    .describe('Events in chronological order.'),
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

// -- the tools -----------------------------------------------------------------
// Each `define*` takes the shared context so a whole tool set costs one client.
// The public factories in index.ts build a context per call.

// -- FREE / BASIC --

export const defineGetLiveMatches = (ctx: Context) =>
  tool({
    description:
      'List tennis matches currently in progress, with live scores. Covers ATP, WTA, ' +
      'Challenger and ITF. Use this for "what tennis is on right now".',
    inputSchema: z.object({ limit: limitField(200, 20, 'matches') }),
    outputSchema: LiveMatchesOutput,
    execute: ({ limit }): Promise<z.infer<typeof LiveMatchesOutput>> =>
      ctx.guard(async () => {
        const page = await ctx.client.listMatches({ status: 'live', limit });
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
    description: 'List tennis matches scheduled to start soon, with players and tournament.',
    inputSchema: z.object({ limit: limitField(200, 20, 'matches') }),
    outputSchema: UpcomingMatchesOutput,
    execute: ({ limit }): Promise<z.infer<typeof UpcomingMatchesOutput>> =>
      ctx.guard(async () => {
        const page = await ctx.client.listMatches({ status: 'upcoming', limit });
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
      'Full detail for one match by id: players, score, surface, round and status. ' +
      'Includes market prices on PRO and model analysis on ULTRA.',
    inputSchema: z.object({ match_id: matchIdField }),
    outputSchema: MatchOutput,
    execute: ({ match_id }): Promise<z.infer<typeof MatchOutput>> =>
      ctx.guard(async () => {
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
          if (profile.key_factors?.length) message += `\n  Key factors: ${profile.key_factors.join('; ')}`;
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
      'Current score for one match — the fastest, lowest-latency read. Use this when ' +
      'you only need the score and already know the match id.',
    inputSchema: z.object({ match_id: matchIdField }),
    outputSchema: MatchScoreOutput,
    execute: ({ match_id }): Promise<z.infer<typeof MatchScoreOutput>> =>
      ctx.guard(async () => {
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
      'Search tennis players by name. Returns id, country, ranking and tour. Use the ' +
      'returned id with get_player.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Full or partial player name, e.g. "alcaraz".'),
      limit: limitField(200, 10, 'players'),
    }),
    outputSchema: SearchPlayersOutput,
    execute: ({ query, limit }): Promise<z.infer<typeof SearchPlayersOutput>> =>
      ctx.guard(async () => {
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
                `${p.ranking != null ? ` — rank ${p.ranking}` : ''}${p.tour ? ` · ${p.tour}` : ''}`,
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
    description: "One player's profile: ranking, country, handedness, date of birth and cached stats.",
    inputSchema: z.object({
      player_id: z.number().int().describe('Player id, as returned by search_players.'),
    }),
    outputSchema: PlayerOutput,
    execute: ({ player_id }): Promise<z.infer<typeof PlayerOutput>> =>
      ctx.guard(async () => {
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
    description: 'Upcoming scheduled tennis fixtures, earliest first — the forward schedule.',
    inputSchema: z.object({ limit: limitField(200, 20, 'fixtures') }),
    outputSchema: FixturesOutput,
    execute: ({ limit }): Promise<z.infer<typeof FixturesOutput>> =>
      ctx.guard(async () => {
        const page = await ctx.client.listFixtures({ limit });
        if (!page.data.length) return { ok: true as const, message: 'No upcoming fixtures.', fixtures: [] };
        return {
          ok: true as const,
          message: page.data
            .map(
              (f) =>
                `${f.event_date ?? '?'} — ${f.tournament ?? '?'}` +
                `${f.round ? ` (${f.round})` : ''}: ${f.player1_name ?? '?'} vs ${f.player2_name ?? '?'}`,
            )
            .join('\n'),
          fixtures: page.data.map((f) => ({
            event_date: n(f.event_date),
            tournament: n(f.tournament),
            round: n(f.round),
            player1: n(f.player1_name),
            player2: n(f.player2_name),
          })),
        };
      }),
  });

export const defineGetRecentResults = (ctx: Context) =>
  tool({
    description: 'Recently completed tennis matches with final scores and winners.',
    inputSchema: z.object({ limit: limitField(200, 20, 'matches') }),
    outputSchema: RecentResultsOutput,
    execute: ({ limit }): Promise<z.infer<typeof RecentResultsOutput>> =>
      ctx.guard(async () => {
        const page = await ctx.client.listCompletedMatches({ limit });
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

// -- PRO --

export const defineGetMatchEvents = (ctx: Context) =>
  tool({
    description:
      'Timeline of events for a match — breaks, games won, sets won, momentum runs. ' +
      'Requires the PRO plan.',
    inputSchema: z.object({ match_id: matchIdField, limit: limitField(200, 30, 'events') }),
    outputSchema: MatchEventsOutput,
    execute: ({ match_id, limit }): Promise<z.infer<typeof MatchEventsOutput>> =>
      ctx.guard(async () => {
        const page = await ctx.client.listMatchEvents(match_id, { limit });
        if (!page.data.length) {
          return { ok: true as const, message: 'No events recorded for this match.', events: [] };
        }
        return {
          ok: true as const,
          message: page.data
            .map((e) => `${e.timestamp ?? '?'} — ${e.type ?? '?'}${e.player ? ` (player ${e.player})` : ''}`)
            .join('\n'),
          events: page.data.map((e) => ({ timestamp: n(e.timestamp), type: n(e.type), player: n(e.player) })),
        };
      }),
  });

export const defineGetMatchOdds = (ctx: Context) =>
  tool({
    description:
      'Match-winner market prices for a match — implied probability per player, with ' +
      'bid, ask and mid. Requires the PRO plan.',
    inputSchema: z.object({ match_id: matchIdField, limit: limitField(200, 10, 'price points') }),
    outputSchema: MatchOddsOutput,
    execute: ({ match_id, limit }): Promise<z.infer<typeof MatchOddsOutput>> =>
      ctx.guard(async () => {
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

// -- ULTRA --

export const defineGetMatchAnalysis = (ctx: Context) =>
  tool({
    description:
      "Model analysis for a match: predicted win probability, the model's thesis and " +
      'the key factors behind it. Requires the ULTRA plan.',
    inputSchema: z.object({ match_id: matchIdField }),
    outputSchema: MatchAnalysisOutput,
    execute: ({ match_id }): Promise<z.infer<typeof MatchAnalysisOutput>> =>
      ctx.guard(async () => {
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
          if (p.key_factors?.length) lines.push(`  Key factors: ${p.key_factors.join('; ')}`);
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

// -- meta --

export const defineCheckApiStatus = (ctx: Context) =>
  tool({
    description:
      'Check whether the Live Tennis API is reachable and which plan the configured ' +
      'key is on. Useful for diagnosing why other tools are refusing data.',
    inputSchema: z.object({}),
    outputSchema: ApiStatusOutput,
    // Deliberately NOT wrapped in `guard`: diagnosing "why is everything else
    // refusing data" is precisely this tool's job, so it must still answer when
    // no key is configured. `guard` would short-circuit it into the very
    // message the user is trying to debug.
    execute: async (): Promise<z.infer<typeof ApiStatusOutput>> => {
      try {
        const health = await ctx.client.health();
        if (!ctx.apiKey) {
          return {
            ok: true,
            message:
              `API is reachable (status: ${health.status}, version: ${health.version}).\n` +
              'No API key is configured, so only this check will work. Pass { apiKey } to the tool ' +
              'factory or set LIVETENNISAPI_KEY — get a free key at https://livetennisapi.com/subscribe/free',
            reachable: true,
            api_version: n(health.version),
            tier: null,
            has_key: false,
          };
        }
        // Probe upward to discover the tier without asking the user.
        let tier = 'BASIC';
        try {
          await ctx.client.listMatches({ status: 'completed', limit: 1 });
        } catch (err) {
          if (err instanceof Unauthorized) {
            return {
              ok: true,
              message: 'API is reachable, but the configured key was rejected (unauthorized).',
              reachable: true,
              api_version: n(health.version),
              tier: null,
              has_key: true,
            };
          }
          throw err;
        }
        // FREE stops short of history, so an UpgradeRequired HERE identifies it —
        // and MUST be caught. Uncaught it escapes to the outer handler, which
        // would report a perfectly valid free key as "Could not reach the API".
        let historyPage: Awaited<ReturnType<typeof ctx.client.listCompletedMatches>> | null = null;
        try {
          historyPage = await ctx.client.listCompletedMatches({ limit: 1 });
        } catch (err) {
          if (err instanceof UpgradeRequired) tier = 'FREE';
          else throw err;
        }
        const id = historyPage?.data[0]?.id;
        // A FREE key cannot hold PRO/ULTRA, so skip the climb entirely.
        if (tier !== 'FREE' && id != null) {
          // Climb the ladder. Only UpgradeRequired proves a tier is NOT held --
          // NotFound means the call was allowed but that match has no data, so
          // it is evidence of entitlement, not of a missing plan.
          try {
            await ctx.client.listMatchEvents(id, { limit: 1 });
            tier = 'PRO';
          } catch (err) {
            if (err instanceof NotFound) tier = 'PRO';
            else if (!(err instanceof UpgradeRequired)) throw err;
          }
          if (tier === 'PRO') {
            try {
              await ctx.client.getMatchAnalysis(id);
              tier = 'ULTRA';
            } catch (err) {
              if (err instanceof NotFound) tier = 'ULTRA';
              else if (!(err instanceof UpgradeRequired)) throw err;
            }
          }
        }
        return {
          ok: true,
          message:
            `API is reachable (status: ${health.status}, version: ${health.version}).\n` +
            `The configured key appears to be on the ${tier} plan.\n\n` +
            'FREE  = live & upcoming matches, scores, players, fixtures\n' +
            'BASIC = + historical results\n' +
            'PRO   = + match events and market prices\n' +
            'ULTRA = + model analysis, win probability and the live feed',
          reachable: true,
          api_version: n(health.version),
          tier,
          has_key: true,
        };
      } catch (err) {
        // The MCP server returns `isError: true` here. This package has no such
        // channel, and an unreachable API is exactly the finding this tool
        // exists to report — so it is reported as data, not as a throw.
        return {
          ok: false,
          message: `Could not reach the API: ${err instanceof Error ? err.message : String(err)}`,
          reachable: false,
          has_key: Boolean(ctx.apiKey),
        };
      }
    },
  });
