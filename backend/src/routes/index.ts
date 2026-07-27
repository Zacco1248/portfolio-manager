import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { authRouter } from './auth.js';
import { portfoliosRouter } from './portfolios.js';
import { statusRouter } from './status.js';

export const apiRouter = Router();

// Publiczne: logowanie i healthcheck.
apiRouter.use('/auth', authRouter);
apiRouter.get('/health', (_req, res) => res.json({ ok: true }));

// Wszystko poniżej wymaga zalogowania.
apiRouter.use(requireAuth);
apiRouter.use('/status', statusRouter);
apiRouter.use('/portfolios', portfoliosRouter);
