# livetennisapi-ai

**[Live Tennis API](https://livetennisapi.com) as [Vercel AI SDK](https://ai-sdk.dev) tools.** Give any
AI SDK model real-time tennis scores, players, fixtures, market prices and model win-probability —
ATP, WTA, Challenger and ITF.

```bash
npm install livetennisapi-ai
```

`ai` v7 is a peer dependency — this package uses whichever copy your app already has.

## Usage

```ts
import { generateText, gateway, isStepCount } from 'ai';
import { livetennisTools } from 'livetennisapi-ai';

const { text } = await generateText({
  model: gateway('openai/gpt-5-mini'),
  prompt: 'Which tennis matches are live right now, and who does the model favour?',
  tools: livetennisTools({ apiKey: process.env.LIVETENNISAPI_KEY }),
  stopWhen: isStepCount(3),
});

console.log(text);
```

### API key

Resolved in this order:

1. the explicit `apiKey` option — `livetennisTools({ apiKey: '…' })`
2. `process.env.LIVETENNISAPI_KEY`

Get a free key, no card, at **https://livetennisapi.com/subscribe/free**.

Prefer the explicit option when one process serves several users: each call to `livetennisTools()`
returns a tool set bound to exactly one key, sharing no state with any other, so two users can hold
two different plans in the same process.

With no key at all the tools still return normally — they answer with an explanation of how to get
one, rather than throwing. See [Errors are values](#errors-are-values).

### Picking a subset

Every tool is also exported individually. Worth doing: each tool's schema and description is sent to
the model on **every** request, so an app that only needs live scores pays for the other nine in
tokens on every turn.

```ts
import { getLiveMatches, getMatchScore } from 'livetennisapi-ai';

const tools = {
  get_live_matches: getLiveMatches({ apiKey }),
  get_match_score: getMatchScore({ apiKey }),
};
```

## The 12 tools

| Tool | Individual export | Does | Plan |
|---|---|---|---|
| `get_live_matches` | `getLiveMatches` | Matches in progress, with live scores | FREE |
| `get_upcoming_matches` | `getUpcomingMatches` | Matches due to start soon | FREE |
| `get_match` | `getMatch` | Full detail for one match | FREE |
| `get_match_score` | `getMatchScore` | Score only — lowest latency | FREE |
| `search_players` | `searchPlayers` | Find players by name | FREE |
| `get_player` | `getPlayer` | One player's profile and ranking | FREE |
| `get_fixtures` | `getFixtures` | The forward schedule | FREE |
| `check_api_status` | `checkApiStatus` | Is the API up, and which plan is this key on | FREE |
| `get_recent_results` | `getRecentResults` | Completed matches with winners | BASIC |
| `get_match_events` | `getMatchEvents` | Match timeline — breaks, games, momentum | PRO |
| `get_match_odds` | `getMatchOdds` | Match-winner market: bid, ask, mid | PRO |
| `get_match_analysis` | `getMatchAnalysis` | Model win probability and thesis | ULTRA |

Plans: **FREE** = live & upcoming matches, scores, players, fixtures · **BASIC** = + historical
results · **PRO** = + match events and market prices · **ULTRA** = + model analysis, win probability
and the live WebSocket feed. Pricing at https://livetennisapi.com/#pricing

`check_api_status` reports which plan your key is actually on, which is the fastest way to find out
why another tool is declining to return data.

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

The same 12 tools are available as an MCP server — [`livetennisapi-mcp`](https://github.com/livetennisapi/livetennisapi-mcp) —
for Claude, Cursor and other MCP clients. The underlying REST/WebSocket client is
[`livetennisapi`](https://github.com/livetennisapi/livetennisapi-js).

## Development

```bash
npm install
npm run typecheck
npm run build
npm test          # builds, then runs both suites against a local stub — no network, no key
```

`test/tools-output.mjs` drives all 12 tools twice — once with no key, once against a stub upstream —
and parses every result through the tool's own `outputSchema`. `test/generate-text.mjs` runs a full
`generateText` loop against a mock model, which is what proves the zod schemas survive conversion to
JSON Schema on the way to a provider.

## License

MIT
