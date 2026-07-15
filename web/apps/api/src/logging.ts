export function log(level: 'info' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...fields }));
}
