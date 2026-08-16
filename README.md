# livetennisapi-ai

**[Live Tennis API](https://livetennisapi.com) as [Vercel AI SDK](https://ai-sdk.dev) tools.** Give any
AI SDK model real-time tennis scores, players, fixtures, tournaments, rankings, head-to-head, the
1968–2022 results archive, market prices and model win-probability — ATP, WTA, Challenger, ITF and
juniors.

[![ci](https://github.com/livetennisapi/livetennisapi-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/livetennisapi/livetennisapi-ai/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The npm package is pending its first publication, so until it lands install
straight from GitHub:

```bash
npm install github:livetennisapi/livetennisapi-ai
```

Once the package is on npm this becomes `npm install livetennisapi-ai`.
`ai` v7 is a peer dependency — this package uses whichever copy your app already has.

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

### API key

Resolved in this order:

1. the explicit `apiKey` option — `livetennisTools({ apiKey: 'twjp_…' })`
2. `process.env.LIVETENNISAPI_KEY`

Get a free key, no card, at **https://livetennisapi.com/subscribe/free**. The underlying client
sends it as `Authorization: Bearer twjp_…`.

Prefer the explicit option when one process serves several users: each call to `livetennisTools()`
returns a tool set bound to exactly one key, sharing no state with any other, so two users can hold
two different plans in the same process.

With no key at all the tools still return normally — they answer with an explanation of how to get
one, rather than throwing. See [Errors are values](#errors-are-values).

### Picking a subset

Every tool is also exported individually. Worth doing: each tool's schema and description is sent to
the model on **every** request, so an app that only needs live scores pays for the other twenty-one
in tokens on every turn.

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
| `get_upcoming_matches` | `getUpcomingMatches` | Matches due to start soon | FREE |
| `get_match` | `getMatch` | Full detail for one match | FREE |
| `get_match_score` | `getMatchScore` | Score only — lowest latency | FREE |
| `search_players` | `searchPlayers` | Find players by name | FREE |
| `get_player` | `getPlayer` | One player's profile and ranking | FREE |
| `get_fixtures` | `getFixtures` | The forward schedule | FREE |
| `search_tournaments` | `searchTournaments` | The tournament catalogue behind `tournament_id` | FREE |
| `get_tournament` | `getTournament` | One tournament by stable id | FREE |
| `check_api_status` | `checkApiStatus` | Is the API up, and which plan is this key on | FREE |
| `get_recent_results` | `getRecentResults` | Completed matches with winners, filterable | BASIC¹ |
| `search_archive_matches` | `searchArchiveMatches` | Results archive 1968–2022 (1,485,752 matches) | BASIC¹ |
| `get_archive_match` | `getArchiveMatch` | One archive result, serve stats where recorded | BASIC¹ |
| `search_archive_players` | `searchArchivePlayers` | Archive bios: hand, DOB, career-high rank | BASIC¹ |
| `get_archive_career` | `getArchiveCareer` | Career W-L / titles / serve sums over the archive | BASIC¹ |
| `get_h2h` | `getH2H` | All-time head-to-head across both eras | BASIC¹ |
| `get_match_events` | `getMatchEvents` | Match timeline — breaks, games, momentum | PRO |
| `get_match_odds` | `getMatchOdds` | Match-winner market: bid, ask, mid | PRO |
| `get_rankings` | `getRankings` | The full published ranking table per system | PRO |
| `get_match_analysis` | `getMatchAnalysis` | Model win probability and thesis | ULTRA |
| `get_player_rankings` | `getPlayerRankings` | Point-in-time rankings for specific players | ULTRA |
| `get_match_statistics` | `getMatchStatistics` | In-play stats: derived + measured families | ULTRA |
| `get_charting_player` | `getChartingPlayer` | Career shot-level charting profile | ULTRA |
| `get_charting_match` | `getChartingMatch` | Every charting stat family for one match | ULTRA |

¹ or any History plan — History grants work even on a FREE core key.

Plans: **FREE** = live & upcoming matches, scores, players, fixtures, tournaments · **BASIC** = +
historical results, the results archive (1968–2022) and head-to-head · **PRO** = + match events,
market prices and the rankings listing · **ULTRA** = + model analysis, win probability, per-player
as-of rankings, in-play statistics, shot-level charting and the live WebSocket feed. Pricing at
https://livetennisapi.com/#pricing

`check_api_status` reports which plan your key is actually on, which is the fastest way to find out
why another tool is declining to return data.

## Rate limits

| Plan | Per minute | Per day | Price |
|---|---|---|---|
| FREE | 30 | 100 | $0 |
| BASIC | 60 | 1,000 | $9.99/mo |
| PRO | 300 | 10,000 | $29.99/mo |
| ULTRA | 600 | 500,000 | $99.99/mo |

On a free key (100/day), poll no faster than every 15 minutes. An always-on dashboard should run on
BASIC or higher.

## Errors are values

A tier wall, a rejected key, a missing key, a rate limit and an empty result **do not throw**. Each
returns a normal result carrying `ok: false` and a `message` explaining the remedy:

```ts
{
  ok: false,
  message: 'This data requires the ULTRA plan, and the configured API key is on a lower tier. …'
}
```

This is deliberate. Marking a tier wall as an error makes models retry it or abandon the task; as a
value, the model relays the upgrade path to the user — the only person who can act on it.

The three 429 shapes are told apart, because each has a different correct reaction:

- **per-minute** — wait `Retry-After` seconds and go again;
- **daily quota** — the message carries the exact `resets_at` instant the allowance returns
  (derived from the service's local midnight), so the model stops retrying into a wall;
- **`abuse_throttled`** — a ~24-hour block for clients that kept hammering through 429s. The
  message names the resume time and tells the model to fix the retry loop, not to wait it out
  request by request.

Name-keyed tools (`get_h2h`, `get_archive_career`, `get_charting_player`) refuse an ambiguous name
fragment rather than guessing — the result relays the candidate list so the model can retry with a
specific name.

Successful calls return `ok: true`, a human-readable `message`, and the structured data:

```ts
{
  ok: true,
  message: '2 live match(es): …',
  matches: [{ id: 101, tournament: 'Test Open', player1: 'Player One', score: '6-4 3-2', … }],
}
```

Every tool declares an `outputSchema` describing exactly that shape. Note that the AI SDK does not
validate tool output at runtime, so the schema is a contract this package's own test suite enforces,
not one the SDK enforces for you.

## Also available

The same 24 tools are available as an MCP server — [`livetennisapi-mcp`](https://github.com/livetennisapi/livetennisapi-mcp) —
for Claude, Cursor and other MCP clients. The underlying REST/WebSocket client is
[`livetennisapi`](https://github.com/livetennisapi/livetennisapi-js).

## Development

```bash
npm install
npm run typecheck
npm run build
npm test          # builds, then runs both suites against a local stub — no network, no key
```

`test/tools-output.mjs` drives all 24 tools twice — once with no key, once against a stub upstream —
and parses every result through the tool's own `outputSchema`. `test/generate-text.mjs` runs a full
`generateText` loop against a mock model, which is what proves the zod schemas survive conversion to
JSON Schema on the way to a provider.

## Links

- Docs: https://docs.livetennisapi.com
- Free API key: https://livetennisapi.com/subscribe/free
- Discord: https://discord.gg/f8WUZHgDm6
- GitHub org: https://github.com/livetennisapi

## License

MIT

## Affiliate program

Know developers who need tennis data? The [affiliate program](https://affiliates.livetennisapi.com/program) pays 51% recurring commission for the life of every referred subscription — 30-day cookie, and the people you refer get 10% off.
