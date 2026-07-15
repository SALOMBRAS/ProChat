export interface ApiConfig { port: number; nodeEnv: string; }
export function loadConfig(env = process.env): ApiConfig {
  const port = Number(env.API_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT must be a valid TCP port');
  return { port, nodeEnv: env.NODE_ENV ?? 'development' };
}
