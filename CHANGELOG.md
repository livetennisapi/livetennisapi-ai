# Changelog

All notable changes are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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
