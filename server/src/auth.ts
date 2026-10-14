import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';

/**
 * Single-owner access: the owner unlocks the app once per device with
 * APP_ACCESS_TOKEN and receives a signed, HttpOnly, Secure, SameSite=Strict
 * session cookie. No database: the cookie is a stateless HMAC-signed expiry.
 * The signing key is derived from APP_ACCESS_TOKEN, so rotating the token
 * immediately invalidates every existing session.
 * With OPEN_ACCESS=true there is no unlock step: every request counts as the owner.
 */
export class Auth {
  private readonly key: Buffer;
  private failures: number[] = [];

  constructor(private readonly config: Config) {
    this.key = config.APP_ACCESS_TOKEN
      ? createHmac('sha256', config.APP_ACCESS_TOKEN).update('eva-session-key-v1').digest()
      : randomBytes(32);
  }

  private mac(data: string): Buffer {
    return createHmac('sha256', this.key).update(data).digest();
  }

  /** Global lockout: 10 failures within 15 minutes block all attempts for the rest of that window. */
  isLockedOut(now = Date.now()): boolean {
    this.failures = this.failures.filter((t) => now - t < 15 * 60_000);
    return this.failures.length >= 10;
  }

  get open(): boolean {
    return this.config.OPEN_ACCESS;
  }

  checkToken(given: string): boolean {
    if (this.open) return true;
    // Compare fixed-length MACs so neither length nor content leaks through timing.
    const ok = timingSafeEqual(this.mac(`token:${given}`), this.mac(`token:${this.config.APP_ACCESS_TOKEN ?? ''}`));
    if (!ok) this.failures.push(Date.now());
    return ok;
  }

  issue(reply: FastifyReply, now = Date.now()): void {
    const payload = Buffer.from(JSON.stringify({ v: 1, exp: now + this.config.SESSION_TTL_DAYS * 86_400_000 })).toString('base64url');
    const value = `${payload}.${this.mac(`session:${payload}`).toString('base64url')}`;
    reply.setCookie(this.config.cookieName, value, {
      httpOnly: true,
      secure: this.config.secureCookies,
      sameSite: 'strict',
      path: '/',
      maxAge: this.config.SESSION_TTL_DAYS * 86_400,
    });
  }

  clear(reply: FastifyReply): void {
    reply.clearCookie(this.config.cookieName, { path: '/', secure: this.config.secureCookies, sameSite: 'strict', httpOnly: true });
  }

  isAuthenticated(req: FastifyRequest, now = Date.now()): boolean {
    if (this.open) return true;
    const value = req.cookies[this.config.cookieName];
    if (!value || value.length > 512) return false;
    const [payload, sig] = value.split('.');
    if (!payload || !sig) return false;
    const expected = this.mac(`session:${payload}`);
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    try {
      const { v, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { v?: number; exp?: number };
      return v === 1 && typeof exp === 'number' && exp > now;
    } catch {
      return false;
    }
  }

  /** preHandler: 401 unless the request carries a valid session cookie. */
  requireAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!this.isAuthenticated(req)) {
      await reply.code(401).header('Cache-Control', 'no-store').send({ error: { code: 'unauthenticated', message: 'Please unlock the app.' } });
    }
  };
}
