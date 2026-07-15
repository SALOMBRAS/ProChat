import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors.js';
import { log } from '../logging.js';
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const correlationId = req.context?.correlationId ?? 'unknown';
  const appError = error instanceof AppError ? error : error instanceof ZodError ? new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', error.flatten()) : new AppError(500, 'SERVICE_UNAVAILABLE', 'Unexpected service error');
  log('error', appError.message, { correlationId, code: appError.code, status: appError.status });
  res.status(appError.status).json({ error: { code: appError.code, message: appError.message, correlationId, details: appError.details } });
};
