# Changelog

All notable changes are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.3.0] (2026-10-22)

### Added
- `player_stats`, the 25th tool, with `playerStats` as its own export. It reads
  `GET /players/{playerId}/stats` through `getPlayerStats()` in livetennisapi 1.10.0. It covers
  one player's completed singles matches in our own data from 2023 on, by default the last 365
  days. You get the W-L record in total, over the last 12 months and by surface, venue, level
  and season. It also returns the set record, withdrawals and the last N matches, each score
  from the player's side. On ULTRA it passes `serve_return` through, the summed serve and return statistics.
  Below ULTRA that field is `null`. The tool takes `player_id`, `from`, `to`, `surface`, `level`
  and `last`, and needs the PRO plan. Its name, description and parameters are the same as
  `player_stats` in livetennisapi-mcp 1.6.1.
- A doubles-team id gets `ok: false` and a message that stats cover singles only, so the model
  asks for each player's own id. The API refuses such an id with 400 `doubles_not_supported`.
- An empty sample keeps its nulls. The W-L and set counts are 0. Each percentage is `null` and
  not 0, and so are the `serve_return` sums. The message says "no matches".
- The parity test also compares parameter names and required parameters with the MCP server.
  `LIVETENNISAPI_MCP_ENTRY` points it at any build, such as a published one in a scratch folder.

### Changed
- The livetennisapi dependency is now `^1.10.0`.
- The plan list in the upgrade message and in `check_api_status` names player records under PRO.

## [1.2.1] (2026-10-22)

1.2.0 was never published to npm. This release ships everything listed under 1.2.0, plus the
`event_status_updated_at` field the 1.2.0 entry left out, plus the fixes below. Coming from
1.1.0, read both entries.

### Fixed
- A 429 could carry a `retry_at_epoch` that is not a usable epoch, such as a string or an
  object. The tool then threw a `RangeError` out of `execute`. It now returns `ok: false` with
  the `abuse_throttled` message and leaves the resume time out. A numeric string such as
  `"1767225600"` is read as an epoch. A number outside the Date range made the livetennisapi
  client's own error constructor throw, which lost the abuse message. The package now repairs
  that body before the client reads it.
- Any `retry_at_epoch` made a 429 an abuse block, even one marked `rate_limited` or daily.
  Now only `abuse_throttled`, or a body that names nothing else, is read as an abuse block.
  Such an unlabelled abuse body, and a `rate_limited` body with `resets_at` but no `scope`, are
  labelled before the client reads them. The client then stops at the first 429 instead of
  retrying twice into the block.
- An API key containing a space, a line break or a control character was echoed back. fetch
  rejects such a header with an error that quotes the whole value, and the tool relayed that
  error to the model. No request is made with such a key now. The tools return `ok: false` and
  say the API key needs fixing, without repeating it.
- Text the server sends back (a reset time, a candidate name, a health version, a data field)
  could carry the API key into a result. Every string in every result now has the API key cut out.
- `check_api_status` said "Could not reach the API" with `reachable: false` when the health
  check worked but a plan probe hit a 429 or a 5xx. It now reports `reachable: true` and the
  same rate-limit message the other tools give.
- Daily-quota 429s with a non-string `resets_at` or a non-numeric `limit_per_day` printed
  `[object Object]` in the message. Those fields are now used only when they have the right type.
- An `ambiguous_name` 400 whose candidates are objects printed `[object Object]`. Candidate
  names are now read from strings or from a `name` field.
- The `ok` field description told the model that an empty result is `ok: false`. Empty lists
  have always been `ok: true`. The description now matches the code.
- `check_api_status` threw a `TypeError` out of `execute` when `/health` answered 200 with a
  body that is not JSON. It now returns `ok: false`, `reachable: false`.
- `check_api_status` never reported a FREE key as FREE. Its first probe used `status=completed`
  on `/matches`, which needs BASIC. A FREE API key got "plan check failed" or BASIC. It now reads
  the plan from `GET /usage`, which does not count against the quota. On a server without
  `/usage` it probes the history endpoint. A 403 there means FREE, and a BASIC answer carries a
  note about the 20 free history calls.
- A 403 that is not `upgrade_required`, such as a firewall's HTML page, was described as a plan gate ("requires the a higher
  plan"). It now says the request was refused and that it is not a plan limit. A plan gate with
  `free_history_taste: "used"` says the free history calls for the month are spent.
  `check_api_status` no longer reads such a 403 as a FREE key. It stops when `/usage` answers
  429 instead of probing on through the limit, and a 429 on `/health` gets the full rate-limit
  message with its do-not-retry advice.
- `get_match_events` described its events as chronological. The API returns them newest first.
- `get_archive_career`, `get_archive_match` and `get_match_statistics` copied server objects
  through by key. A missing W-L value or a stray non-numeric field broke the declared output
  schema. The AI SDK checks that schema when `validateUIMessages` reloads a saved chat, so the
  chat failed to load. Only numeric (or null) entries are kept now. Match rows read every field
  by type, so `has_analysis: "false"` is null and not "available". Each result is also parsed
  against its schema before it leaves. One the schema cannot hold becomes `ok: false` with
  `Request failed:` and the field.
- The `country` filter is lowercased before the request, since the API matches lowercase codes.

### Added
- `start_time` on fixtures: the scheduled start, UTC ISO-8601, or null until the order of play
  sets it. The fixture listing shows it in place of the date when present. `event_date` is now
  described as the date it is.
- `scheduled_time` on every match row: the scheduled start, UTC ISO-8601, or null. The
  `get_upcoming_matches` summary shows it as a `Starts:` line.
- Nine tools work on a free key. Their descriptions now end with "Works on the FREE plan (no
  card needed).", as in `livetennisapi-mcp` 1.5.0. `get_upcoming_matches` and `get_fixtures`
  say when to use them. `get_fixtures` says it filters by tour only, since tour is the only
  filter it takes. `check_api_status` says it works with no key.
- `test/errors.mjs`: every failure response a tool can meet, run against a local stub.
- `test/generate-text.mjs` uses the current mock model shapes for usage and finish reason.
  With the old ones it failed against `ai` 7.0.148, though the package itself worked.

### Changed
- Tool descriptions, field descriptions and result messages no longer use dashes or semicolons.
  Long sentences are split. The facts in them are unchanged. `livetennisapi-mcp` 1.5.0 still has
  the old wording, so the description parity check fails until the MCP server takes the same
  text. That check runs only when the server is built next to this repo.
- Listing lines in messages use `·`, `:` or `,` between fields in place of a dash. `key_factors`
  are joined with `·` and labelled "Main factors".
- The npm description now starts with "Vercel AI SDK tools for live tennis data", and the
  keywords add agents, tennis-data, tennis-scores, livetennisapi and stream-text.
- `repository` and `bugs` point at the GitLab mirror, https://gitlab.com/livetennisapi/livetennisapi-ai,
  and `homepage` at https://docs.livetennisapi.com/ai-sdk.html. The README, CONTRIBUTING and
  SECURITY no longer link to GitHub.
- `publishConfig` no longer forces `provenance`, so `npm publish` works from a workstation. The
  GitHub publish workflow no longer passes `--provenance` either: npm rejects provenance from a
  GitHub workflow when `repository` names GitLab.
- Package author is Synapse Research Ltd.
- `engines.node` is now `>=22`, the same as `ai` v7, which this package needs. The CI matrix
  runs Node 22 and 24.

## [1.2.0] (2026-09-02, not published)

### Added
- **`has_analysis` and `has_market` on every match row** (`get_live_matches`,
  `get_upcoming_matches`, `get_recent_results`, `get_match`), in parity with
  `livetennisapi-mcp` 1.5.0. Since 2026-09-02 the API answers on every row, on every plan,
  whether a model thesis or profile exists for the match. It also says whether a match-winner
  market is mapped to it. `get_match_analysis` and `get_match_odds` report the same absences
  one match at a time, so an agent can now filter the slate in one call. Booleans, `null` only
  when the server predates the field. The text summary gains one line each, only when the
  server sent the value (`Analysis: available` / `Market: mapped`, or `none`).
- `get_match_analysis` and `get_match_odds` descriptions point at the two fields, so a model
  checks the row before spending the call.
- `event_status_updated_at` on every match row (added 2026-08-19, missing from this entry
  when it was written): when the current `event_status` was recorded, UTC ISO-8601. Null while
  the status has not changed since the field was introduced. It is never backfilled.

## [1.1.0] (2026-08-07)

### Added
- **Twelve new tools** (24 total), with the same names and descriptions as
  `livetennisapi-mcp` 1.4.0:
  - `search_tournaments` / `get_tournament`: the tournament catalogue behind
    `tournament_id` (FREE).
  - `search_archive_matches`, `get_archive_match`, `search_archive_players`,
    `get_archive_career`: the 1968 to 2022 results archive. 1,485,752 matches, bios, career
    aggregates, and serve stats where the era recorded them (BASIC or any History plan).
  - `get_h2h`: all-time head-to-head across the archive and our own completed matches (BASIC
    or any History plan).
  - `get_rankings`: the full published ranking table per system (PRO).
  - `get_player_rankings`: point-in-time per-player rankings as of a date (ULTRA).
  - `get_match_statistics`: in-play statistics, with the derived and measured families kept
    apart (ULTRA).
  - `get_charting_player` / `get_charting_match`: Match Charting Project shot-level data
    (ULTRA).

  Each new tool also has an individual export for shipping a subset.
- **New list filters** on `get_live_matches`, `get_upcoming_matches` and `get_recent_results`:
  `tour` (atp, wta, challenger, itf, juniors), `player` ids (max 50), `country` (IOC-style
  3-letter code) and `from`/`to` date bounds where the endpoint supports them. `get_fixtures`
  gained `tour`.
- Match fields. Tool output now carries `tour`, `tournament_id`, `round_code`,
  `event_status` and `withdrew`. That is enough to branch settlement logic on retirements and
  walkovers.
- 429 handling. The three 429 shapes are told apart. The daily-quota message gives the
  exact `resets_at` instant. `abuse_throttled` (a block of about 24 hours for clients that
  hammer through 429s) gives the `retry_at_epoch` resume time and says to fix the retry loop.
  Ambiguous-name 400s from `get_h2h`, `get_archive_career` and `get_charting_player` relay the
  candidate list.
- `scripts/truthcheck.sh`: a CI check that pins product facts (quota grid, docs URL, org
  identity).

### Changed
- Quota grid updated to the 2026-08-06 plans. FREE 100/day, BASIC 1,000/day, PRO 10,000/day,
  ULTRA 500,000/day (30/60/300/600 per minute).
- Tour coverage is described the same way everywhere: ATP, WTA, Challenger, ITF and juniors.
- `livetennisapi` dependency raised to ^1.4.0, the client that carries the new endpoints.

## [1.0.0] (2026-08-02)

Initial release.

### Added
- **All 12 Live Tennis API tools as Vercel AI SDK tools**, mirroring the MCP server's tool set.
  A test keeps names and descriptions in parity. The 12: live matches, upcoming matches, match
  by id, match score, player search, player by id and fixtures. Then recent results, match
  events, match odds, match analysis and API status.
- `livetennisTools({ apiKey?, baseUrl? })` returns a complete tool set bound to exactly one
  key. Several tool sets with different keys can coexist in one process. Each tool is also
  exported on its own, so an app can send the model only the schemas it needs.
- **Errors are values.** Tools never throw at the model. A missing key, a plan limit (403
  `upgrade_required`), a rate limit or a not-found comes back as a plain-language result. The
  model can act on it, and it names the plan a gated endpoint needs.
- API key resolution: the `apiKey` option first, then `LIVETENNISAPI_KEY` from the
  environment. With no key at all the tools explain how to get one (free, no card, at
  <https://livetennisapi.com/subscribe/free>) instead of failing.
- `ai` v7 is a peer dependency. `livetennisapi` ^1.2.0 and `zod` are the only runtime
  dependencies.
