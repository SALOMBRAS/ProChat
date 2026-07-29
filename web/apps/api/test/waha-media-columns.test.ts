import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { SqliteWahaWebhookStore, SupabaseWahaWebhookStore, webhookRecord } from '../src/services/waha-webhook.service.js';

/**
 * As colunas dedicadas de mídia chegavam nulas enquanto o payload cru tinha o
 * dado. Medido na base de produção sobre 6.833 mensagens: `duration` nula em
 * 100%, `media_size` só preenchida pelo download posterior, `media_filename`
 * ausente em 59 de 77 documentos e `media_mime_type` nula em 1.270 das 2.350
 * mensagens de mídia.
 *
 * A causa é a forma do payload: `payload.media` só existe enquanto o arquivo
 * está baixável e carrega `url`, `filename`, `mimetype` e `error`, mais nada —
 * tamanho e duração nunca estiveram lá. Moram em `_data`, e chegam como texto de
 * dígitos.
 *
 * A extração é campo a campo, raiz primeiro e `_data` depois, e o `mime` que
 * decide `messageType` continua sendo só o da raiz. É o precedente da #57: dar
 * o vocabulário cru inteiro para a classificação reescreveria a maior parte da
 * base. SQLite e Supabase leem o mesmo `messageFrom`; os dois estão aqui porque
 * é na gravação que a paridade se quebra.
 */
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

const sqlite = () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-media-columns-')); directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), join(process.cwd(), 'migrations'));
  database.migrate();
  return { database, store: new SqliteWahaWebhookStore(database.sqlite) };
};

type MediaColumns = { messageType: string; mediaMimeType: string | null; mediaFilename: string | null; mediaSize: number | null; duration: number | null };
const event = (id: string, payload: Record<string, unknown>) => webhookRecord({ id: `evt-${id}`, timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id, chatId: '5511999990000@c.us', ...payload } }, 'workspace-a');

const ingestSqlite = async (id: string, payload: Record<string, unknown>): Promise<MediaColumns> => {
  const { database, store } = sqlite();
  await store.ingest(event(id, payload));
  return database.sqlite.prepare('SELECT messageType, mediaMimeType, mediaFilename, mediaSize, duration FROM whatsapp_messages WHERE externalMessageId = ?').get(id) as MediaColumns;
};

/** O Supabase não roda aqui; o que dá para prender é a linha que o store monta
 *  para o `insert` — que é onde a paridade com o SQLite se quebraria. */
const ingestSupabase = async (id: string, payload: Record<string, unknown>) => {
  const inserted: Record<string, Record<string, unknown>> = {};
  const client = {
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      const builder: Record<string, unknown> = {
        insert: async (row: Record<string, unknown>) => { inserted[table] = row; return { error: null }; },
        update: async () => ({ error: null, data: [], eq: () => builder }),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      for (const method of ['select', 'eq', 'in', 'is', 'not', 'neq', 'order', 'limit', 'range']) builder[method] = () => builder;
      // `update` é encadeado com `.eq(...)` antes de ser aguardado.
      builder.update = () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) });
      return builder;
    },
  };
  await new SupabaseWahaWebhookStore(client as never).ingest(event(id, payload));
  return inserted.whatsapp_messages;
};

/** Nota de voz real da base: sem objeto `media` porque o arquivo já não está
 *  baixável, com tudo em `_data` e os números serializados como texto. */
const voiceNote = { hasMedia: true, _data: { type: 'ptt', size: '7678', duration: '18', mimetype: 'audio/ogg; codecs=opus', waveform: { 0: 0, 1: 27 } } };
const document = { hasMedia: true, _data: { type: 'document', size: '98301', filename: 'Nota fiscal.pdf', mimetype: 'application/pdf', pageCount: 3 } };

describe('colunas de mídia preenchidas na ingestão', () => {
  it('SQLite: tira duração, tamanho e mime de _data quando a raiz não os tem', async () => {
    expect(await ingestSqlite('nota-de-voz', voiceNote)).toMatchObject({ duration: 18, mediaSize: 7678, mediaMimeType: 'audio/ogg; codecs=opus' });
  });

  it('SQLite: tira o nome do arquivo de _data.filename', async () => {
    expect(await ingestSqlite('documento', document)).toMatchObject({ mediaFilename: 'Nota fiscal.pdf', mediaSize: 98301, mediaMimeType: 'application/pdf' });
  });

  it('SQLite: a raiz vence _data em cada campo, um a um', async () => {
    const columns = await ingestSqlite('raiz-vence', {
      hasMedia: true, filename: 'da-raiz.pdf', mediaSize: 11, duration: 22,
      media: { mimetype: 'application/pdf', filename: 'do-media.pdf', filesize: 33 },
      _data: { type: 'document', size: '98301', duration: '18', filename: 'do-data.pdf', mimetype: 'image/jpeg' },
    });
    expect(columns).toMatchObject({ mediaMimeType: 'application/pdf', mediaFilename: 'do-media.pdf', mediaSize: 33, duration: 22 });
  });

  it('SQLite: o mime de _data preenche a coluna mas não reclassifica a mensagem', async () => {
    // Guarda do precedente da #57. Sem `media`, a classificação enxerga o que
    // sempre enxergou; simulado sobre os 6.833 payloads de produção, este
    // recorte reclassifica 0 linhas. Se o mime de `_data` alimentasse
    // `mediaType`, esta mensagem viraria 'image'.
    const columns = await ingestSqlite('sem-reclassificar', { hasMedia: true, _data: { type: 'image', mimetype: 'image/jpeg', size: '67479' } });
    expect(columns.mediaMimeType).toBe('image/jpeg');
    expect(columns.messageType).toBe('document');
  });

  it('SQLite: recusa texto que não é dígito puro em vez de virar zero', async () => {
    // `Number(' ')` é 0 e `Number('1e3')` é 1000; nenhum dos dois é tamanho de
    // arquivo, e um 0 gravado apareceria na tela como "0 B".
    expect(await ingestSqlite('lixo', { hasMedia: true, _data: { type: 'document', size: ' ', duration: '1e3' } })).toMatchObject({ mediaSize: null, duration: null });
  });

  it('SQLite: mensagem sem mídia não ganha coluna de mídia nenhuma', async () => {
    expect(await ingestSqlite('so-texto', { body: 'oi', _data: { type: 'chat' } })).toMatchObject({ messageType: 'text', mediaMimeType: null, mediaFilename: null, mediaSize: null, duration: null });
  });

  it('Supabase: grava as mesmas colunas que o SQLite, com os mesmos valores', async () => {
    expect(await ingestSupabase('nota-de-voz', voiceNote)).toMatchObject({ duration: 18, media_size: 7678, media_mime_type: 'audio/ogg; codecs=opus' });
    expect(await ingestSupabase('documento', document)).toMatchObject({ media_filename: 'Nota fiscal.pdf', media_size: 98301, media_mime_type: 'application/pdf' });
  });

  it('Supabase: a raiz vence _data, como no SQLite', async () => {
    const row = await ingestSupabase('raiz-vence', {
      hasMedia: true, filename: 'da-raiz.pdf', mediaSize: 11, duration: 22,
      media: { mimetype: 'application/pdf', filename: 'do-media.pdf', filesize: 33 },
      _data: { type: 'document', size: '98301', duration: '18', filename: 'do-data.pdf', mimetype: 'image/jpeg' },
    });
    expect(row).toMatchObject({ media_mime_type: 'application/pdf', media_filename: 'do-media.pdf', media_size: 33, duration: 22 });
  });

  it('Supabase: o mime de _data também não reclassifica a mensagem', async () => {
    const row = await ingestSupabase('sem-reclassificar', { hasMedia: true, _data: { type: 'image', mimetype: 'image/jpeg', size: '67479' } });
    expect(row).toMatchObject({ media_mime_type: 'image/jpeg', message_type: 'document' });
  });
});
