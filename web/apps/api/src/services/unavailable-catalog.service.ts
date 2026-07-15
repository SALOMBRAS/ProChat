import type { ContactServicePort, SessionServicePort, TemplateServicePort } from '../ports/catalog.ports.js';
import { AppError } from '../errors.js';
const unavailable = (): never => { throw new AppError(501, 'NOT_IMPLEMENTED', 'This legacy capability has not been migrated to the web platform'); };
export class UnavailableSessionService implements SessionServicePort {
  async list(): Promise<never> { return unavailable(); } async create(): Promise<never> { return unavailable(); } async get(): Promise<never> { return unavailable(); }
  async connect(): Promise<never> { return unavailable(); } async disconnect(): Promise<never> { return unavailable(); } async remove(): Promise<never> { return unavailable(); }
}
export class UnavailableContactService implements ContactServicePort {
  async list(): Promise<never> { return unavailable(); }
}
export class UnavailableTemplateService implements TemplateServicePort {
  async list(): Promise<never> { return unavailable(); } async create(): Promise<never> { return unavailable(); }
  async update(): Promise<never> { return unavailable(); }
  async remove(): Promise<never> { return unavailable(); }
}
