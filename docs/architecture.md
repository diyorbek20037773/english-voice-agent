# Architecture

One Railway service hosts the built React app and the Fastify API on one HTTPS origin.
No n8n, no database, no queues, no agent framework, no tool loops.

```
┌──────────── Phone (Safari / Chrome) ─────────────┐
│ mic ─▶ RTCPeerConnection ─────────── audio ──────┼──▶ OpenAI Realtime (gpt-live-transcribe)
│        data channel "oai-events" ◀── transcript ─┼──┘   POST /v1/realtime/calls (SDP, ephemeral token)
│ energy VAD + question heuristic → commit turn    │
│ fetch POST /api/answer ◀── SSE answer.* ─────────┼──┐
└──────────────────────────────────────────────────┘  │
┌──────────── Railway "web" service ───────────────┐  │
│ Fastify: /api/realtime/session ─▶ POST /v1/realtime/client_secrets (OPENAI_API_KEY)
│          /api/answer ─▶ POST /v1/responses (stream) ─▶ normalize ─▶ SSE ┘
│ static: dist/web (CSP, HSTS, cookies)            │
└──────────────────────────────────────────────────┘
```

## Request flows

**Realtime session.** `POST /api/realtime/session` (authenticated, 30/hour) creates an ephemeral
client secret: `session.type = "transcription"`, `audio.input.transcription = { model:
gpt-live-transcribe, languages: ["en"], keywords: [...] }`, `turn_detection: null`, TTL 60 s.
Only `{clientSecret, expiresAt, model, rtcUrl}` is returned, with `Cache-Control: no-store`; the token
is never logged. Token expiry only limits starting a call; a running call continues until Stop.

**Transcription.** The browser adds the mic track, opens the `oai-events` data channel and posts its
SDP offer to `https://api.openai.com/v1/realtime/calls`. Live `…transcription.delta` events stream
while speaking (verified: first words ~0.5 s after speech start). A turn ends when the browser sends
`input_audio_buffer.commit` (Answer button, or Auto mode after the silence threshold);
`input_audio_buffer.committed` and `…transcription.completed` follow (verified: final ~0.7 s after
commit). Finals are reconciled by `item_id`/`content_index` and are authoritative.

**Answer.** `POST /api/answer {practiceSessionId, questionId, question, mode, kind, continueOf?,
inputMode}` → validation → dedup (same session+questionId replays, never re-bills; in-progress
duplicate → 409) → daily limit → build a small request (static instructions for prompt caching, last
3 turns, profile only for personal questions) → stream `POST /v1/responses` → forward each
`response.output_text.delta` as `answer.delta` immediately (no buffering, backpressure respected,
heartbeat every 15 s) → `answer.done` (with `truncated` from `response.incomplete`) or `answer.error`.

## Reliability rules

- One active answer per practice session: a newer question aborts the previous upstream request and
  the old stream ends with `answer.error {code: "superseded"}`. The browser also drops events whose
  questionId/requestId do not match the card they belong to.
- Timeouts: first byte 30 s, idle 30 s, total 120 s. One retry only for 5xx/network errors before any
  text. Aborting stops our request; whether OpenAI stops billing for tokens generated before the
  abort is not verified.
- Limits: 20 answers/minute, 200 answers/day (Asia/Tashkent), 30 voice sessions/hour, 5 unlock
  attempts/minute + 15-minute lockout after 10 failures, 32 KB request bodies, 2000-char questions.
- Budget: answers ~$0.0001 each on gpt-6-luna; listening $0.017/min → auto-stop after 5 minutes
  without speech; Pause sends no audio.

## What is (not) stored

Nothing is written to disk. In memory: practice sessions (12 h TTL, max 50), last 6 turns per
session, dedup records, timing samples (max 2000). No audio is ever received by the server.
Logs contain timings, token counts and error codes — never questions, answers, keys or tokens.

## Known limits

- The phone mic hears the room, not another laptop's meeting audio.
- iOS may suspend the mic when Safari is backgrounded; the app detects it and asks to restart.
- VAD is loudness-based; the "complete question" check is a heuristic, not semantic understanding;
  no speaker identification.
- Single replica only (state is in memory).
