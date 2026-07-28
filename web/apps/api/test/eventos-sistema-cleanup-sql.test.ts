import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTechnicalMessageType } from '../src/services/conversation-identity.js';

/**
 * docs/migrations-propostas-eventos-sistema.sql apaga mensagens por uma lista de tipos
 * técnicos escrita à mão em SQL. A mesma decisão vive em código, em
 * conversation-identity.ts (technicalMessageTypes), e é ela que impede novos casos.
 *
 * Se as duas listas divergirem, a limpeza apaga um conjunto diferente do que a ingestão
 * descarta: ou sobra lixo que o código considera técnico, ou some mensagem que o código
 * considera real — e esta segunda é irreversível fora do backup. Estes testes prendem as
 * duas pontas, e prendem também as correções que só apareceram ao rodar o SQL de verdade
 * num PostgreSQL 16 (ver o cabeçalho VALIDAÇÃO do arquivo .sql).
 */
const sql = readFileSync(
  join(process.cwd(), '..', '..', 'docs', 'migrations-propostas-eventos-sistema.sql'),
  'utf8',
);

/** Cada lista `IN (...)`/`NOT IN (...)` de tipos que aparece no arquivo.
 *  `e2e_notification` e `gp2` têm dígito: a classe precisa de [a-z0-9_]. */
const typeLists = () =>
  [...sql.matchAll(/(?:NOT\s+)?IN\s*\(\s*((?:'[a-z0-9_]+'\s*,\s*)+'[a-z0-9_]+')\s*\)/gi)].map(match =>
    match[1].split(',').map(value => value.trim().replace(/^'|'$/g, '')),
  );

/** Trecho de um passo, do banner que o abre até o banner do próximo. O marcador é
 *  buscado depois da linha de banner porque o cabeçalho do arquivo também cita
 *  "7) conversas órfãs" ao explicar a ordem obrigatória. */
const banner = `-- ${'-'.repeat(75)}\n`;
const step = (n: number) => {
  const start = sql.indexOf(`${banner}-- ${n}) `);
  expect(start, `passo ${n} ausente no SQL`).toBeGreaterThan(-1);
  const next = sql.indexOf(`${banner}-- ${n + 1}) `, start + banner.length);
  return sql.slice(start, next === -1 ? undefined : next);
};

describe('SQL de limpeza dos eventos de sistema', () => {
  it('usa exatamente o vocabulário técnico do código, em toda ocorrência', () => {
    const lists = typeLists();
    expect(lists.length, 'nenhuma lista de tipos encontrada no SQL').toBeGreaterThan(0);

    for (const list of lists) {
      // Toda lista é a mesma lista: uma divergente apagaria um conjunto diferente.
      expect(new Set(list).size, `lista com tipo repetido: ${list.join(',')}`).toBe(list.length);
      for (const type of list) expect(isTechnicalMessageType(type), `${type} não é técnico para o código`).toBe(true);
      expect(list.length, `lista incompleta: ${list.join(',')}`).toBe(lists[0].length);
      expect([...list].sort()).toEqual([...lists[0]].sort());
    }
  });

  it('não alcança call_log, que é decisão de produto e não de normalização', () => {
    expect(isTechnicalMessageType('call_log')).toBe(false);
    for (const list of typeLists()) expect(list).not.toContain('call_log');
  });

  it('lê o tipo real do payload, nunca a coluna message_type já normalizada', () => {
    // message_type só contém text/document/image/audio/video: classificar por ela
    // encontraria zero mensagem técnica e a limpeza não faria nada.
    expect(sql).toMatch(/payload_json->>'type'/);
    expect(sql).toMatch(/payload_json->'_data'->>'type'/);
    expect(sql).not.toMatch(/^\s*(?:--\s*)?(?:AND|WHERE)\s+lower\(m?\.?message_type\)/m);
  });

  it('mantém a ordem que a validação exigiu: backup, mensagens, estado operacional, conversas', () => {
    const order = ['-- 4) BACKUP', '-- 5) REMOÇÃO DAS MENSAGENS', '-- 6) REMOÇÃO DO ESTADO OPERACIONAL', '-- 7) REMOÇÃO DAS CONVERSAS'];
    const positions = order.map(marker => {
      const at = sql.indexOf(marker);
      expect(at, `marcador ausente: ${marker}`).toBeGreaterThan(-1);
      return at;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('limpa as três FKs que não são CASCADE antes de apagar a conversa', () => {
    // conversation_kanban_state e kanban_automation_deliveries são NO ACTION e
    // inbox_outbox_jobs é RESTRICT: sem estes DELETEs o passo 7 aborta.
    const operacional = step(6);
    for (const table of ['conversation_kanban_state', 'kanban_automation_deliveries', 'inbox_outbox_jobs'])
      expect(operacional, `passo 6 não limpa ${table}`).toMatch(new RegExp(`DELETE FROM public\\.${table}\\b`));
  });

  it('apaga conversa pela lista congelada no backup, não por condição recalculada', () => {
    // Uma condição "não tem mensagem" alcançaria também as 29 conversas que já
    // hoje estão vazias por outro motivo, e que ninguém conferiu.
    const conversas = step(7);
    expect(conversas).toMatch(/DELETE FROM public\.conversations c\s*\n--\s*USING backup_eventos_sistema\.alvo a/);
    expect(conversas).not.toMatch(/NOT EXISTS/);
  });

  it('restringe o ajuste de SLA às linhas ancoradas e sem acumulador', () => {
    const ajuste = step(8);
    // Sem o JOIN na lista do backup o UPDATE alcança toda linha viva.
    expect(ajuste).toMatch(/JOIN backup_eventos_sistema\.sla_ajustadas b/);
    // Sem o guard, uma linha com histórico acumulado seria reancorada por cima dele.
    for (const column of ['operator_waiting_ms', 'customer_waiting_ms', 'total_response_ms', 'response_count'])
      expect(ajuste, `guard ausente para ${column}`).toMatch(new RegExp(`b\\.${column} = 0`));
    expect(ajuste).toMatch(/s\.frozen_at IS NULL/);
  });

  it('filtra workspace_id em todo statement destrutivo', () => {
    // O DELETE de mensagens é o único que não passa pela tabela alvo, então
    // precisa do filtro explícito; os demais herdam o escopo do backup.
    expect(step(5)).toMatch(/WHERE workspace_id = 'default-workspace'/);
    expect(step(4)).toMatch(/WHERE workspace_id = 'default-workspace'/);
  });

  it('não toca em waha_webhook_events, que é o registro de auditoria', () => {
    const destrutivo = /(?:DELETE\s+FROM|UPDATE|TRUNCATE|DROP\s+TABLE)\s+(?:public\.)?waha_webhook_events/i;
    expect(sql).not.toMatch(destrutivo);
  });

  it('mantém todo statement destrutivo comentado: o arquivo é proposta, não script', () => {
    for (const line of sql.split('\n')) {
      if (/^\s*(DELETE|UPDATE|CREATE|DROP|TRUNCATE|ALTER)\b/i.test(line))
        expect.fail(`statement destrutivo descomentado: ${line.trim().slice(0, 80)}`);
    }
  });
});
