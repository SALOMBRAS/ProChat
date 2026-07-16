import express from 'express';
import { CatalogController } from './controllers/catalog.controller.js';
import { correlationContext } from './middleware/context.js';
import { errorHandler } from './middleware/errors.js';
import { createV1Router } from './routes/v1.js';
import { UnavailableContactService, UnavailableSessionService, UnavailableTemplateService } from './services/unavailable-catalog.service.js';
import { InternalWorkerClient } from './internal-worker-client.js';
import { loadConfig, type ApiConfig } from './config.js';
import { InternalSessionService } from './services/internal-session.service.js';
export function createApp(config: ApiConfig = loadConfig()) {
  const app = express(); app.use(express.json()); app.use(correlationContext);
  app.get('/health', (_req, res) => res.json({ name: 'ChatPro API', status: 'ok', version: '0.1.0' }));
  app.use('/api/v1', createV1Router(new CatalogController(new InternalSessionService(new InternalWorkerClient({ url: config.workerTransportUrl, timeoutMs: config.workerTransportTimeoutMs })), new UnavailableContactService(), new UnavailableTemplateService()))); app.use(errorHandler);
  return app;
}
