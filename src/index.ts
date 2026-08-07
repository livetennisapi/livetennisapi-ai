/**
 * Public surface: one factory for the whole set, one factory per tool.
 *
 *   import { livetennisTools } from 'livetennisapi-ai';
 *   tools: livetennisTools({ apiKey: process.env.LIVETENNISAPI_KEY })
 *
 * Every export is a FACTORY rather than a ready-made tool object, for the same
 * reason the AI SDK's own registry entries are: a tool has to be bound to a key
 * before it can do anything, and a module-level singleton would bind it to
 * whatever key existed at import time. Factories also let one process serve
 * several users, each with their own tool set on their own plan.
 *
 * Individual factories exist so a caller can ship three tools instead of
 * twenty-four. That is not a micro-optimisation: every tool's schema and
 * description is sent to the model on every single request, so an app that only
 * needs live scores pays for the other twenty-one in tokens, on every turn,
 * forever.
 */

import {
  createContext,
  defineCheckApiStatus,
  defineGetArchiveCareer,
  defineGetArchiveMatch,
  defineGetChartingMatch,
  defineGetChartingPlayer,
  defineGetFixtures,
  defineGetH2H,
  defineGetLiveMatches,
  defineGetMatch,
  defineGetMatchAnalysis,
  defineGetMatchEvents,
  defineGetMatchOdds,
  defineGetMatchScore,
  defineGetMatchStatistics,
  defineGetPlayer,
  defineGetPlayerRankings,
  defineGetRankings,
  defineGetRecentResults,
  defineGetTournament,
  defineGetUpcomingMatches,
  defineSearchArchiveMatches,
  defineSearchArchivePlayers,
  defineSearchPlayers,
  defineSearchTournaments,
  type LiveTennisToolOptions,
} from './tools.js';

export { VERSION, type LiveTennisToolOptions } from './tools.js';

/**
 * Every Live Tennis API tool, ready to pass to `generateText`/`streamText`.
 *
 * The keys are snake_case to match the MCP server's tool names exactly. Those
 * names are load-bearing: several descriptions cross-reference each other
 * ("Pass to get_match"), so camelCasing the keys would make the descriptions
 * point at tools that do not exist.
 */
export function livetennisTools(options: LiveTennisToolOptions = {}) {
  const ctx = createContext(options);
  return {
    get_live_matches: defineGetLiveMatches(ctx),
    get_upcoming_matches: defineGetUpcomingMatches(ctx),
    get_match: defineGetMatch(ctx),
    get_match_score: defineGetMatchScore(ctx),
    search_players: defineSearchPlayers(ctx),
    get_player: defineGetPlayer(ctx),
    get_fixtures: defineGetFixtures(ctx),
    search_tournaments: defineSearchTournaments(ctx),
    get_tournament: defineGetTournament(ctx),
    get_recent_results: defineGetRecentResults(ctx),
    search_archive_matches: defineSearchArchiveMatches(ctx),
    get_archive_match: defineGetArchiveMatch(ctx),
    search_archive_players: defineSearchArchivePlayers(ctx),
    get_archive_career: defineGetArchiveCareer(ctx),
    get_h2h: defineGetH2H(ctx),
    get_match_events: defineGetMatchEvents(ctx),
    get_match_odds: defineGetMatchOdds(ctx),
    get_rankings: defineGetRankings(ctx),
    get_match_analysis: defineGetMatchAnalysis(ctx),
    get_player_rankings: defineGetPlayerRankings(ctx),
    get_match_statistics: defineGetMatchStatistics(ctx),
    get_charting_player: defineGetChartingPlayer(ctx),
    get_charting_match: defineGetChartingMatch(ctx),
    check_api_status: defineCheckApiStatus(ctx),
  };
}

// -- individual tools ----------------------------------------------------------
// Each builds its own single-tool context, so picking a subset costs nothing
// and needs no knowledge of the set factory.

/** List tennis matches currently in progress, with live scores. */
export const getLiveMatches = (o: LiveTennisToolOptions = {}) => defineGetLiveMatches(createContext(o));

/** List tennis matches scheduled to start soon. */
export const getUpcomingMatches = (o: LiveTennisToolOptions = {}) => defineGetUpcomingMatches(createContext(o));

/** Full detail for one match by id. */
export const getMatch = (o: LiveTennisToolOptions = {}) => defineGetMatch(createContext(o));

/** Current score for one match — the lowest-latency read. */
export const getMatchScore = (o: LiveTennisToolOptions = {}) => defineGetMatchScore(createContext(o));

/** Search tennis players by name. */
export const searchPlayers = (o: LiveTennisToolOptions = {}) => defineSearchPlayers(createContext(o));

/** One player's profile. */
export const getPlayer = (o: LiveTennisToolOptions = {}) => defineGetPlayer(createContext(o));

/** Upcoming scheduled fixtures, earliest first. */
export const getFixtures = (o: LiveTennisToolOptions = {}) => defineGetFixtures(createContext(o));

/** Search the tournament catalogue — the stable id space behind tournament_id. */
export const searchTournaments = (o: LiveTennisToolOptions = {}) => defineSearchTournaments(createContext(o));

/** One tournament by its stable id. */
export const getTournament = (o: LiveTennisToolOptions = {}) => defineGetTournament(createContext(o));

/** Recently completed matches with final scores and winners. Requires BASIC or any History plan. */
export const getRecentResults = (o: LiveTennisToolOptions = {}) => defineGetRecentResults(createContext(o));

/** Search the results archive (1968–2022). Requires BASIC or any History plan. */
export const searchArchiveMatches = (o: LiveTennisToolOptions = {}) => defineSearchArchiveMatches(createContext(o));

/** One results-archive record, with serve stats where the era recorded them. Requires BASIC or any History plan. */
export const getArchiveMatch = (o: LiveTennisToolOptions = {}) => defineGetArchiveMatch(createContext(o));

/** Archive player bios (1968–2022). Requires BASIC or any History plan. */
export const searchArchivePlayers = (o: LiveTennisToolOptions = {}) => defineSearchArchivePlayers(createContext(o));

/** Career aggregates over the results archive for one player. Requires BASIC or any History plan. */
export const getArchiveCareer = (o: LiveTennisToolOptions = {}) => defineGetArchiveCareer(createContext(o));

/** All-time head-to-head across the archive and our own matches. Requires BASIC or any History plan. */
export const getH2H = (o: LiveTennisToolOptions = {}) => defineGetH2H(createContext(o));

/** Timeline of events for a match. Requires the PRO plan. */
export const getMatchEvents = (o: LiveTennisToolOptions = {}) => defineGetMatchEvents(createContext(o));

/** Match-winner market prices. Requires the PRO plan. */
export const getMatchOdds = (o: LiveTennisToolOptions = {}) => defineGetMatchOdds(createContext(o));

/** The full published ranking table for one system. Requires the PRO plan. */
export const getRankings = (o: LiveTennisToolOptions = {}) => defineGetRankings(createContext(o));

/** Model analysis for a match. Requires the ULTRA plan. */
export const getMatchAnalysis = (o: LiveTennisToolOptions = {}) => defineGetMatchAnalysis(createContext(o));

/** Point-in-time ranking records for specific players. Requires the ULTRA plan. */
export const getPlayerRankings = (o: LiveTennisToolOptions = {}) => defineGetPlayerRankings(createContext(o));

/** In-play statistics for one match — derived + measured families. Requires the ULTRA plan. */
export const getMatchStatistics = (o: LiveTennisToolOptions = {}) => defineGetMatchStatistics(createContext(o));

/** Career shot-level charting profile for one player. Requires the ULTRA plan. */
export const getChartingPlayer = (o: LiveTennisToolOptions = {}) => defineGetChartingPlayer(createContext(o));

/** Every charting stat family for one charted match. Requires the ULTRA plan. */
export const getChartingMatch = (o: LiveTennisToolOptions = {}) => defineGetChartingMatch(createContext(o));

/** Is the API reachable, and which plan is this key on? */
export const checkApiStatus = (o: LiveTennisToolOptions = {}) => defineCheckApiStatus(createContext(o));
