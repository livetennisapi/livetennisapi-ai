# Contributing

## Setup

```bash
npm install
npm run typecheck
npm test            # builds, then runs all three suites. No API key, no network.
```

## Tests

All three suites run offline:

- `npm run test:tools` drives every tool's `execute` against a local stub
  upstream. It checks the mapped output and the keyless answer.
- `npm run test:errors` sends each failure response a tool can meet. That means
  the 429 shapes (malformed bodies too), 401, 403, 404 and an ambiguous name. It
  also covers empty lists, a network error and a malformed key. No tool may
  throw or echo the key.
- `npm run test:generate` runs the full `generateText` loop against a mock
  model. It proves every zod `inputSchema` survives conversion to JSON Schema at
  the SDK/provider boundary. Calling `execute` by hand never covers that step.

## Before opening a PR

```bash
npm run typecheck && npm test && npm run build
```

## Design rules

Three constraints are not up for negotiation:

1. **Errors are values.** A tool must never throw at the model. A missing key,
   a tier limit, a rate limit or a not-found comes back as a plain-language
   result the model can read and act on. It names the tier a gated endpoint
   needs.
2. **Tool names and descriptions match the MCP server**,
   [livetennisapi-mcp](https://gitlab.com/livetennisapi/livetennisapi-mcp).
   A test checks names, descriptions and parameter names when the server is
   built next to this repo, or when `LIVETENNISAPI_MCP_ENTRY` points at a
   build's `dist/index.js`. If you change a name or description here, change
   it there too.
3. **Never retry a non-429 4xx.** A bad key or an unentitled tier cannot start
   working, and retrying only burns the caller's rate limit. (Inherited from
   the underlying [`livetennisapi`](https://gitlab.com/livetennisapi/livetennisapi-js)
   client. Keep the behaviour identical.)

## Reporting a spec mismatch

If the API returns something these tools don't expect, that's the most
valuable bug report there is. Include the endpoint, the request, and the raw
response. The [OpenAPI spec](https://docs.livetennisapi.com/openapi.json) is the
source of truth. If the spec and the API disagree, the spec gets fixed.
Open issues at https://gitlab.com/livetennisapi/livetennisapi-ai/-/issues.
