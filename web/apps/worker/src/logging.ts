export type LogLevel = 'info' | 'error';
export type LogSink = (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;

const sensitiveKey = /qr|credential|auth|token|secret|private|key|message|phone/i;

function redact(value: unknown, key = ''): unknown {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  if (value instanceof Error) return { errorClass: value.name };
  return value;
}

export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...redact(fields) as Record<string, unknown> }));
}
