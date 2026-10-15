# CLAUDE.md — English Voice Agent

Personal English interview-practice assistant for one owner. Phone web app: live English
transcription of the owner's voice + streamed English technical answers.

## Architecture (current — n8n was removed on 2026-10-13)

One Railway service (`web`) = React/Vite frontend + Fastify backend in one container. No database.

```
Audio:   phone mic ──WebRTC──▶ OpenAI Realtime (gpt-live-transcribe) ──data channel──▶ browser transcript
Token:   browser ─POST /api/realtime/session─▶ backend ─POST /v1/realtime/client_secrets─▶ OpenAI (ephemeral ek_ token, 60 s)
Answer:  browser ─POST /api/answer─▶ backend ─POST /v1/responses (stream)─▶ OpenAI ─SSE─▶ backend ─SSE─▶ browser
```

- Audio sources (web/src/voice/transcriber.ts): Mic (getUserMedia), Laptop (getDisplayMedia tab/system
  audio, desktop Chrome/Edge), Both (Web Audio mix). UI is monochrome chat-style (white/black only).
- Audio never touches the backend. The permanent `OPENAI_API_KEY` never leaves the backend.
- `gpt-live-transcribe` has no server VAD: `turn_detection: null`; the browser commits turns with
  `input_audio_buffer.commit` after the energy VAD silence threshold. Answering is always automatic
  (no Answer button, owner request 2026-10-14): `web/src/voice/question.ts` answers questions/interview
  prompts, keeps other sentences as context for the next question, ignores fillers.
- Browser-facing stream events: `answer.delta`, `answer.done`, `answer.error` (shared/stream-events.ts).
- In-memory state (server/src/state.ts): practice sessions, follow-up turns (last 3 sent), dedup by
  session+questionId, one active answer per session (newer supersedes), daily counter, timing samples.
  Single replica only. Lost on restart (frontend recreates the session automatically).
- Access: production runs with `OPEN_ACCESS=true` (owner request 2026-10-14: no unlock screen; budget
  guards: ANSWER_DAILY_LIMIT, VOICE_SESSIONS_PER_DAY, per-IP rate limits, noindex). Without it,
  `APP_ACCESS_TOKEN` unlocks a device → stateless HMAC-signed HttpOnly/Secure/SameSite=Strict
  cookie (key derived from the token; rotating the token logs out all devices). Origin check on all
  state-changing /api requests; text/plain bodies rejected; strict CSP (connect-src self + api.openai.com).

## Layout

- `server/src/` — config.ts (env contract), auth.ts, security.ts, state.ts, openai/ (client + Responses SSE
  adapter), answer/ (context builder, errors, streaming service), routes/api.ts, app.ts, index.ts
- `web/src/` — Practice.tsx (main screen), voice/ (transcriber.ts WebRTC, transcript-store.ts, turns.ts, vad.ts,
  question.ts), api/, components/
- `shared/` — SSE encoder/parser, stream event contract, API types, model catalog
- `mock-openai/server.mjs` — deterministic MOCK OpenAI used by tests (never production)
- `tests/` — vitest (unit + backend integration against the mock)
- `scripts/` — setup-secrets.ts, smoke-real.ts (REAL API, costs cents), secrets-scan.ts, build-server.mjs, dev.mjs
- `tools/webrtc-check/` — optional Python/aiortc real WebRTC transcription check
- `.railway/railway.ts` — optional IaC (type-checked against railway@3.15.0, never applied by us)
- `docs/` — architecture.md, railway-setup.md (Uzbek), manual-iphone-test.md (Uzbek), verification.md, testing.md

## Commands (pnpm via `corepack pnpm@10.34.6 …` or a global `npm i -g pnpm@10`)

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Secrets/env files | `pnpm setup:secrets --openai-key-file <file with sk-…>` |
| Dev (Vite 5173 + API 3000) | `pnpm dev` |
| Everything (typecheck, tests, build, secret scan) | `pnpm check` |
| Production build / run locally | `pnpm build` then `pnpm start:local` (set `ALLOWED_ORIGIN=http://localhost:3000`) |
| Real smoke + latency (costs < $0.01) | `pnpm smoke:real --latency 20` (server must be running) |
| Mock OpenAI standalone | `pnpm mock:openai` |

## Secrets rules (do not break)

- Real values live only in gitignored files: `.env`, `railway-variables/web.env`, `docs/apikey.md` (owner's
  file), `secrets/`. Never print, log, commit, put in URLs/command args/VITE_* vars/browser storage.
- Scripts print variable names and status only. `pnpm secrets:scan` must pass before every commit.
- Logs are timing-only (no question/answer text); cookies/authorization are redacted; ephemeral tokens
  are never logged.
- Verify current OpenAI/Railway docs before changing model ids, request shapes or deployment settings.
  Never claim real tests, latency or deployment that were not executed.

## Models (verified 2026-10-13)

`gpt-6-luna` (reasoning none…xhigh; $0.10/$0.50 per 1M tokens) for Quick and, by default, Detailed
(reasoning low). `gpt-6.1-sol` (low…xhigh; $2/$10) optional via `OPENAI_ANSWER_MODEL_DETAILED`.
`gpt-live-transcribe` $0.017/min — the main cost driver; idle auto-stop after 5 min without speech.

## Progress

- Done: backend + frontend, real OpenAI verified (models, ephemeral token, WebRTC transcription via
  aiortc, streaming answers, 20-question latency), 64 automated tests, Docker image, Railway config,
  docs. See docs/verification.md.
- Deployed: https://english-voice-agent-production.up.railway.app (Railway project gallant-flexibility, service
  english-voice-agent, us-west2). Railway CLI is installed and linked in this folder (railway logs/variables;
  on Windows call `$env:APPDATA\npm\railway.cmd` if `railway` is not on PATH).
- STOPPED 2026-10-15 between interviews to save cost (`railway down -y`; variables, domain and key kept).
  Restart before an interview: `railway redeploy --from-source -y` (plain `redeploy` after `down` rebuilt an
  OLD commit and failed — verified). Every push to main auto-deploys (restarts) it.
- Answers are grounded in CANDIDATE_PROFILE (from the owner's CV; source text in gitignored
  secrets/candidate-profile.txt, CV PDF gitignored) and framed by TARGET_ROLE=AI Solutions Engineer; the
  profile sits in the static instructions (prompt-cacheable). Update via railway variable set --stdin.
- Photo tasks: composer 📷 / paste → client downscales to 1600 px JPEG → /api/answer kind "image" (data URL,
  8 MB route limit, never stored/logged) → gpt-6-luna vision with IMAGE_TASK_PROMPT (server/src/answer/context.ts).
- Remaining (owner): iPhone Safari + laptop-audio manual tests (docs/manual-iphone-test.md).
