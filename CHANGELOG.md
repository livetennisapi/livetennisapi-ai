# Changelog

All notable changes are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-08-07

### Added
- **Twelve new tools** (24 total), in exact name/description parity with
  `livetennisapi-mcp` 1.4.0:
  - `search_tournaments` / `get_tournament` — the tournament catalogue behind
    `tournament_id` (FREE);
  - `search_archive_matches`, `get_archive_match`, `search_archive_players`,
    `get_archive_career` — the 1968–2022 results archive: 1,485,752 matches,
    bios, career aggregates, serve stats where the era recorded them (BASIC or
    any History plan);
  - `get_h2h` — all-time head-to-head across the archive and our own completed
    matches (BASIC or any History plan);
  - `get_rankings` — the full published ranking table per system (PRO);
  - `get_player_rankings` — point-in-time per-player rankings as of a date
    (ULTRA);
  - `get_match_statistics` — in-play statistics, derived + measured families
    kept honestly separate (ULTRA);
  - `get_charting_player` / `get_charting_match` — Match Charting Project
    shot-level data (ULTRA).
  Each new tool also has an individual export for subset shipping.
- **New list filters** on `get_live_matches`, `get_upcoming_matches`,
  `get_recent_results` and `get_fixtures`: `tour` (atp, wta, challenger, itf,
  juniors), `player` ids (max 50), `country` (IOC-style 3-letter code) and
  `from`/`to` date bounds where the endpoint supports them.
- **Match fields**: tool output now carries `tour`, `tournament_id`,
  `round_code`, `event_status` and `withdrew` — enough to branch settlement
  logic on retirements and walkovers.
- **Honest 429 handling**: the three 429 shapes are told apart. The daily-quota
  message surfaces the exact `resets_at` instant; `abuse_throttled` (a ~24 h
  block for clients that hammer through 429s) surfaces the `retry_at_epoch`
  resume time and says to fix the retry loop. Ambiguous-name 400s from
  `get_h2h`/`get_archive_career`/`get_charting_player` relay the candidate list.
- `scripts/truthcheck.sh` — CI-enforced pin of product facts (quota grid, docs
  URL, org identity).

### Changed
- Quota grid updated to the 2026-08-06 plans: FREE 100/day, BASIC 1,000/day,
  PRO 10,000/day, ULTRA 500,000/day (30/60/300/600 per minute).
- Tour coverage phrasing everywhere: ATP, WTA, Challenger, ITF and juniors.
- `livetennisapi` dependency raised to ^1.4.0 (the client that carries the new
  surface).

## [1.0.0] — 2026-08-02

Initial release.

### Added
- **All 12 Live Tennis API tools as Vercel AI SDK tools**, mirroring the MCP
  server's tool set (names and descriptions kept in parity by test):
  live matches, upcoming matches, match by id, match score, player search,
  player by id, fixtures, recent results, match events, match odds, match
  analysis and API status.
- `livetennisTools({ apiKey?, baseUrl? })` returns a complete tool set bound
  to exactly one key — several tool sets with different keys can coexist in
  one process. Each tool is also exported individually so an app can send the
  model only the schemas it needs.
- **Errors are values.** Tools never throw at the model: missing key, tier
  limits (403 `upgrade_required`), rate limits and not-found all come back as
  plain-language results the model can act on, including which tier unlocks a
  gated endpoint.
- API key resolution: explicit `apiKey` option first, then
  `LIVETENNISAPI_KEY` from the environment. With no key at all the tools
  respond with how to get one (free, no card, at
  <https://livetennisapi.com/subscribe/free>) instead of failing.
- `ai` v7 is a peer dependency; `livetennisapi` ^1.2.0 and `zod` are the only
  runtime dependencies.
