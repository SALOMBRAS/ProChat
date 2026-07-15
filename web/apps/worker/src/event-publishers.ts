import { validateEventEnvelope, type EventEnvelope } from '@chatpro/contracts';
import type { EventPublisherPort } from './ports.js';
import { log, type LogSink } from './logging.js';

export class InMemoryEventPublisherAdapter implements EventPublisherPort {
  readonly events: EventEnvelope[] = [];
  async publish(event: EventEnvelope): Promise<void> { this.events.push(validateEventEnvelope(event)); }
}

export class StructuredLogEventPublisherAdapter implements EventPublisherPort {
  constructor(private readonly logger: LogSink = log) {}
  async publish(event: EventEnvelope): Promise<void> {
    const valid = validateEventEnvelope(event);
    this.logger('info', 'Worker event published', { eventId: valid.eventId, eventType: valid.eventType, workspaceId: valid.workspaceId, correlationId: valid.correlationId });
  }
}
