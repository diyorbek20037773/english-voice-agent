# Testing

| Level | Command | Cost | Talks to |
|---|---|---|---|
| Typecheck + unit + integration + build + secret scan | `pnpm check` | free | MOCK OpenAI only |
| Unit/integration tests only | `pnpm test` | free | MOCK OpenAI only |
| Real smoke test | `pnpm smoke:real` | < $0.001 | real OpenAI via a running server |
| Real latency run (20 Quick questions) | `pnpm smoke:real --latency 20` | < $0.01 | real OpenAI |
| Real WebRTC transcription (no browser) | see `tools/webrtc-check/README.md` | < $0.01 | real OpenAI Realtime |
| Phone | `docs/manual-iphone-test.md` | ~$0.20 | real everything |

Mocked tests prove our logic (parsing, dedup, supersede, errors, security); they do **not** prove
real OpenAI behavior or latency. Real tests are labeled as such in `docs/verification.md`.

## Automated tests (vitest, 64 tests)

- `tests/streams.test.ts` — OpenAI Responses SSE adapter: every possible byte split including inside
  multi-byte UTF-8 (Cyrillic, emoji, CJK), one-byte chunks, `response.completed` / `.incomplete` /
  `.failed` / `error`, unterminated final event, malformed lines; our SSE encoder/parser with CRLF.
- `tests/voice.test.ts` — transcript reconciliation (partial→final, out-of-order finals, ordering by
  `previous_item_id`, per-`content_index`), turn commits (no commit on silence, never twice, wait for
  all finals, timeout returns editable partial, server "commit empty"), VAD (calibration, silence
  threshold, noise and clicks ignored), complete-question heuristic.
- `tests/units.test.ts` — Markdown parsing (no HTML), request building (documented params only, no
  temperature, budgets, reasoning omitted for unknown models, profile only for personal questions,
  bounded history, delimiter injection neutralized), transcription session body, error mapping, key
  scrubbing, config validation (no secret values in errors), Tashkent midnight.
- `tests/api.test.ts` — real HTTP server + MOCK OpenAI: unauthenticated rejection, forged/tampered
  cookies, cross-origin and no-origin POST rejected, text/plain rejected, ephemeral token no-store and
  never logged, normalized stream ids, Unicode intact, duplicate replay without a second OpenAI call,
  in-progress duplicate 409, supersede, quota/rate/model errors, mid-stream drop and
  `response.failed`, single retry on 5xx, truncation + Continue, follow-up context, input validation,
  daily limit, login rate limit, CSP/Permissions-Policy on the SPA, model check.
- `tests/client-stream.test.ts` — browser stream reader drops stale question/request ids, detects an
  unterminated stream, surfaces JSON errors.

## Mock OpenAI

`mock-openai/server.mjs` (also `pnpm mock:openai`, port 4010). Magic words in the question:
`QUOTA_TEST`, `RATE_TEST`, `FAIL_TEST`, `DROP_TEST`, `LONG_TEST`, `SLOW_TEST`, `UNICODE_TEST`,
`CODE_TEST`, `SERVER_ERROR_ONCE`. Point a server at it with `OPENAI_BASE_URL=http://127.0.0.1:4010/v1`
and any `sk-test-…` key.

## Secret scan

`pnpm secrets:scan` checks `dist/web` and every file git would commit for the exact values of
`OPENAI_API_KEY`/`APP_ACCESS_TOKEN` from `.env` and `railway-variables/web.env`, and for key-shaped
strings. It prints file names only.
