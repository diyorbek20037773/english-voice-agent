# Verification log

All dates 2026-10-13. "REAL" = executed against the real OpenAI API with the owner's key.
"MOCKED" = deterministic local mock. Nothing below was run on Railway or on a phone yet.

## Environment

- Owner's laptop: Windows 11 Pro, Node v22.17.0, Docker Desktop 29.7.2, Chrome (Claude in Chrome).
- Server: production build (`dist/server/index.js`) running locally on port 3000.
- Models: Quick `gpt-6-luna` (reasoning none), Detailed `gpt-6-luna` (reasoning low),
  transcription `gpt-live-transcribe`.

## REAL checks

| Check | Result |
|---|---|
| Model availability (`GET /v1/models` via `/api/models/check`) | `gpt-6-luna`, `gpt-6.1-sol`, `gpt-live-transcribe` all available to the project |
| Ephemeral token (`POST /api/realtime/session` → `/v1/realtime/client_secrets`) | HTTP 200, `ek_` token, expires in 60 s, `Cache-Control: no-store`, 440–908 ms |
| Unauthenticated `/api/realtime/session` | 401 |
| WebRTC transcription, no browser (`tools/webrtc-check`, aiortc + Windows TTS WAV) | SDP `POST /v1/realtime/calls` → 201; data channel open; live deltas word-by-word; first partial **0.47 s** after audio start; `input_audio_buffer.committed` with the same `item_id`; final transcript **0.70 s** after commit; transcript exact: "What is the difference between a process and a thread in an operating system?" |
| Streaming answers | 43 answers, all `answer.done`; progressive deltas (e.g. 69 deltas for a 267-char answer) |
| Follow-up context | follow-up question answered in context (first text 1.2 s) |
| Detailed mode | first text 1.2–2.0 s, full 4.9–7.8 s, ~1450–2430 chars, not truncated |
| Logs | contain no API key and no ephemeral token (searched) |
| Cost | 43 answers: 8,739 input + 5,096 output tokens ≈ **$0.0034** (from `usage`) |

### Latency — 20 representative Quick questions (REAL)

Client: Node fetch on the owner's laptop → local server → OpenAI. Measures *answer request → first
answer text received*; excludes speech, browser rendering and Railway. Result file:
`docs/results/smoke-localhost-2026-10-13-10-55.json`.

| Metric | p50 | p95 |
|---|---|---|
| Answer request → first text | **901 ms** | **1,353 ms** |
| Answer request → full answer | 2,323 ms | 2,694 ms |
| Server: OpenAI response headers (41 samples, both runs) | 606 ms | 1,149 ms |
| Server: first text from OpenAI (41 samples) | 1,042 ms | 1,428 ms |

Misses of the 3 s first-text target: **0 / 20**. For comparison, the earlier n8n-based path measured
2.4–2.8 s to first text (single samples) before n8n was removed.

End-to-end voice latency (end of speech → first answer text) ≈ commit→final (~0.7 s) + answer first
text (~0.9 s) + Auto-mode silence threshold (0.8 s) — **estimated, not yet measured on a phone**.

## MOCKED / local checks

| Check | Result |
|---|---|
| `pnpm check` (typecheck web + node, 64 tests, build, secret scan) | pass |
| Automated tests | 64/64 pass (see docs/testing.md for coverage) |
| Production build | web 258 kB JS (81 kB gzip), server bundle 45 kB |
| Docker image | builds; runs as `node`; `/healthz` ok; Docker HEALTHCHECK healthy; no secret-like strings in `/app`; idle memory ~42 MB |
| Browser UI (desktop Chrome, MOCKED OpenAI, throwaway token) | unlock, typed question streaming, code block + Copy, Detailed toggle, insufficient-credit error card, Settings panel; no console errors. Found and fixed: first-text timing used requestAnimationFrame (paused in background tabs) |
| Secret scan | no secrets in `dist/web` or committable files |
| `.railway/railway.ts` | type-checks against `railway@3.15.0`; never applied |
| Monochrome chat UI (update, desktop Chrome, MOCKED OpenAI) | empty state, chronological thread with question bubbles, streamed answer with code block, Copy, error note, Settings, Mic/Laptop/Both selector shown on desktop; found and fixed: newest answer hidden behind the sticky dock (now scrolls to page bottom) |
| Automated tests (update) | 66/66 pass (adds laptop-audio capability detection and `display-capture` permission header) |

## Not verified yet (needs owner access or a device)

- Railway deployment (no Railway login available to me): domain, healthcheck, region latency.
- Real iPhone Safari microphone capture, Pause/Stop mic indicator, background interruption
  (checklist: docs/manual-iphone-test.md). Android Chrome likewise.
- Real browser microphone in desktop Chrome (WebRTC path verified with aiortc, not a browser).
- Laptop audio capture (`getDisplayMedia` tab/system audio) and Both mixing: implemented and
  type-checked, but the browser share picker cannot be automated here — needs the owner's run
  (checklist section E).
- Auto-mode silence threshold tuning with real speech; end-of-speech → first answer on a phone.
- Whether aborting a streaming request stops OpenAI billing for already-generated tokens.

## Owner device tests

(Fill in from docs/manual-iphone-test.md.)

## Railway "Healthcheck failed" (2026-10-13)

Owner's build log: build OK, then `/healthz` "service unavailable" for 5 minutes → the process never
started listening. Reproduced locally (Docker, same image): with the variable misspelled as
`ALLOWED_ORGN`, a single-quoted value, or no generated domain, config validation exited with code 1
before listening. Fix: values are normalized (quotes/whitespace/CR stripped, empty = unset),
`ALLOWED_ORIGIN` defaults to `https://$RAILWAY_PUBLIC_DOMAIN` (Railway-provided, per
docs.railway.com/reference/variables), misspelled names are reported with a "did you mean" hint, and
the Railway env generator no longer quotes values or emits `ALLOWED_ORIGIN`. Verified in Docker: the
owner's exact variable set + a domain now starts and answers `/healthz` over IPv4 and IPv6; without a
domain it exits with an actionable hint. Not yet confirmed on Railway itself.

## Railway production (REAL, 2026-10-14)

Service `english-voice-agent` in project `gallant-flexibility`, region **us-west2**, 1 replica,
sleep off, healthcheck `/healthz`. URL: https://english-voice-agent-production.up.railway.app

Root cause of the failed deploys (read with `railway logs --deployment`): `HOST` was stored as
`": :"` → `getaddrinfo ENOTFOUND : :` on listen; `ALLOWED_ORIGIN` was stored with literal quotes
(Railway keeps quotes). Fixed by deleting both variables (defaults `::` and
`https://$RAILWAY_PUBLIC_DOMAIN` are correct) and by normalizing env values in code (commit 3594446).
Deployment 41e1516c → SUCCESS; startup log clean.

| Check (client: owner's laptop, Node fetch) | Result |
|---|---|
| `/healthz`, `/` | 200; CSP, HSTS, Permissions-Policy, X-Frame-Options present |
| Unauthenticated realtime session / wrong token / cross-origin POST | 401 / 401 / 403 |
| Model access | gpt-6-luna, gpt-live-transcribe available |
| Ephemeral token via Railway | HTTP 200 in 1.1 s, `ek_`, 60 s, no-store |
| WebRTC transcription with the Railway-issued token (aiortc + TTS) | SDP 201; first partial 0.44 s; final 0.86 s after commit; transcript exact |
| 20 Quick questions: request → first text | **p50 1,108 ms, p95 2,171 ms**; 1/20 over 3 s (4,641 ms) |
| 20 Quick questions: request → full answer | p50 2,121 ms, p95 3,490 ms |
| Server side (22 answers): OpenAI headers / first text / total | p50 414 / 852 / 1,828 ms; p95 1,487 / 2,539 / 3,936 ms |
| Network laptop → Railway | TCP connect ~0.15–0.22 s; `/healthz` round trip 0.63–0.83 s (incl. TLS) |

The first answers after deploy were slower (2.8–3.4 s to first text). Result file:
`docs/results/smoke-english-voice-agent-production-up-railway-app-2026-10-14-02-42.json`.
Region note: the service runs in US West, not EU West. Audio goes phone→OpenAI directly, so the
region only affects the answer request; with p50 1.1 s already under the 3 s target, no migration was
done. An EU West comparison remains optional.

## Long-session reconnect (2026-10-14, MOCKED browser APIs)

`tests/reconnect.test.ts` drives the real `RealtimeTranscriber` with fake RTCPeerConnection /
MediaStream / AudioContext: a server-closed session reconnects automatically with a new token and the
microphone track is never stopped; at 55 minutes it commits pending audio, keeps the final text and
rotates; Stop releases the microphone. Not yet exercised against OpenAI's real 60-minute cutoff.

## Photo tasks (REAL, production, 2026-10-14)

A rendered screenshot of "Longest Substring Without Repeating Characters" sent to /api/answer
(kind image, gpt-6-luna vision, detail high): correct restatement, sliding-window solution in Python,
edge cases, O(n) time; first text 2.7 s, full answer 5.0 s. MOCKED tests cover the request shape
(input_text + input_image), the 8 MB route limit (other routes stay at 32 KB) and rejection of
non-image or URL inputs. Phone camera capture itself is not yet tested on a device.

## Log review (2026-10-15, production)

Runtime logs of deployment 299d4234 (owner usage, 25 answers): no warnings/errors, no restarts,
24 done + 1 cancelled. Server first text p50 1.7 s, p95 6.9 s; the slow tail came from OpenAI (headers
in ~0.5 s, first text after 6.9-8.7 s, reasoning none). Bots probed ~40 config paths; `/.env`,
`/public/.env`, `/.git/config` returned 200 with the SPA index.html (721 B, no secrets) — now 404.
A/B from the laptop direct to OpenAI (12 each, our real prompt): standard TTFT p50 858 / max 2609 ms,
Fast mode p50 1030 / max 1403 ms. Production now uses OPENAI_SERVICE_TIER=fast (logged per answer as
serviceTier); first checks: first text 0.6-0.9 s server-side. The firstPartialMs metric was inflated
for questions merged with held context and is fixed.
