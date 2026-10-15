import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { Config } from './config.ts';
import { Auth } from './auth.ts';
import { OpenAiClient } from './openai/client.ts';
import { MemoryState } from './state.ts';
import { AnswerService } from './answer/service.ts';
import { registerSecurity } from './security.ts';
import { registerApiRoutes } from './routes/api.ts';

export interface AppDeps {
  config: Config;
  fetchImpl?: typeof fetch;
  logger?: FastifyServerOptions['logger'];
  /** Directory with the built frontend; null disables static serving. */
  webDir?: string | null;
}

export interface App {
  app: FastifyInstance;
  state: MemoryState;
}

export const LOG_REDACT = ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'];

export async function buildApp(deps: AppDeps): Promise<App> {
  const { config } = deps;
  const app = Fastify({
    logger: deps.logger ?? { level: config.LOG_LEVEL, redact: { paths: LOG_REDACT, censor: '[redacted]' } },
    // Trust exactly N proxy hops (Railway's edge = 1) when deriving client IP and protocol.
    trustProxy: (_addr: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
    bodyLimit: 32 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  // Only JSON bodies are accepted; text/plain is a CORS "simple" type and is removed.
  app.removeContentTypeParser('text/plain');

  const auth = new Auth(config);
  const openai = new OpenAiClient(config, deps.fetchImpl ?? fetch);
  const state = new MemoryState(config.TIMEZONE);
  const answers = new AnswerService({ config, openai, state, log: app.log });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    hook: 'preHandler',
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      code: 'rate_limited',
      message: `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)} seconds.`,
    }),
  });
  registerSecurity(app, config);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'bad_request', message: 'Invalid request.' } });
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: e.message ?? 'Too many requests.' } });
    if (status >= 400 && status < 500) {
      const code = status === 413 ? 'too_large' : status === 415 ? 'unsupported_media_type' : 'bad_request';
      return reply.code(status).send({ error: { code, message: status === 413 ? 'Request is too large.' : 'Invalid request.' } });
    }
    req.log.error({ err: e.message }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on the server.' } });
  });

  // Liveness: no dependencies, no configuration output.
  app.get('/healthz', async (_req, reply) => reply.header('Cache-Control', 'no-store').send({ status: 'ok' }));
  // Readiness: configuration loaded and the process is serving. Never calls OpenAI (no cost).
  app.get('/readyz', async (_req, reply) => reply.header('Cache-Control', 'no-store').send({ status: 'ok' }));

  await app.register(async (api) => registerApiRoutes(api, { config, auth, openai, state, answers }), { prefix: '/api' });

  const webDir = deps.webDir === undefined ? defaultWebDir() : deps.webDir;
  if (webDir && existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDir,
      index: ['index.html'],
      setHeaders: (reply, filePath) => {
        // Hashed assets are immutable; HTML must always be revalidated.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else reply.header('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const urlPath = req.url.split('?')[0] ?? '';
      const looksLikeFile = Boolean(path.extname(urlPath)) || urlPath.split('/').some((seg) => seg.startsWith('.'));
      if (req.method === 'GET' && !urlPath.startsWith('/api/') && !looksLikeFile) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } }));
  }

  const pruneTimer = setInterval(() => state.prune(), 10 * 60_000);
  pruneTimer.unref();
  app.addHook('onClose', async () => clearInterval(pruneTimer));

  return { app, state };
}

function defaultWebDir(): string | null {
  // Production bundle: dist/server/index.js → dist/web
  const candidate = path.resolve(path.dirname(process.argv[1] ?? '.'), '../web');
  return existsSync(candidate) ? candidate : null;
}
