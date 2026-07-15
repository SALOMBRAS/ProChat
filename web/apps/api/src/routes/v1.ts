import { Router } from 'express';
import { CatalogController } from '../controllers/catalog.controller.js';
import { workspaceContext } from '../middleware/context.js';
export function createV1Router(controller: CatalogController): Router {
  const router = Router(); router.use(workspaceContext);
  router.get('/sessions', controller.sessions); router.post('/sessions', controller.createSession); router.get('/sessions/:sessionId', controller.getSession); router.post('/sessions/:sessionId/connect', controller.connect); router.post('/sessions/:sessionId/disconnect', controller.disconnect); router.delete('/sessions/:sessionId', controller.removeSession);
  router.get('/contacts', controller.contacts);
  router.get('/templates', controller.templates); router.post('/templates', controller.createTemplate); router.put('/templates/:templateId', controller.updateTemplate); router.delete('/templates/:templateId', controller.removeTemplate);
  return router;
}
