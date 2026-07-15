import { safeIdentifierSchema } from '@chatpro/contracts';
import { WorkerOperationError } from './ports.js';

export function assertSafeIdentifier(value: string, label: string, correlationId: string): string {
  const result = safeIdentifierSchema.safeParse(value);
  if (!result.success) throw new WorkerOperationError('VALIDATION_ERROR', `Invalid ${label}`, correlationId);
  return result.data;
}
