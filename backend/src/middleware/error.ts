import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('http');

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: 'not_found', message: `Nie ma trasy ${req.method} ${req.path}` });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(422).json({
      error: 'validation_error',
      message: 'Nieprawidłowe dane wejściowe',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }

  if (err instanceof AppError) {
    // 4xx to normalny przebieg (np. zły token), nie zaśmiecamy nimi logu na poziomie error.
    if (err.status >= 500) log.error(`${req.method} ${req.path} → ${err.code}`, err);
    res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    return;
  }

  log.error(`Nieobsłużony błąd: ${req.method} ${req.path}`, err);
  res.status(500).json({
    error: 'internal_error',
    message: 'Błąd serwera. Szczegóły w logach aplikacji.',
  });
}
