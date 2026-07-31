import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * docs/migrations-propostas-sessao-inativa.sql é proposta, não migration: ele
 * apaga cards de Kanban e nada o aplica automaticamente. O que estes testes
 * prendem é a forma que torna a proposta segura de revisar — conferência
 * executável, remoção comentada — porque é fácil descomentar o DELETE ao editar
 * o arquivo e não é possível desfazê-lo sem backup.
 *
 * A lista de sessões vivas não está no banco e por isso não pode ser prendida
 * aqui: ela vem da WAHA no momento de rodar. O que dá para prender é que o
 * arquivo continue exigindo a substituição.
 */
const sql = readFileSync(join(process.cwd(), '..', '..', 'docs', 'migrations-propostas-sessao-inativa.sql'), 'utf8');
const uncommented = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('proposta SQL para os cards de sessão inativa', () => {
  it('deixa a conferência executável', () => {
    expect(uncommented).toMatch(/SELECT[\s\S]*FROM public\.conversations/i);
    expect(uncommented).toMatch(/FROM public\.conversation_kanban_state/i);
  });

  it('mantém toda escrita comentada', () => {
    expect(uncommented).not.toMatch(/\b(DELETE|UPDATE|INSERT|ALTER|DROP|TRUNCATE)\b/i);
    expect(sql).toMatch(/^--\s*DELETE FROM public\.conversation_kanban_state/m);
  });

  // Rodar com a lista de exemplo apagaria os cards da sessão que está viva
  // justamente naquele momento. O aviso é o que separa copiar de conferir.
  it('exige a substituição da lista de sessões vivas em cada passo que a usa', () => {
    const passos = sql.split('\n').filter(line => line.includes("'chatpro-"));
    expect(passos.length).toBeGreaterThanOrEqual(2);
    for (const passo of passos) expect(passo).toContain('SUBSTITUA');
  });

  // O tratamento escolhido foi marcar, não esconder: a proposta tira o card do
  // board e não pode tirar a conversa, a mensagem ou o contato.
  it('a única remoção proposta é a de card, e a migração de sessão fica de fora', () => {
    const removals = [...sql.matchAll(/DELETE FROM public\.(\w+)/gi)].map(match => match[1]);
    expect(removals).toEqual(['conversation_kanban_state']);
    // Reapontar waha_session colide com a chave única em 62 chats; o arquivo
    // precisa dizer isso, senão vira a próxima ideia de quem for executá-lo.
    expect(sql).toMatch(/NÃO PROPOSTO/);
    expect(sql).toMatch(/UPDATE conversations SET\s*\n?--\s*waha_session|UPDATE conversations SET\s+waha_session/);
  });
});
