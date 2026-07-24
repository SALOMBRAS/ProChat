import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors.js';
import { log } from '../logging.js';
import multer from 'multer';
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const correlationId = req.context?.correlationId ?? 'unknown';
  const appError = error instanceof AppError ? error : error instanceof ZodError ? new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', error.flatten()) : error instanceof multer.MulterError ? new AppError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'VALIDATION_ERROR', error.code === 'LIMIT_FILE_SIZE' ? 'Arquivo excede o limite permitido' : 'Arquivo inválido') : new AppError(500, 'SERVICE_UNAVAILABLE', 'Unexpected service error');
  log('error', appError.message, { correlationId, code: appError.code, status: appError.status, ...errorDiagnostics(error) });
  if (res.headersSent || res.destroyed) return;
  res.status(appError.status).json({ error: { code: appError.code, message: appError.message, correlationId, details: appError.details } });
};

function errorDiagnostics(error: unknown): Record<string, unknown> {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  return {
    errorClass: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorStack: error instanceof Error ? error.stack?.slice(0, 4_000) ?? null : null,
    databaseCode: typeof value?.code === 'string' ? value.code : null,
    databaseDetails: typeof value?.details === 'string' ? value.details.slice(0, 2_000) : null,
  };
}
