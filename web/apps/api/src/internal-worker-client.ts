import { internalTransportResponseSchema, type InternalTransportCommand, type InternalTransportResponse } from '@chatpro/contracts';

export type InternalWorkerClientOptions = { url: string; timeoutMs: number; fetchImpl?: typeof fetch };
export class InternalWorkerClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: InternalWorkerClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }

  async send(input: { correlationId: string; workspaceId: string; command: InternalTransportCommand; timeoutMs?: number }): Promise<InternalTransportResponse> {
    const timeoutMs = input.timeoutMs ?? this.options.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(this.options.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, timeoutMs }), signal: controller.signal });
      const parsed = internalTransportResponseSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.correlationId !== input.correlationId || parsed.data.workspaceId !== input.workspaceId) return unavailable(input);
      return parsed.data;
    } catch (error) {
      return error instanceof DOMException && error.name === 'AbortError' ? failure(input, 'TIMEOUT', 'Internal worker command timed out') : unavailable(input);
    } finally { clearTimeout(timer); }
  }
}
function failure(input: { correlationId: string; workspaceId: string }, code: 'TIMEOUT' | 'SERVICE_UNAVAILABLE', message: string): InternalTransportResponse { return { success: false, correlationId: input.correlationId, workspaceId: input.workspaceId, error: { code, message, details: {} } }; }
function unavailable(input: { correlationId: string; workspaceId: string }): InternalTransportResponse { return failure(input, 'SERVICE_UNAVAILABLE', 'Internal worker is unavailable'); }
