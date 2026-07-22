/**
 * The tools must survive a real `generateText` round trip.
 *
 * Why this is separate from tools-output.mjs
 * ------------------------------------------
 * That test calls `execute` directly, which proves the mappers and the guard
 * are right but skips everything the SDK does around them. The step this one
 * covers is the one that actually breaks in the wild: the AI SDK converts each
 * zod `inputSchema` into JSON Schema before sending it to a provider, and a
 * schema that zod accepts but cannot be converted — or converts to something a
 * provider rejects — fails only at that boundary. Calling `execute` by hand
 * would never notice.
 *
 * So this drives the whole loop against a MOCK model: assert all 12 tools reach
 * the provider as well-formed JSON Schema, then have the mock call one and
 * confirm the result comes back through the SDK rather than through us.
 *
 * Run: node test/generate-text.mjs        (no credentials, no network, no model)
 */

import { createServer } from 'node:http';

import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

const UPSTREAM_PORT = 8130;
const BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
const fail = (m) => { throw new Error(m); };

delete process.env.LIVETENNISAPI_KEY;
delete process.env.LIVETENNISAPI_BASE_URL;

const { livetennisTools } = await import('../dist/index.js');

const MATCH = {
  id: 101, tournament: 'Test Open', round: 'QF', status: 'live', surface: 'hard', indoor: false, winner: null,
  players: { p1: { id: 1, name: 'Player One' }, p2: { id: 2, name: 'Player Two' } },
  score: { sets: [1, 0], server: 1, is_tiebreak: false, win_probability_p1: 0.61, games: [[6, 4], [3, 2]] },
};

const upstream = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [MATCH], meta: { limit: 1, offset: 0, count: 1 } }));
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

const usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20 };

/** Step 1 calls the tool; step 2 answers using whatever came back. */
let sentTools = null;
const model = new MockLanguageModelV4({
  doGenerate: async (options) => {
    sentTools ??= options.tools;
    const alreadyCalled = JSON.stringify(options.prompt).includes('get_live_matches');
    if (!alreadyCalled) {
      return {
        content: [{
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'get_live_matches',
          input: JSON.stringify({ limit: 2 }),
        }],
        finishReason: 'tool-calls',
        usage,
        warnings: [],
      };
    }
    return {
      content: [{ type: 'text', text: 'Player One leads Player Two at the Test Open.' }],
      finishReason: 'stop',
      usage,
      warnings: [],
    };
  },
});

async function main() {
  const result = await generateText({
    model,
    prompt: 'What tennis is on right now?',
    tools: livetennisTools({ apiKey: 'twjp_test_key', baseUrl: BASE_URL }),
    stopWhen: stepCountIs(3),
  });

  // 1. Every tool reached the provider, converted to JSON Schema.
  if (!sentTools) fail('the model received no tools at all');
  if (sentTools.length !== 12) fail(`the model received ${sentTools.length} tools, expected 12`);
  for (const t of sentTools) {
    if (!t.name) fail(`a tool reached the provider with no name: ${JSON.stringify(t).slice(0, 120)}`);
    if (!t.description) fail(`${t.name} reached the provider with no description`);
    const schema = t.inputSchema;
    if (!schema || schema.type !== 'object') {
      fail(`${t.name} did not convert to a JSON Schema object: ${JSON.stringify(schema).slice(0, 160)}`);
    }
    // A parameter that loses its description in conversion is a parameter the
    // model has to guess at, which is how tool calls come back malformed.
    for (const [param, spec] of Object.entries(schema.properties ?? {})) {
      if (!spec.description) fail(`${t.name}.${param} lost its description converting to JSON Schema`);
    }
  }

  // 2. The tool actually ran, through the SDK, and its result came back.
  const calls = result.steps.flatMap((s) => s.toolCalls ?? []);
  if (calls.length !== 1) fail(`expected 1 tool call, got ${calls.length}`);
  if (calls[0].toolName !== 'get_live_matches') fail(`wrong tool called: ${calls[0].toolName}`);

  const results = result.steps.flatMap((s) => s.toolResults ?? []);
  if (results.length !== 1) fail(`expected 1 tool result, got ${results.length}`);
  const output = results[0].output;
  if (output.ok !== true) fail(`the tool result was not ok: ${JSON.stringify(output).slice(0, 200)}`);
  if (output.matches?.[0]?.id !== 101) {
    fail(`the stub's data did not survive the round trip: ${JSON.stringify(output).slice(0, 200)}`);
  }

  // 3. The run completed normally.
  if (!result.text.includes('Player One')) fail(`unexpected final text: ${result.text}`);

  console.log(
    'OK - generateText round trip · 12 tools converted to JSON Schema with descriptions intact · ' +
      'tool executed by the SDK · structured result returned to the model',
  );
}

main()
  .then(() => shutdown(0))
  .catch((e) => { console.error('FAIL:', e.message); shutdown(1); });

function shutdown(code) {
  upstream.closeAllConnections?.();
  upstream.close();
  process.exit(code);
}
