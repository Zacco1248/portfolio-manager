import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiRouter } from './routes/index.js';

const log = createLogger('app');

export function createApp(): express.Express {
  const app = express();

  // Za reverse proxy (opcjonalnym) chcemy poprawne req.ip do throttlingu logowania.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.use('/api', apiRouter);

  // Frontend budowany do frontend/dist i serwowany z tego samego portu.
  const clientDir = resolveClientDir();
  if (clientDir) {
    log.info(`Serwuję frontend z ${clientDir}`);
    app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
    // SPA fallback — wszystko poza /api oddaje index.html.
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  } else {
    log.warn('Brak zbudowanego frontendu (frontend/dist) — dostępne jest tylko API pod /api');
  }

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}

function resolveClientDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CLIENT_DIR,
    path.resolve(here, '../public'), // obraz produkcyjny: dist/../public
    path.resolve(here, '../../frontend/dist'), // dev z src/
    path.resolve(process.cwd(), '../frontend/dist'),
  ].filter((p): p is string => Boolean(p));

  return candidates.find((dir) => existsSync(path.join(dir, 'index.html'))) ?? null;
}

export { config };
