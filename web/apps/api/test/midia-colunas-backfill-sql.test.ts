import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { SqliteWahaWebhookStore, webhookRecord } from '../src/services/waha-webhook.service.js';

/**
 * docs/migrations-propostas-midia-colunas.sql preenche colunas de mídia já
 * gravadas nulas copiando o que está no payload_json da própria linha. A mesma
 * decisão vive em código, em waha-webhook.service.ts (messageFrom), e é ela que
 * impede novos casos.
 *
 * Se as duas divergirem, a base fica com duas verdades: a linha antiga
 * preenchida por uma regra e a nova por outra, na mesma coluna e sem como
 * distinguir. Estes testes prendem as duas pontas — o último compara o resultado
 * do backfill com o da ingestão sobre o MESMO payload e exige igualdade.
 *
 * O SQL roda de verdade aqui, contra o schema do repositório. É o que dá para
 * provar sem escrever em produção: a parte PostgreSQL do arquivo tem a mesma
 * estrutura e os mesmos guardas, statement a statement, mas não é executada.
 */
const sql = readFileSync(join(process.cwd(), '..', '..', 'docs', 'migrations-propostas-midia-colunas.sql'), 'utf8');

const section = (from: string, to: string) => {
  const start = sql.indexOf(from);
  expect(start, `trecho ${from} ausente no SQL`).toBeGreaterThan(-1);
  const end = sql.indexOf(to, start);
  return sql.slice(start, end === -1 ? undefined : end);
};
/** As linhas vivas de um trecho: o que não é comentário. */
const live = (block: string) => block.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n').trim();
/** As linhas comentadas de um trecho, prontas para rodar. É assim que o UPDATE
 *  sai do arquivo sem nunca ter estado liberado nele. */
const uncommented = (block: string) => block.split('\n').filter(line => /^-- /.test(line) || line.trim() === '--').map(line => line.replace(/^-- ?/, '')).join('\n');

const conferenciaSqlite = live(section('-- A3) SQLite local', '-- A4) SQLite local'));
const backfillSqlite = uncommented(section('-- A4) SQLite local', '-- ###'))
  .split('\n').filter(line => /^(UPDATE|SET|WHERE|AND|BEGIN|COMMIT|\s)/.test(line) || line.trim() === '').join('\n');

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

const database = () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-backfill-sql-')); directories.push(directory);
  const persistence = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), join(process.cwd(), 'migrations'));
  persistence.migrate();
  return persistence;
};

type Columns = { messageType: string; mediaMimeType: string | null; mediaFilename: string | null; mediaSize: number | null; duration: number | null };
const columnsOf = (persistence: SqlitePersistenceDatabase, id: string) =>
  persistence.sqlite.prepare('SELECT messageType, mediaMimeType, mediaFilename, mediaSize, duration FROM whatsapp_messages WHERE externalMessageId = ?').get(id) as Columns;

/** Uma linha como a ingestão antiga a deixou: payload inteiro, colunas nulas. */
const seed = (persistence: SqlitePersistenceDatabase, id: string, payload: Record<string, unknown>, columns: Partial<Columns> = {}) => {
  persistence.sqlite.prepare("INSERT INTO waha_webhook_events (workspaceId, wahaSession, externalEventId, eventType, occurredAt, payloadJson, receivedAt) VALUES ('workspace-a','waha-a',?,'message','2026-07-29T12:00:00.000Z','{}','2026-07-29T12:00:00.000Z')").run(`evt-${id}`);
  persistence.sqlite.prepare(`INSERT INTO whatsapp_messages (workspaceId, wahaSession, externalMessageId, externalEventId, chatId, direction, messageType, body, occurredAt, payloadJson, receivedAt, mediaMimeType, mediaFilename, mediaSize, duration)
    VALUES ('workspace-a','waha-a',?,?,'5511999990000@c.us','inbound',?,NULL,'2026-07-29T12:00:00.000Z',?,'2026-07-29T12:00:00.000Z',?,?,?,?)`)
    .run(id, `evt-${id}`, columns.messageType ?? 'document', JSON.stringify(payload), columns.mediaMimeType ?? null, columns.mediaFilename ?? null, columns.mediaSize ?? null, columns.duration ?? null);
};

const voiceNote = { id: 'nota', chatId: '5511999990000@c.us', hasMedia: true, _data: { type: 'ptt', size: '7678', duration: '18', mimetype: 'audio/ogg; codecs=opus' } };

describe('SQL de backfill das colunas de mídia', () => {
  it('a conferência conta exatamente as linhas que o backfill vai tocar', () => {
    const persistence = database();
    seed(persistence, 'nota', voiceNote);
    seed(persistence, 'documento', { _data: { type: 'document', size: '98301', filename: 'Nota fiscal.pdf', mimetype: 'application/pdf' } });
    seed(persistence, 'ja-preenchida', { _data: { type: 'ptt', size: '111', duration: '9', mimetype: 'audio/ogg' } }, { mediaSize: 222, duration: 33, mediaMimeType: 'audio/ogg', mediaFilename: 'audio' });
    seed(persistence, 'sem-nada', { _data: { type: 'chat' } });
    expect(persistence.sqlite.prepare(conferenciaSqlite).get()).toEqual({
      duration_a_preencher: 1, media_size_a_preencher: 2, media_filename_a_preencher: 1, media_mime_type_a_preencher: 2,
    });
  });

  it('o backfill preenche o que estava nulo e não encosta no que já tinha valor', () => {
    const persistence = database();
    seed(persistence, 'nota', voiceNote);
    seed(persistence, 'ja-preenchida', { _data: { type: 'ptt', size: '111', duration: '9', mimetype: 'audio/mpeg' } }, { mediaSize: 222, duration: 33, mediaMimeType: 'audio/ogg', mediaFilename: 'audio' });
    persistence.sqlite.exec(backfillSqlite);
    expect(columnsOf(persistence, 'nota')).toMatchObject({ duration: 18, mediaSize: 7678, mediaMimeType: 'audio/ogg; codecs=opus' });
    // O que o worker gravou ao baixar o arquivo vence: o backfill só olha nulo.
    expect(columnsOf(persistence, 'ja-preenchida')).toMatchObject({ duration: 33, mediaSize: 222, mediaMimeType: 'audio/ogg', mediaFilename: 'audio' });
  });

  it('o backfill recusa texto que não é dígito puro em vez de gravar zero', () => {
    const persistence = database();
    seed(persistence, 'lixo', { _data: { type: 'document', size: ' ', duration: '1e3' } });
    seed(persistence, 'negativo', { _data: { type: 'document', size: '-5', duration: '2.5' } });
    persistence.sqlite.exec(backfillSqlite);
    expect(columnsOf(persistence, 'lixo')).toMatchObject({ mediaSize: null, duration: null });
    expect(columnsOf(persistence, 'negativo')).toMatchObject({ mediaSize: null, duration: null });
  });

  it('backfill e ingestão chegam ao mesmo valor para o mesmo payload', async () => {
    // A invariante que impede duas verdades na mesma coluna: a linha antiga
    // corrigida pelo SQL tem de ficar idêntica à linha nova gravada pelo código.
    for (const payload of [
      voiceNote,
      { id: 'x', chatId: '5511999990000@c.us', hasMedia: true, _data: { type: 'document', size: '98301', filename: 'Nota fiscal.pdf', mimetype: 'application/pdf' } },
      { id: 'x', chatId: '5511999990000@c.us', hasMedia: true, _data: { type: 'video', size: '2621440', duration: '12', mimetype: 'video/mp4' } },
      { id: 'x', chatId: '5511999990000@c.us', hasMedia: true, media: { mimetype: 'application/pdf', filename: 'do-media.pdf' }, _data: { type: 'document', size: '98301', filename: 'do-data.pdf', mimetype: 'image/jpeg' } },
    ]) {
      const ingested = database();
      await new SqliteWahaWebhookStore(ingested.sqlite).ingest(webhookRecord({ id: 'evt-novo', timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { ...payload, id: 'novo' } }, 'workspace-a'));

      const backfilled = database();
      seed(backfilled, 'antigo', { ...payload, id: 'antigo' }, { messageType: columnsOf(ingested, 'novo').messageType });
      backfilled.sqlite.exec(backfillSqlite);

      expect(columnsOf(backfilled, 'antigo')).toEqual(columnsOf(ingested, 'novo'));
    }
  });

  it('o arquivo mantém o UPDATE comentado e a conferência liberada', () => {
    // Se alguém liberar o UPDATE no arquivo, este teste cai: o arquivo é uma
    // proposta e roda em produção só por decisão de quem opera.
    expect(live(section('-- A2) Supabase', '-- A3) SQLite'))).toBe('');
    expect(live(section('-- A4) SQLite', '-- ###'))).toBe('');
    expect(live(section('-- PARTE B', '')).replace(/\s/g, '')).toBe('');
    expect(live(section('-- A1) Supabase', '-- A2) Supabase'))).toContain('SELECT');
    expect(conferenciaSqlite).toContain('SELECT');
  });
});
