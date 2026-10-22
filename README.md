# livetennisapi-ai

To give a [Vercel AI SDK](https://ai-sdk.dev) agent live tennis data, install `livetennisapi-ai`
and pass `livetennisTools()` as the `tools` of `generateText` or `streamText`. The model then gets
24 tools backed by [Live Tennis API](https://livetennisapi.com). They cover live scores, upcoming
matches, players, fixtures, tournaments, rankings and head-to-head. They also reach the 1968 to
2022 results archive, market prices and model win probability. Tours: ATP, WTA, Challenger, ITF
and juniors. A free key
(100 requests a day, no card) runs the live tools.

[![npm](https://img.shields.io/npm/v/livetennisapi-ai.svg)](https://www.npmjs.com/package/livetennisapi-ai)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

```bash
npm install livetennisapi-ai ai
```

`ai` v7 is a peer dependency, so the tools use the copy of the AI SDK your app already has. Like
`ai` v7, the package needs Node 22 or later.

## Usage

```ts
import { generateText, gateway, isStepCount } from 'ai';
import { livetennisTools } from 'livetennisapi-ai';

const { text } = await generateText({
  model: gateway('openai/gpt-5-mini'),
  prompt: 'Which tennis matches are live right now, and who does the model favour?',
  tools: livetennisTools({ apiKey: process.env.LIVETENNISAPI_KEY }), // twjp_...
  stopWhen: isStepCount(3),
});

console.log(text);
```

The full guide is at https://docs.livetennisapi.com/ai-sdk.html.

### API key

The key is read in this order:

1. the `apiKey` option, as in `livetennisTools({ apiKey: 'twjp_...' })`
2. `process.env.LIVETENNISAPI_KEY`

Get a free key, no card, at **https://livetennisapi.com/subscribe/free**. The underlying client
sends it as `Authorization: Bearer twjp_...`.

Pass the API key yourself when one process serves several users. Each call to `livetennisTools()`
returns a tool set bound to one key and shares no state with any other set. Two users on two
different plans can use the same process.

With no API key the tools still answer. Each one returns `ok: false` and a message saying how to get
a key. `check_api_status` is the one exception: it still checks the API and returns `ok: true`.
See [Errors are values](#errors-are-values).

### Picking a subset

Every tool is also exported on its own. Each tool's schema and description goes to the model on
**every** request. An app that only needs live scores pays tokens for the other 22 on every turn.

```ts
import { getLiveMatches, getMatchScore } from 'livetennisapi-ai';

const tools = {
  get_live_matches: getLiveMatches({ apiKey }),
  get_match_score: getMatchScore({ apiKey }),
};
```

## The 24 tools

| Tool | Individual export | Does | Plan |
|---|---|---|---|
| `get_live_matches` | `getLiveMatches` | Matches in progress, with live scores | FREE |
| `get_upcoming_matches` | `getUpcomingMatches` | Matches due to start soon, with start times | FREE |
| `get_match` | `getMatch` | Full detail for one match | FREE |
| `get_match_score` | `getMatchScore` | The score only, lowest latency | FREE |
| `search_players` | `searchPlayers` | Find players by name | FREE |
| `get_player` | `getPlayer` | One player's profile and ranking | FREE |
| `get_fixtures` | `getFixtures` | The forward schedule | FREE |
| `search_tournaments` | `searchTournaments` | The tournament catalogue behind `tournament_id` | FREE |
| `get_tournament` | `getTournament` | One tournament by stable id | FREE |
| `check_api_status` | `checkApiStatus` | Is the API up, and which plan is this key on | FREE |
| `get_recent_results` | `getRecentResults` | Completed matches with winners, filterable | BASIC¹ |
| `search_archive_matches` | `searchArchiveMatches` | Results archive 1968 to 2022 (1,485,752 matches) | BASIC¹ |
| `get_archive_match` | `getArchiveMatch` | One archive result, serve stats where recorded | BASIC¹ |
| `search_archive_players` | `searchArchivePlayers` | Archive bios: hand, date of birth, career-high rank | BASIC¹ |
| `get_archive_career` | `getArchiveCareer` | Career W-L, titles and serve sums over the archive | BASIC¹ |
| `get_h2h` | `getH2H` | All-time head-to-head across both eras | BASIC¹ |
| `get_match_events` | `getMatchEvents` | Match timeline: breaks, games, momentum | PRO |
| `get_match_odds` | `getMatchOdds` | Match-winner market: bid, ask, mid | PRO |
| `get_rankings` | `getRankings` | The full published ranking table per system | PRO |
| `get_match_analysis` | `getMatchAnalysis` | Model win probability and thesis | ULTRA |
| `get_player_rankings` | `getPlayerRankings` | Point-in-time rankings for specific players | ULTRA |
| `get_match_statistics` | `getMatchStatistics` | In-play stats, derived and measured | ULTRA |
| `get_charting_player` | `getChartingPlayer` | Career shot-level charting profile | ULTRA |
| `get_charting_match` | `getChartingMatch` | Every charting stat family for one match | ULTRA |

¹ Or any History plan. A History plan works even with a FREE core key.

FREE has live and upcoming matches, scores, players, fixtures and tournaments. BASIC adds
historical results, the results archive (1968 to 2022) and head-to-head. PRO adds match events,
market prices and the rankings listing. ULTRA adds model analysis, win probability, per-player
as-of rankings, in-play statistics, shot-level charting and the live WebSocket feed.

Prices are at https://livetennisapi.com/#pricing. `check_api_status` tells you which plan your
key is on. Start there when another tool declines to return data.

## Rate limits

| Plan | Per minute | Per day | Price |
|---|---|---|---|
| FREE | 30 | 100 | $0 |
| BASIC | 60 | 1,000 | $9.99/mo |
| PRO | 300 | 10,000 | $29.99/mo |
| ULTRA | 600 | 500,000 | $99.99/mo |

On a free key (100/day), poll no more often than every 15 minutes. An always-on dashboard needs
BASIC or higher.

## Errors are values

A tool's `execute` does not throw. Every result has `ok` and a `message` the model can pass to
the user as it is.

`ok: true` means the request worked, and that includes an empty answer. A list tool returns
its list empty (`matches: []`, `players: []`) with a message such as "No matches are live right
now." These answers are also `ok: true`:

- `get_h2h` with `players: null` when no player matches the names.
- `get_match_statistics` with `players: null` when the match has no statistics yet.
- A single-item tool with no data field, when the API answered with nothing.

`ok: false` comes with a message that says what to do. It covers these cases:

| Case | What the message says |
|---|---|
| No API key | How to pass one, and where to get a free key |
| Key with a space, line break or control character | That no request was made and the API key needs fixing. The API key is not repeated. |
| API key rejected (401) | Check the API key |
| Plan gate (403 `upgrade_required`) | Which plan the data needs, plus the plan list. It also says when a FREE API key has used its 20 free history calls for the month. |
| Any other 403, such as a firewall page | That the request was refused and it is not a plan limit |
| Unknown id, or no data for it (404) | No data found for that request |
| Ambiguous name (400) | The candidate names, so the model can retry with one |
| Rate limit (429) | One of the three shapes below |
| Network error, timeout, 5xx, or anything else | `Request failed:` and the reason, with the API key cut out |
| An answer the tool's `outputSchema` cannot hold | `Request failed:` and the field that was wrong |

`check_api_status` works differently, because its job is to diagnose. It returns `ok: true`
whenever the API answered its health check:

- With no API key, it reports `has_key: false`.
- With a rejected or malformed API key, it reports `tier: null` and says what is wrong.
- Otherwise it reads the plan from `GET /usage`, which does not count against the quota. On a
  server without that endpoint it probes the history, events and analysis endpoints instead.

It returns `ok: false` and `reachable: false` when the health check fails or does not answer
with JSON. Sometimes the health check works but the plan check hits a rate limit or a server
error. Then it returns `ok: false` and `reachable: true`, with the message any other tool would
give.

A plan gate as an error makes a model retry or give up. As a value, the model passes the upgrade
path to the user, who is the only one who can act on it:

```ts
{
  ok: false,
  message: 'This data requires the ULTRA plan, and the configured API key is on a lower tier. ...'
}
```

The three 429 shapes need different reactions, so the messages tell them apart:

1. Per minute. The client has already retried, honouring `Retry-After`. The message gives the
   wait in seconds when the API sent one.
2. Daily quota. The message gives the exact `resets_at` instant from the response. It follows
   the service's local midnight. Retrying before then cannot work.
3. `abuse_throttled`. A block of about 24 hours for clients that kept sending requests through
   429s. The message says not to retry and to fix the retry loop. It gives the resume time when
   the response has a valid `retry_at_epoch`. When that value is missing or malformed, the
   message leaves the time out.

A successful call returns `ok: true`, a readable `message` and the structured data:

```ts
{
  ok: true,
  message: '2 live match(es): ...',
  matches: [{ id: 101, tournament: 'Test Open', player1: 'Player One', score: '6-4 3-2', ... }],
}
```

Every tool declares an `outputSchema` for that shape. The AI SDK does not check a result
against it when the tool runs, only when an app reloads a saved chat with
`validateUIMessages`. This package's tests parse every result with it.

## Also available

The same 24 tools run as an MCP server for Claude, Cursor and other MCP clients:
[`livetennisapi-mcp`](https://www.npmjs.com/package/livetennisapi-mcp). The REST and WebSocket
client underneath is [`livetennisapi`](https://www.npmjs.com/package/livetennisapi).

## Development

```bash
npm install
npm run typecheck
npm test          # builds, then runs three suites against a local stub. No network, no key.
```

`test/tools-output.mjs` runs all 24 tools twice, once with no key and once against a stub
upstream. It parses every result with the tool's own `outputSchema`. `test/errors.mjs` sends
the failure responses: each 429 shape (malformed bodies included), 401, 403, 404, an ambiguous
name, empty lists, a network error and a malformed key. `test/generate-text.mjs` runs a full
`generateText` loop against a mock model. That proves the zod schemas survive conversion to
JSON Schema on the way to a provider.

## Links

- npm: https://www.npmjs.com/package/livetennisapi-ai
- Guide: https://docs.livetennisapi.com/ai-sdk.html
- API docs: https://docs.livetennisapi.com
- Source and issues: https://gitlab.com/livetennisapi/livetennisapi-ai
- Live Tennis API: https://livetennisapi.com
- Free API key: https://livetennisapi.com/subscribe/free
- Discord: https://discord.gg/f8WUZHgDm6

## License

MIT

## Affiliate program

Know developers who need tennis data? The [affiliate program](https://affiliates.livetennisapi.com/program)
pays 51% recurring commission for the life of every referred subscription. The cookie lasts 30
days, and the people you refer get 10% off.
