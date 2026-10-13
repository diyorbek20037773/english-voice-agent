import type { FastifyInstance } from 'fastify';
import type { Config } from './config.ts';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function registerSecurity(app: FastifyInstance, config: Config): void {
  // CSRF defense: state-changing /api requests must come from our own origin.
  // Browsers always send Origin on cross-origin POST/PUT/DELETE and on fetch().
  app.addHook('onRequest', async (req, reply) => {
    if (!UNSAFE_METHODS.has(req.method) || !req.url.startsWith('/api/')) return;
    const origin = req.headers.origin;
    let sourceOrigin: string | null = typeof origin === 'string' ? origin : null;
    if (!sourceOrigin && typeof req.headers.referer === 'string') {
      try {
        sourceOrigin = new URL(req.headers.referer).origin;
      } catch {
        sourceOrigin = null;
      }
    }
    if (sourceOrigin !== config.ALLOWED_ORIGIN) {
      await reply.code(403).send({ error: { code: 'bad_origin', message: 'Request origin is not allowed.' } });
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'microphone=(self), display-capture=(self), camera=(), geolocation=()');
    if (config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (!req.url.startsWith('/api/')) {
      reply.header(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self'",
          "img-src 'self' data:",
          "font-src 'self'",
          // WebRTC SDP exchange goes straight to OpenAI with the ephemeral token.
          "connect-src 'self' https://api.openai.com",
          "media-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
          "form-action 'self'",
        ].join('; '),
      );
    }
    return payload;
  });
}
