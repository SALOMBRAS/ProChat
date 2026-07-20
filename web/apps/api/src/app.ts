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
import { createSupabasePersistenceClient } from './persistence/supabase.js';
import { WahaWebhookController } from './controllers/waha-webhook.controller.js';
import { InboxController } from './controllers/inbox.controller.js';
import { SqliteWahaWebhookStore, SupabaseWahaWebhookStore } from './services/waha-webhook.service.js';
import { InternalInboxService } from './services/internal-inbox.service.js';
import { RealtimeHub } from './realtime.js';
import { SqliteWhatsAppIdentityStore, SupabaseWhatsAppIdentityStore, WhatsAppIdentitySyncService } from './services/whatsapp-identity-sync.service.js';
import { ConversationContextService, SqliteConversationContextStore, SupabaseConversationContextStore } from './services/conversation-context.service.js';
import { WhatsAppHistorySyncService, SqliteWhatsAppHistorySyncStore, SupabaseWhatsAppHistorySyncStore } from './services/whatsapp-history-sync.service.js';
import { AttachmentOutboxService, SqliteAttachmentOutboxStore, SupabaseAttachmentOutboxStore, SupabaseTemporaryAttachmentStorage, UnavailableTemporaryAttachmentStorage } from './services/attachment-outbox.service.js';
import { ConversationManagementService } from './services/conversation-management.service.js';
import { SqliteWorkspaceDirectoryStore, SupabaseWorkspaceDirectoryStore, WorkspaceDirectoryService } from './services/workspace-directory.service.js';
import { WorkspaceDirectoryController } from './controllers/workspace-directory.controller.js';
import { RoutingController } from './controllers/routing.controller.js';
import { RoutingService, SqliteRoutingStore, SupabaseRoutingStore } from './services/routing.service.js';
import { SqliteRoutingJobStore } from './services/routing-jobs.service.js';
import { WahaMediaProxyService } from './services/waha-media-proxy.service.js';
import { SupabaseWhatsAppMediaStorage, WhatsAppMediaPersistenceService } from './services/whatsapp-media-persistence.service.js';
import { SlaService, SqliteSlaStore, SupabaseSlaStore } from './services/sla.service.js';
import { KanbanService } from './services/kanban.service.js';
import { SupabaseKanbanService } from './services/supabase-kanban.service.js';
import { KanbanAutomationCoordinator } from './services/kanban-automation.service.js';
export async function createApp(config: ApiConfig = loadConfig()) {
  const app = express();
  const realtimeHub = new RealtimeHub(); app.locals.realtimeHub = realtimeHub;
  const allowedOrigins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);
  app.use((req, res, next) => {
    const origin = req.header('origin');
    if (!origin) return next();
    if (!allowedOrigins.has(origin)) return res.status(403).json({ error: { code: 'CORS_ORIGIN_DENIED', message: 'Origin is not allowed for the local API.' } });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-workspace-id, x-user-id, x-correlation-id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '256kb', verify: (req, _res, buffer) => { (req as { rawBody?: Buffer }).rawBody = Buffer.from(buffer); } })); app.use(correlationContext);
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
  const sessions = new InternalSessionService(new InternalWorkerClient({ url: config.workerTransportUrl, timeoutMs: config.workerTransportTimeoutMs }));
  const database = (config.databaseProvider ?? 'sqlite') === 'sqlite' ? (config.databasePath ? new SqlitePersistenceDatabase(config.databasePath) : createDevelopmentDatabase()) : undefined;
  database?.migrate();
  app.locals.persistenceDatabase = database;
  try {
    const supabase = database ? undefined : createSupabasePersistenceClient(config);
    let webhookStore: SqliteWahaWebhookStore | SupabaseWahaWebhookStore;
    const identityStore = database ? new SqliteWhatsAppIdentityStore(database.sqlite) : new SupabaseWhatsAppIdentityStore(supabase!);
    const contextStore = database ? new SqliteConversationContextStore(database.sqlite) : new SupabaseConversationContextStore(supabase!);
    const syncStore = database ? new SqliteWhatsAppHistorySyncStore(database.sqlite) : new SupabaseWhatsAppHistorySyncStore(supabase!);
    const workerClient = new InternalWorkerClient({ url: config.workerTransportUrl, timeoutMs: config.workerTransportTimeoutMs });
    const outboxStore = database ? new SqliteAttachmentOutboxStore(database.sqlite) : new SupabaseAttachmentOutboxStore(supabase!);
    const attachmentStorage = database ? new UnavailableTemporaryAttachmentStorage() : new SupabaseTemporaryAttachmentStorage(supabase!); const permanentMedia = database ? undefined : new SupabaseWhatsAppMediaStorage(supabase!);
    const directory = new WorkspaceDirectoryService(database ? new SqliteWorkspaceDirectoryStore(database.sqlite) : new SupabaseWorkspaceDirectoryStore(supabase!), realtimeHub, config.developmentUserId);
    const routingStore = database ? new SqliteRoutingStore(database.sqlite) : new SupabaseRoutingStore(supabase!);
    const sla = new SlaService(database ? new SqliteSlaStore(database.sqlite) : new SupabaseSlaStore(supabase!), realtimeHub);
    const kanban = database ? new KanbanService(database.sqlite, realtimeHub, sla) : new SupabaseKanbanService(supabase!, realtimeHub, sla);
    const kanbanAutomation = new KanbanAutomationCoordinator(kanban);
    webhookStore = database ? new SqliteWahaWebhookStore(database.sqlite, kanbanAutomation) : new SupabaseWahaWebhookStore(supabase!, kanbanAutomation);
    const mediaPersistence = new WhatsAppMediaPersistenceService(webhookStore, permanentMedia, { baseUrl: config.wahaBaseUrl, apiKey: config.wahaApiKey });
    if (config.nodeEnv !== 'test') { const timer = setInterval(() => { void sla.tick(); }, 60_000); timer.unref(); }
    const routing = new RoutingService(routingStore, webhookStore, directory, realtimeHub, database ? new SqliteRoutingJobStore(database.sqlite) : undefined);
    const attachments = new AttachmentOutboxService(webhookStore, outboxStore, attachmentStorage, workerClient);
    // A restart must never turn stored work into provider calls. Old rows
    // without provider acceptance are retained and made terminal for review.
    await attachments.reconcileStartup();
    if (config.nodeEnv !== 'test') { const timer = setInterval(() => { void attachments.cleanupExpired(); }, 60 * 60 * 1000); timer.unref(); }
    const identitySync = new WhatsAppIdentitySyncService(workerClient, identityStore, target => realtimeHub.publish(target.workspaceId, 'conversation.updated', { wahaSession: target.wahaSession, chatId: target.chatId, identitySynchronized: true }));
    if (config.nodeEnv !== 'test') identitySync.enqueueBackfill();
    app.post('/api/v1/webhooks/waha', new WahaWebhookController(webhookStore, realtimeHub, { hmacKey: config.wahaWebhookHmacKey, workspaceId: config.wahaWebhookWorkspaceId }, identitySync, async (workspaceId, externalMessageId) => { await attachments.confirm(workspaceId, externalMessageId); }, mediaPersistence).receive); if (mediaPersistence.enabled) setImmediate(() => { void Promise.all([mediaPersistence.importPending(), mediaPersistence.repairStoredMime()]).catch(() => undefined); });
    const repositories = await createDomainRepositoryForProvider(config, database?.sqlite);
    const historySync = new WhatsAppHistorySyncService(workerClient, webhookStore, syncStore, realtimeHub, { maxChatsPerRun: config.whatsappHistorySyncBatchChats, maxMessagesPerRun: config.whatsappHistorySyncBatchMessages, maxChatsTotal: config.whatsappHistorySyncMaxChats, maxMessagesTotal: config.whatsappHistorySyncMaxMessages });
    app.locals.routingJobs = database ? new SqliteRoutingJobStore(database.sqlite) : undefined;
    app.use('/api/v1', createV1Router(new CatalogController(sessions, new UnavailableContactService(), new UnavailableTemplateService()), new DomainController(new DomainService(repositories), sessions), new InboxController(webhookStore, new InternalInboxService(workerClient, webhookStore, realtimeHub, kanbanAutomation), new ConversationContextService(webhookStore, contextStore, realtimeHub), new ConversationManagementService(webhookStore, realtimeHub, directory, routing.cancelForManualAssignment.bind(routing)), historySync, sessions, attachments, new WahaMediaProxyService({ baseUrl: config.wahaBaseUrl, apiKey: config.wahaApiKey, signingKey: config.mediaProxyTokenSecret }), permanentMedia, sla, kanban), new WorkspaceDirectoryController(directory), new RoutingController(routing))); app.use(errorHandler);
  } catch (error) { database?.close(); throw error; }
  return app;
}
