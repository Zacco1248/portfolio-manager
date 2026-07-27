import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { unauthorized } from '../lib/errors.js';
import { getValidSession } from '../services/auth.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      sessionId?: string;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.cookies?.[config.auth.cookieName] as string | undefined;
  const session = getValidSession(raw);
  if (!session) {
    next(unauthorized());
    return;
  }
  req.sessionId = session.id;
  next();
}

export function setSessionCookie(res: Response, id: string, expiresAt: string): void {
  res.cookie(config.auth.cookieName, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.auth.cookieSecure,
    expires: new Date(expiresAt),
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(config.auth.cookieName, { path: '/' });
}
