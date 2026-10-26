# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Email **security@livetennisapi.com**.

Please include what you found, how to reproduce it, and what an attacker could do
with it. We'll acknowledge within 72 hours and keep you updated until it's fixed.

## Scope

In scope: the client libraries and tooling published by this organisation, and the
`api.livetennisapi.com` service.

Out of scope: findings that need a compromised machine or a leaked API key you
already control. Also out: rate-limit exhaustion of your own key, and scanner
reports without a demonstrated impact.

## Handling your API key

Keys look like `twjp_…` and are bearer credentials. Anyone holding one can spend
your plan's quota.

- Keep keys in environment variables, never in source control.
- This package reads `LIVETENNISAPI_KEY` from the environment (or takes an
  explicit `apiKey` option) and never logs it. It sends the key only to the API
  origin: `api.livetennisapi.com`, or the origin you set with the `baseUrl`
  option or `LIVETENNISAPI_BASE_URL`. Point those only at a server you trust
  with the key.
- Tool results never include the key, so it cannot leak into a model
  conversation or provider logs. Every string in a result is checked, even
  text the server sent back. Some keys cannot be sent in
  an HTTP header, such as one with a space or a line break inside it. Those are
  refused before any request, because fetch would quote them in its error.
- If a key is exposed, rotate it at <https://livetennisapi.com>.
