import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { analyticsRouter } from './analytics.js';
import { authRouter } from './auth.js';
import { importsRouter } from './imports.js';
import { instrumentsRouter } from './instruments.js';
import { portfoliosRouter } from './portfolios.js';
import { positionsRouter } from './positions.js';
import { statusRouter } from './status.js';
import { transactionsRouter } from './transactions.js';

export const apiRouter = Router();

// Publiczne: logowanie i healthcheck.
apiRouter.use('/auth', authRouter);
apiRouter.get('/health', (_req, res) => res.json({ ok: true }));

// Wszystko poniżej wymaga zalogowania.
apiRouter.use(requireAuth);
apiRouter.use('/status', statusRouter);
apiRouter.use('/portfolios', portfoliosRouter);
apiRouter.use('/instruments', instrumentsRouter);
apiRouter.use('/transactions', transactionsRouter);
apiRouter.use('/positions', positionsRouter);
apiRouter.use('/analytics', analyticsRouter);
apiRouter.use('/imports', importsRouter);
