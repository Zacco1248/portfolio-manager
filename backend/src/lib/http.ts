import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 nie łapie odrzuconych promisów z handlerów async — bez tego
 * wrappera każdy `await` rzucający błąd wieszałby request.
 */
export function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

export function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0]!.trim();
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
