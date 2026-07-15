import { InternalWorkerClient } from '../apps/api/src/internal-worker-client.js';
import { listenInternalTransport } from '../apps/worker/src/internal-transport-server.js';

const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 });
try {
  const address = runtime.server.address();
  if (!address || typeof address === 'string') throw new Error('Internal transport did not bind to TCP');
  const client = new InternalWorkerClient({ url: `http://127.0.0.1:${address.port}/internal/transport`, timeoutMs: 500 });
  const result = await client.send({ correlationId: 'smoke-correlation', workspaceId: 'smoke-workspace', command: { type: 'transport.ping', payload: { message: 'smoke' } } });
  if (!result.success || result.data.message !== 'smoke') throw new Error('Internal transport smoke failed');
  process.stdout.write('Internal transport smoke passed without WhatsApp connection.\n');
} finally { await runtime.close(); }
