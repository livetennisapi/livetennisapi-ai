# BUILD_PLAN — livetennisapi-ai

## Build target & source of truth

Build `livetennisapi-ai`: the Live Tennis API exposed as **Vercel AI SDK tools**, so it can be
listed in `content/tools-registry/registry.ts` in `vercel/ai`.

Source of truth: `/home/ben/Documents/ben-is-a-dev/livetennisapi-oss/livetennisapi-mcp/src/server.ts`
(882 lines, 12 `server.registerTool(...)` calls). Names, descriptions, zod input schemas and output
schemas are ported, not redesigned. Greenfield package, brownfield conventions.

No `PLAN.md` exists; the task brief is precise enough to serve as the approved contract (12 named
tools already validated upstream), so this file is a faithful extraction rather than a design.

## Summary

Ready to build as specified. The port is mechanical because `server.ts` already separates the three
things that matter: the zod schemas, the `matchOut`/`summarise` mappers, and the `guard()` policy
that turns a tier wall into a normal explanatory result instead of an error.

Top risks:
1. **[FACT]** AI SDK v7 `tool()` takes `inputSchema` as a *schema*, whereas MCP `registerTool` takes a
   *shape map*. Every input needs a `z.object({...})` wrapper. Mechanical, but easy to get half-right.
2. **[FACT]** `outputSchema` in AI SDK v7 is **not** validated at execute time (grep of
   `node_modules/ai/src` shows it used only in `ui/validate-ui-messages.ts:520`). So it buys
   compile-time enforcement and documentation, not the runtime tripwire MCP's version was. The test
   must therefore assert output shape itself.
3. **[FACT]** `@ai-sdk/provider-utils@5.0.12` peers `zod@^3.25.76 || ^4.1.8`. The MCP package pins
   `zod@^3.23.0`, which is *below* that floor. This package must take `zod@^3.25.76`.
4. **[JUDGMENT]** `title` exists on the AI SDK `Tool` type but is `@deprecated` in favour of
   `providerMetadata`. MCP titles are dropped rather than emitted deprecated.

Blocking open questions: none. Non-blocking ones below.

## Build units (ordered)

### [BUILD-001] Package scaffold
- **Delivers**: `package.json`, `tsconfig.json`, `tsup.config.ts`, `.gitignore`, `LICENSE`
- **Depends-on**: nothing
- **Files**: as above
- **Acceptance**: `npm install` succeeds; `ai` is a `peerDependency` (not a dependency); ESM; Node >=18
- **Output strategy**: one-shot (short config files)
- **Becomes commit**: `chore(BUILD-001): scaffold the package`

### [BUILD-002] Client context, key resolution and `guard()`
- **Delivers**: options type, `LIVETENNISAPI_KEY` resolution, `guard()` preserving the
  tier-wall-is-not-an-error contract, shared zod field defs (`okField`, `messageField`, `MatchOut`,
  `PlayerOut`, `FixtureOut`, `PriceOut`), `n()`, `matchOut()`, `summarise()`
- **Depends-on**: BUILD-001
- **Files**: `src/tools.ts` (upper half)
- **Acceptance**: `UpgradeRequired`/`Unauthorized`/`NotFound`/`RateLimited`/no-key all return a value
  with `ok:false` + an actionable `message`; only a genuine fault surfaces differently
- **Output strategy**: staged (this is the load-bearing half of a long file)
- **Becomes commit**: folded into BUILD-003 — the file does not typecheck until the tools exist

### [BUILD-003] The 12 tools
- **Delivers**: `get_live_matches`, `get_upcoming_matches`, `get_match`, `get_match_score`,
  `search_players`, `get_player`, `get_fixtures`, `get_recent_results`, `get_match_events`,
  `get_match_odds`, `get_match_analysis`, `check_api_status`
- **Depends-on**: BUILD-002
- **Files**: `src/tools.ts`
- **Acceptance**: `npm run typecheck` clean; each tool carries a description, a described input
  schema and an output schema matching the MCP `outputSchema`
- **Output strategy**: staged — outline (shared halves) then tool by tool, in `server.ts` order
- **Becomes commit**: `feat(BUILD-003): port all 12 MCP tools to AI SDK tools`

### [BUILD-004] Public surface
- **Delivers**: `livetennisTools({ apiKey })` plus 12 individually-exported tool factories and the
  option/type exports
- **Depends-on**: BUILD-003
- **Files**: `src/index.ts`
- **Acceptance**: `npm run build` clean; `dist/index.js` + `dist/index.d.ts` emitted; importing the
  built artefact yields exactly 12 tools
- **Output strategy**: one-shot
- **Becomes commit**: folded into BUILD-003 (same reason)

### [BUILD-005] Stub-upstream test
- **Delivers**: `test/tools-output.mjs` — a local stub HTTP upstream, no network, no credentials
- **Depends-on**: BUILD-004
- **Files**: `test/tools-output.mjs`
- **Acceptance**: asserts tool count === 12 and the exact name set; every tool has a description and
  described input params; the **no-key path returns `ok:false` with a message rather than throwing**;
  every tool succeeds against the stub with the structured shape its schema declares; cross-checks the
  name set against `livetennisapi-mcp/src/server.ts` when that sibling is present
- **Output strategy**: staged (mirrors `livetennisapi-mcp/test/tools-output.mjs`)
- **Becomes commit**: `test(BUILD-005): drive all 12 tools against a stub upstream`

### [BUILD-006] README
- **Delivers**: install, key resolution, full-set and subset usage, tier table, the registry entry
- **Depends-on**: BUILD-005 (documents only what passed)
- **Files**: `README.md`
- **Acceptance**: every code block matches the built export names
- **Output strategy**: one-shot
- **Becomes commit**: `docs(BUILD-006): README`

## Conventions to follow

| Convention | Cited from |
|---|---|
| ESM, `target: ES2022`, `moduleResolution: bundler`, `strict` | `livetennisapi-mcp/tsconfig.json:1-15` |
| tsup, `format: ['esm']`, `clean: true` | `livetennisapi-mcp/tsup.config.ts:3-8` |
| Header comment explaining *why the file exists*, not what it does | `livetennisapi-mcp/src/server.ts:1-24` |
| Tier wall / missing key = normal result, never an error | `livetennisapi-mcp/src/server.ts:185-241` |
| `n()` normalises `undefined` → `null`; schemas nullable, not optional | `livetennisapi-mcp/src/server.ts:129-130` |
| Shared field defs declared once so all 12 tools describe a concept identically | `livetennisapi-mcp/src/server.ts:67-127` |
| `files`, `engines.node >=18`, `publishConfig.provenance` | `livetennisapi-mcp/package.json` |
| Test asserts metadata *and* both the failure and success paths | `livetennisapi-mcp/test/tools-output.mjs:144-200` |

## Open questions & assumptions

- **[ASSUMPTION, non-blocking]** Snake_case tool keys (`get_live_matches`) are kept rather than
  camelCased. Rationale: the ported descriptions cross-reference them by name ("Pass to `get_match`"),
  so renaming the keys would make 12 descriptions lie.
- **[ASSUMPTION, non-blocking]** `baseUrl` is exposed as an option and via `LIVETENNISAPI_BASE_URL`,
  mirroring the MCP package. The stub test requires it.
- **[ASSUMPTION, non-blocking]** `zod` is a direct dependency, not a peer. AI SDK tool packages
  ship their own schemas; making it a peer would push a version constraint onto users for no gain.
- **[FACT, blocking for *submission*, not for the build]** The registry contributing guide lists
  "Published your tool package to npm" as a prerequisite. The brief forbids publishing. The registry
  entry can be drafted now but cannot be submitted until the package is published.

## Handoff

Build, then `/full-review`. Most relevant personas for this work:
`/code-logic-review` (the 12 mappers and the guard's branch table), `/dependency-audit` (peer vs
direct dependency correctness, zod floor), `/documentation-audit` (README vs built exports).
