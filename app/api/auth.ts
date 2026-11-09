import { Router, type Request, type Response } from 'express';
import type { Store } from './store.js';

const COOKIE = 'harmonizer_session';
export function sessionToken(req: Request): string | undefined {
  return req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}
function cookieOptions(req: Request) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: req.secure || process.env.COOKIE_SECURE === 'true', path: '/' };
}

export function authRouter(store: Store) {
  const router = Router();
  const attempts = new Map<string, { count: number; until: number }>();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/session', (_req, res) => { res.json({ user: res.locals.user ?? null }); });
  for (const action of ['register', 'login'] as const) {
    router.post(`/${action}`, async (req, res) => {
      const now = Date.now();
      for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
      const key = req.ip ?? 'local';
      const count = attempts.get(key) ?? { count: 0, until: now + 15 * 60 * 1000 };
      attempts.set(key, count);
      if (++count.count > 20) { res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' }); return; }
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128) {
        res.status(400).json({ error: 'Use a valid email and a password with 12–128 characters.' }); return;
      }
      const user = await store[action](email, password);
      if (!user) {
        res.status(action === 'register' ? 409 : 401).json({ error: action === 'register' ? 'An account with this email already exists. Sign in instead.' : 'Email or password is incorrect.' }); return;
      }
      store.deleteSession(sessionToken(req));
      res.cookie(COOKIE, store.createSession(user.id), { ...cookieOptions(req), maxAge: 30 * 24 * 60 * 60 * 1000 });
      res.status(action === 'register' ? 201 : 200).json({ user });
    });
  }
  router.post('/logout', (req: Request, res: Response) => {
    store.deleteSession(sessionToken(req));
    res.clearCookie(COOKIE, cookieOptions(req));
    res.json({ user: null });
  });
  return router;
}
