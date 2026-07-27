import { Router } from 'express';
import { loginSchema } from '@portfolio/shared';
import { AppError } from '../lib/errors.js';
import { clientIp } from '../lib/http.js';
import { clearSessionCookie, requireAuth, setSessionCookie } from '../middleware/auth.js';
import {
  clearAttempts,
  createSession,
  destroySession,
  isLockedOut,
  recordFailedAttempt,
  verifyPassword,
} from '../services/auth.js';

export const authRouter = Router();

authRouter.post('/login', (req, res, next) => {
  const ip = clientIp(req);
  const lockedFor = isLockedOut(ip);
  if (lockedFor > 0) {
    next(new AppError(429, 'too_many_attempts', `Za dużo prób. Spróbuj ponownie za ${lockedFor} s.`));
    return;
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    next(parsed.error);
    return;
  }

  if (!verifyPassword(parsed.data.password)) {
    recordFailedAttempt(ip);
    next(new AppError(401, 'invalid_password', 'Nieprawidłowe hasło'));
    return;
  }

  clearAttempts(ip);
  const session = createSession(req.headers['user-agent'], ip);
  setSessionCookie(res, session.id, session.expiresAt);
  res.json({ ok: true, expiresAt: session.expiresAt });
});

authRouter.post('/logout', requireAuth, (req, res) => {
  if (req.sessionId) destroySession(req.sessionId);
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** Lekki endpoint dla frontendu — sprawdza, czy sesja jeszcze żyje. */
authRouter.get('/me', requireAuth, (_req, res) => {
  res.json({ authenticated: true });
});
