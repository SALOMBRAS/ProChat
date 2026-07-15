import type { RequestHandler } from 'express';
import { connectSessionRequestSchema, contactListQuerySchema, createSessionRequestSchema, createTemplateRequestSchema, updateTemplateRequestSchema } from '@chatpro/contracts';
import type { ContactServicePort, SessionServicePort, TemplateServicePort } from '../ports/catalog.ports.js';
import { AppError } from '../errors.js';
function routeId(value: string | string[] | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new AppError(400, 'VALIDATION_ERROR', `Invalid ${field}`, { field });
  return value;
}
export class CatalogController {
  constructor(private readonly sessionsService: SessionServicePort, private readonly contactsService: ContactServicePort, private readonly templatesService: TemplateServicePort) {}
  sessions: RequestHandler = async (req, res) => { res.json(await this.sessionsService.list(req.context!)); };
  createSession: RequestHandler = async (req, res) => { res.status(201).json(await this.sessionsService.create(req.context!, createSessionRequestSchema.parse(req.body))); };
  getSession: RequestHandler = async (req, res) => { res.json(await this.sessionsService.get(req.context!, routeId(req.params.sessionId, 'sessionId'))); };
  connect: RequestHandler = async (req, res) => { await this.sessionsService.connect(req.context!, routeId(req.params.sessionId, 'sessionId'), connectSessionRequestSchema.parse(req.body ?? {}).forceQrRefresh); res.status(204).end(); };
  disconnect: RequestHandler = async (req, res) => { await this.sessionsService.disconnect(req.context!, routeId(req.params.sessionId, 'sessionId')); res.status(204).end(); };
  removeSession: RequestHandler = async (req, res) => { await this.sessionsService.remove(req.context!, routeId(req.params.sessionId, 'sessionId')); res.status(204).end(); };
  contacts: RequestHandler = async (req, res) => { res.json(await this.contactsService.list(req.context!, contactListQuerySchema.parse(req.query))); };
  templates: RequestHandler = async (req, res) => { res.json(await this.templatesService.list(req.context!)); };
  createTemplate: RequestHandler = async (req, res) => { await this.templatesService.create(req.context!, createTemplateRequestSchema.parse(req.body)); res.status(201).end(); };
  updateTemplate: RequestHandler = async (req, res) => { await this.templatesService.update(req.context!, routeId(req.params.templateId, 'templateId'), updateTemplateRequestSchema.parse(req.body)); res.status(204).end(); };
  removeTemplate: RequestHandler = async (req, res) => { await this.templatesService.remove(req.context!, routeId(req.params.templateId, 'templateId')); res.status(204).end(); };
}
