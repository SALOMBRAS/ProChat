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
import { createDomainRepositoryForProvider } from './persistence/provider.js';
export async function createApp(config: ApiConfig = loadConfig()) {
  const app = express(); app.use(express.json()); app.use(correlationContext);
  // Controllers retain their public handler shapes while domain calls are now
  // promises. Resolve a returned value before serializing it.
  app.use((_req, res, next) => {
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (body instanceof Promise) { void body.then((value) => json(value)).catch(next); return res; }
      return json(body);
    }) as typeof res.json;
    const send = res.send.bind(res);
    res.send = ((body: unknown) => {
      if (body instanceof Promise) { void body.then((value) => send(value)).catch(next); return res; }
      return send(body);
    }) as typeof res.send;
    next();
  });
  app.get('/health', (_req, res) => res.json({ name: 'ChatPro API', status: 'ok', version: '0.1.0' }));
  const sessions = new InternalSessionService(new InternalWorkerClient({ url: config.workerTransportUrl, timeoutMs: config.workerTransportTimeoutMs })); const database = config.databasePath ? new SqlitePersistenceDatabase(config.databasePath) : createDevelopmentDatabase(); database.migrate();
  app.locals.persistenceDatabase = database;
  try {
    const repositories = await createDomainRepositoryForProvider(config, database.sqlite);
    app.use('/api/v1', createV1Router(new CatalogController(sessions, new UnavailableContactService(), new UnavailableTemplateService()), new DomainController(new DomainService(repositories), sessions))); app.use(errorHandler);
  } catch (error) { database.close(); throw error; }
  return app;
}
