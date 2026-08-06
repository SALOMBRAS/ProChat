import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { SqliteWahaWebhookStore, SupabaseWahaWebhookStore } from '../src/services/waha-webhook.service.js';

/**
 * `importPending` e `repairStoredMime` chamam `persist` com o `messageType` que o
 * store devolver. Ele precisa ser o tipo REAL do WhatsApp, lido do payload —
 * nunca a coluna `message_type`, que é decidida por sniffing do mime e, quando o
 * mime é genérico (que é exatamente o caso que a normalização existe para
 * consertar), cai em 'document' e faz a normalização virar no-op.
 *
 * SQLite e Supabase têm que responder igual: a regra é a mesma, só muda a sintaxe
 * de extração (json_extract vs `->>`).
 */
const directories: string[] = [];
// No Windows o handle do SQLite segura o arquivo: fechar antes do rmSync.
const databases: SqlitePersistenceDatabase[] = [];
const sqlite = () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-media-type-')); directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), join(process.cwd(), 'migrations'));
  database.migrate(); databases.push(database);
  return { database, store: new SqliteWahaWebhookStore(database.sqlite) };
};
afterEach(() => { databases.splice(0).forEach(database => database.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

/** Uma mensagem de mídia como a ingestão a grava, com o tipo real só em `_data`. */
const insertMedia = (database: ReturnType<typeof sqlite>['database'], input: { id: string; payload: Record<string, unknown>; mime: string | null; storagePath?: string | null; messageTypeColumn: string }) => {
  database.sqlite.prepare("INSERT INTO waha_webhook_events (workspaceId, wahaSession, externalEventId, eventType, occurredAt, payloadJson, receivedAt) VALUES ('workspace-a','default',?,'message','2026-07-28T12:00:00.000Z','{}','2026-07-28T12:00:00.000Z')").run(`evt-${input.id}`);
  database.sqlite.prepare(`INSERT INTO whatsapp_messages (workspaceId, wahaSession, externalMessageId, externalEventId, chatId, direction, messageType, body, occurredAt, payloadJson, receivedAt, mediaUrl, mediaMimeType, mediaFilename, mediaStoragePath, mediaPersistenceStatus)
    VALUES ('workspace-a','default',?,?, '5511999990000@c.us','inbound',?,NULL,'2026-07-28T12:00:00.000Z',?,'2026-07-28T12:00:00.000Z','http://waha.test/api/files/media.bin',?,'arquivo',?,?)`)
    .run(input.id, `evt-${input.id}`, input.messageTypeColumn, JSON.stringify(input.payload), input.mime, input.storagePath ?? null, input.storagePath ? 'stored' : 'pending');
};

describe('tipo da mensagem que o store entrega para a persistência de mídia', () => {
  it('SQLite: pendingMedia resolve o tipo de _data.type', async () => {
    const { database, store } = sqlite();
    insertMedia(database, { id: 'nota-de-voz', payload: { _data: { type: 'ptt' } }, mime: null, messageTypeColumn: 'document' });
    const [pending] = await store.pendingMedia(10);
    // A coluna diz 'document'; o payload diz 'ptt', e é o payload que vale.
    expect(pending).toMatchObject({ externalMessageId: 'nota-de-voz', messageType: 'ptt' });
  });

  it('SQLite: pendingMedia lê a raiz primeiro, para o envio pelo Inbox', async () => {
    const { database, store } = sqlite();
    insertMedia(database, { id: 'envio-inbox', payload: { type: 'image' }, mime: null, messageTypeColumn: 'image' });
    expect((await store.pendingMedia(10))[0]).toMatchObject({ messageType: 'image' });
  });

  it('SQLite: pendingMedia devolve null quando o payload não tem tipo', async () => {
    const { database, store } = sqlite();
    insertMedia(database, { id: 'sem-tipo', payload: { hasMedia: true }, mime: null, messageTypeColumn: 'document' });
    expect((await store.pendingMedia(10))[0]).toMatchObject({ messageType: null });
  });

  it('SQLite: storedMediaWithGenericMime resolve o tipo do payload, não da coluna', async () => {
    const { database, store } = sqlite();
    insertMedia(database, { id: 'video-generico', payload: { _data: { type: 'video' } }, mime: 'application/octet-stream', storagePath: 'workspace-a/abc/arquivo', messageTypeColumn: 'document' });
    const [stored] = await store.storedMediaWithGenericMime(10);
    expect(stored).toMatchObject({ externalMessageId: 'video-generico', storagePath: 'workspace-a/abc/arquivo', messageType: 'video' });
  });

  it('SQLite: storedMediaWithGenericMime ignora mídia com content-type específico', async () => {
    const { database, store } = sqlite();
    insertMedia(database, { id: 'ok', payload: { _data: { type: 'image' } }, mime: 'image/jpeg', storagePath: 'workspace-a/abc/foto', messageTypeColumn: 'image' });
    expect(await store.storedMediaWithGenericMime(10)).toHaveLength(0);
  });

  // O Supabase não roda aqui; o que dá para prender é a consulta que ele monta e
  // o mapeamento da resposta — que é onde a paridade com o SQLite se quebra.
  const supabase = (rows: Array<Record<string, unknown>>) => {
    const calls: string[] = [];
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'not', 'is', 'neq', 'in']) builder[method] = (...args: unknown[]) => { if (method === 'select') calls.push(String(args[0])); return builder; };
    builder.limit = async () => ({ data: rows, error: null });
    return { store: new SupabaseWahaWebhookStore({ from: () => builder } as never), calls };
  };

  it('Supabase: pendingMedia extrai o tipo do payload_json e resolve igual ao SQLite', async () => {
    const { store, calls } = supabase([{ workspace_id: 'workspace-a', external_message_id: 'nota-de-voz', media_url: 'http://waha.test/api/files/media.bin', media_mime_type: null, media_filename: 'arquivo', root_type: null, data_type: 'ptt' }]);
    const [pending] = await store.pendingMedia(10);
    expect(calls[0]).toContain('payload_json->>type');
    expect(calls[0]).toContain('payload_json->_data->>type');
    expect(pending).toMatchObject({ externalMessageId: 'nota-de-voz', messageType: 'ptt' });
  });

  it('Supabase: storedMediaWithGenericMime não usa mais a coluna message_type', async () => {
    const { store, calls } = supabase([{ workspace_id: 'workspace-a', external_message_id: 'video-generico', media_storage_path: 'workspace-a/abc/arquivo', media_mime_type: 'application/octet-stream', root_type: null, data_type: 'video' }]);
    const [stored] = await store.storedMediaWithGenericMime(10);
    expect(calls[0]).not.toMatch(/(^|,)\s*message_type\s*(,|$)/);
    expect(stored).toMatchObject({ messageType: 'video' });
  });

  it('Supabase: a raiz vence, como no SQLite', async () => {
    const { store } = supabase([{ workspace_id: 'workspace-a', external_message_id: 'envio-inbox', media_url: 'http://waha.test/api/files/media.bin', media_mime_type: null, media_filename: 'anexo', root_type: 'image', data_type: 'video' }]);
    expect((await store.pendingMedia(10))[0]).toMatchObject({ messageType: 'image' });
  });
});
