import express from 'express';
import { CatalogController } from './controllers/catalog.controller.js';
import { correlationContext } from './middleware/context.js';
import { errorHandler } from './middleware/errors.js';
import { createV1Router } from './routes/v1.js';
import { UnavailableContactService, UnavailableSessionService, UnavailableTemplateService } from './services/unavailable-catalog.service.js';
import { InternalWorkerClient } from './internal-worker-client.js';
import { loadConfig, type ApiConfig } from './config.js';
import { InternalSessionService } from './services/internal-session.service.js';
import { createDevelopmentDatabase } from './persistence/database.js';
import { DomainService } from './services/domain.service.js';
import { DomainController } from './controllers/domain.controller.js';
import { SqlitePersistenceDatabase } from './persistence/database.js';
export function createApp(config: ApiConfig = loadConfig()) {
  const app = express(); app.use(express.json()); app.use(correlationContext);
  app.get('/health', (_req, res) => res.json({ name: 'ChatPro API', status: 'ok', version: '0.1.0' }));
  const sessions = new InternalSessionService(new InternalWorkerClient({ url: config.workerTransportUrl, timeoutMs: config.workerTransportTimeoutMs })); const database = config.databasePath ? new SqlitePersistenceDatabase(config.databasePath) : createDevelopmentDatabase(); database.migrate();
  app.locals.persistenceDatabase = database;
  app.use('/api/v1', createV1Router(new CatalogController(sessions, new UnavailableContactService(), new UnavailableTemplateService()), new DomainController(new DomainService(database.sqlite), sessions))); app.use(errorHandler);
  return app;
}
