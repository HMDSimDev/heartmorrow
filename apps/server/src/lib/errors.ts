/** Application error carrying an HTTP status code and optional details. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, message, details);
export const forbidden = (message = 'This feature is not enabled.') => new AppError(403, message);
export const notFound = (message = 'Not found') => new AppError(404, message);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, message, details);
export const serverError = (message: string, details?: unknown) =>
  new AppError(500, message, details);
