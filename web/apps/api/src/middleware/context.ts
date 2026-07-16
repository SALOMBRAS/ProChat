import type { RequestHandler } from 'express';
import { requestContextSchema } from '@chatpro/contracts';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';

export const correlationContext: RequestHandler = (req, _res, next) => {
  const correlationId = req.header('x-correlation-id') ?? randomUUID();
  req.context = { correlationId, workspaceId: '', userId: '' };
  next();
};
export const workspaceContext: RequestHandler = (req, _res, next) => {
  const candidate = { correlationId: req.context?.correlationId ?? randomUUID(), workspaceId: req.header('x-workspace-id') ?? '', userId: req.header('x-user-id') || undefined };
  const parsed = requestContextSchema.safeParse(candidate);
  if (!parsed.success) return next(new AppError(401, 'UNAUTHORIZED', 'Temporary development context header x-workspace-id is required', parsed.error.flatten()));
  req.context = parsed.data;
  next();
};
