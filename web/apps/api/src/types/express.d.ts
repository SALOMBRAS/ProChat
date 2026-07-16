import type { RequestContext } from '@chatpro/contracts';
declare global { namespace Express { interface Request { context?: RequestContext; rawBody?: Buffer; } } }
export {};
