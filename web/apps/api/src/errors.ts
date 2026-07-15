import type { ErrorCode } from './internal.js';
export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: ErrorCode, message: string, public readonly details: Record<string, unknown> = {}) { super(message); }
}
