export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Wymagane logowanie') => new AppError(401, 'unauthorized', message);
export const notFound = (message = 'Nie znaleziono') => new AppError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);
export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'unprocessable', message, details);
export const serviceUnavailable = (message: string) => new AppError(503, 'service_unavailable', message);

/** Sprowadza dowolny rzucony obiekt do czytelnego komunikatu. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
