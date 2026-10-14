// Deterministic OpenAI API mock for FREE tests (MOCKED — not OpenAI).
// Implements just enough of:
//   GET  /v1/models
//   POST /v1/realtime/client_secrets
//   POST /v1/responses   (Responses API streaming SSE)
// and records every request for assertions at GET /__mock/requests.
// Magic words in the latest question:
//   QUOTA_TEST  → 429 insufficient_quota        RATE_TEST → 429 rate_limit_exceeded
//   FAIL_TEST   → response.failed mid-stream    DROP_TEST → connection drops mid-stream
//   LONG_TEST   → response.incomplete (max_output_tokens) inside an open code block
//   SLOW_TEST   → slow deltas                   UNICODE_TEST → multi-byte characters
//   SERVER_ERROR_ONCE → first call 500, then normal
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const KNOWN_MODELS = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-live-transcribe'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastUserText(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item?.role !== 'user') continue;
    if (typeof item.content === 'string') return item.content;
    if (Array.isArray(item.content)) return item.content.map((c) => c.text ?? '').join('');
  }
  return '';
}

function chunkText(text, n) {
  const cps = Array.from(text);
  const size = Math.max(1, Math.ceil(cps.length / n));
  const out = [];
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(''));
  return out;
}

export function createMockOpenAi() {
  const requests = [];
  let serverErrorOnceUsed = false;

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  async function streamText(res, model, deltas, { delayMs = 20, terminal = 'completed', dropAfter = null, failAfter = null } = {}) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let seq = 0;
    const send = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
    const base = { id: `resp_${randomUUID().replace(/-/g, '')}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model, output: [] };
    send('response.created', { response: { ...base, status: 'in_progress' } });
    const itemId = `msg_${randomUUID().slice(0, 8)}`;
    send('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    send('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    for (let i = 0; i < deltas.length; i++) {
      if (res.destroyed) return;
      if (dropAfter !== null && i === dropAfter) return res.socket?.destroy();
      if (failAfter !== null && i === failAfter) {
        send('response.failed', { response: { ...base, status: 'failed', error: { code: 'server_error', message: 'Mock failure mid-stream' } } });
        return res.end();
      }
      send('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: deltas[i], logprobs: [] });
      await sleep(delayMs);
    }
    const text = deltas.join('');
    send('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text, logprobs: [] });
    const usage = { input_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 160 };
    const item = { id: itemId, type: 'message', status: terminal === 'completed' ? 'completed' : 'incomplete', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
    send('response.output_item.done', { output_index: 0, item });
    if (terminal === 'completed') send('response.completed', { response: { ...base, status: 'completed', output: [item], usage } });
    else send('response.incomplete', { response: { ...base, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [item], usage } });
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    let body = null;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
    }
    if (url.pathname === '/__mock/requests') {
      if (req.method === 'DELETE') requests.length = 0;
      return json(res, 200, requests);
    }
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });

    const auth = String(req.headers.authorization ?? '');
    requests.push({ method: req.method, path: url.pathname, authorization: auth ? `${auth.slice(0, 10)}…` : null, body });
    if (!auth.startsWith('Bearer ')) return json(res, 401, { error: { message: 'Missing bearer token', type: 'invalid_request_error', code: 'invalid_api_key' } });

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: KNOWN_MODELS.map((id) => ({ id, object: 'model', owned_by: 'mock' })) });
    }

    if (req.method === 'POST' && url.pathname === '/v1/realtime/client_secrets') {
      const s = body?.session;
      const t = s?.audio?.input?.transcription;
      if (!(s?.type === 'transcription' && t?.model && Array.isArray(t?.languages) && s.audio.input.turn_detection === null)) {
        return json(res, 400, { error: { message: 'Mock: unexpected session shape', type: 'invalid_request_error', code: 'invalid_value' } });
      }
      return json(res, 200, {
        value: `ek_mock_${randomUUID().replace(/-/g, '')}`,
        expires_at: Math.floor(Date.now() / 1000) + (body?.expires_after?.seconds ?? 600),
        session: { id: `sess_mock_${randomUUID().slice(0, 8)}`, type: 'transcription', audio: s.audio },
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/responses') {
      const model = body?.model;
      const q = lastUserText(body?.input);
      if (!KNOWN_MODELS.includes(model)) {
        return json(res, 404, { error: { message: `The model \`${model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', code: 'model_not_found' } });
      }
      if (/SERVER_ERROR_ONCE/.test(q) && !serverErrorOnceUsed) {
        serverErrorOnceUsed = true;
        return json(res, 500, { error: { message: 'The server had an error', type: 'server_error' } });
      }
      if (/QUOTA_TEST/.test(q)) {
        return json(res, 429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } });
      }
      if (/RATE_TEST/.test(q)) return json(res, 429, { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } });
      if (!body?.stream) return json(res, 400, { error: { message: 'Mock only supports stream: true', type: 'invalid_request_error' } });

      const hasImage = Array.isArray(body?.input) && body.input.some((m) => Array.isArray(m?.content) && m.content.some((c) => c?.type === 'input_image'));
      if (hasImage) {
        const solution =
          'Task: return indices of two numbers that add up to target.\n\n```python\ndef two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n        seen[n] = i\n```\n\nTime O(n), space O(n).';
        return streamText(res, model, chunkText(solution, 10), { delayMs: 10 });
      }
      if (/UNICODE_TEST/.test(q)) return streamText(res, model, ['Привет — naïve café ', '🚀 oʻzbekcha ', '日本語 ✓ done.']);
      if (/SLOW_TEST/.test(q)) return streamText(res, model, chunkText('This answer streams slowly so supersede and cancel can be tested. '.repeat(3), 30), { delayMs: 120 });
      if (/DROP_TEST/.test(q)) return streamText(res, model, ['Partial ', 'answer ', 'then ', 'drop.'], { dropAfter: 2 });
      if (/FAIL_TEST/.test(q)) return streamText(res, model, ['Partial ', 'answer ', 'then ', 'fail.'], { failAfter: 2 });
      if (/CODE_TEST/.test(q)) {
        const code = 'Use a hash map.\n\n```python\ndef two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n        seen[n] = i\n    return []\n```\n\nTime O(n), space O(n).';
        return streamText(res, model, chunkText(code, 12), { delayMs: 15 });
      }
      if (/LONG_TEST/.test(q)) return streamText(res, model, ['Here is the code:\n\n```js\nfunction big() {\n', '  // ...\n'.repeat(5)], { terminal: 'incomplete' });
      const question = q.match(/<question>\n([\s\S]*?)\n<\/question>/)?.[1] ?? q;
      return streamText(res, model, chunkText(`Mock answer to "${question.slice(0, 80)}". A hash map gives O(1) average lookups; the tradeoff is extra memory.`, 8));
    }

    json(res, 404, { error: { message: 'not found' } });
  });

  return {
    server,
    requests,
    listen: (port = 0) =>
      new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mock = createMockOpenAi();
  const url = await mock.listen(Number(process.env.PORT ?? 4010));
  console.log(`mock-openai listening on ${url} (MOCK — not OpenAI)`);
}
