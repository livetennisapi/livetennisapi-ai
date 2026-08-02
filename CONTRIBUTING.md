# Contributing

## Setup

```bash
npm install
npm run typecheck
npm test            # builds, then runs both suites — no API key, no network
```

## Tests

Both suites run offline:

- `npm run test:tools` — drives every tool's `execute` against a local stub
  upstream and asserts the mapped output, the keyless answer, and the friendly
  tier/rate-limit messages.
- `npm run test:generate` — runs the full `generateText` loop against a mock
  model, proving every zod `inputSchema` survives conversion to JSON Schema at
  the SDK/provider boundary — the step calling `execute` by hand never covers.

## Before opening a PR

```bash
npm run typecheck && npm test && npm run build
```

## Design rules

Three constraints are not up for negotiation:

1. **Errors are values.** A tool must never throw at the model. A missing key,
   a tier limit, a rate limit or a not-found comes back as a plain-language
   result the model can read and act on — including which tier unlocks a
   gated endpoint.
2. **Tool names and descriptions stay in parity with the MCP server**
   ([livetennisapi-mcp](https://github.com/livetennisapi/livetennisapi-mcp)).
   A test enforces this; if you change a name or description here, change it
   there too.
3. **Never retry a non-429 4xx.** A bad key or an unentitled tier cannot start
   working, and retrying only burns the caller's rate limit. (Inherited from
   the underlying [`livetennisapi`](https://github.com/livetennisapi/livetennisapi-js)
   client — keep behaviour identical.)

## Reporting a spec mismatch

If the API returns something these tools don't expect, that's the most
valuable bug report there is. Include the endpoint, the request, and the raw
response. The [spec](https://github.com/livetennisapi/openapi) is the source
of truth; if the spec and the API disagree, the spec gets fixed.
