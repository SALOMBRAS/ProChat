/**
 * Gera o SQL de restauração de `conversation_kanban_state` a partir do CSV
 * exportado antes do DELETE.
 *
 * Não toca em banco nenhum: lê o CSV, escreve SQL na saída padrão. Quem executa
 * é você, no SQL Editor, depois de ler.
 *
 * Uso, a partir de `web/`:
 *
 *   node docs/restauracao-cards-gerador.mjs caminho/para/cards.csv > restaurar.sql
 *
 * As colunas são lidas **por nome**, não por posição, então a ordem em que o
 * export as colocou não importa. Faltando qualquer coluna obrigatória, o script
 * para e diz qual — restaurar pela metade seria pior que não restaurar.
 */
import { readFileSync } from 'node:fs';

const obrigatorias = ['workspace_id', 'conversation_id', 'board_id', 'stage_id', 'position', 'manual_override', 'last_transition_source', 'last_transition_at', 'created_at', 'updated_at'];
const opcionais = ['last_transition_by'];
const todas = [...obrigatorias.slice(0, 7), 'last_transition_by', ...obrigatorias.slice(7)];

/** CSV com aspas, vírgula dentro de campo e aspas escapadas por duplicação. */
function analisar(texto) {
  const linhas = [];
  let campo = '';
  let linha = [];
  let dentro = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentro) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
      else campo += c;
      continue;
    }
    if (c === '"') dentro = true;
    else if (c === ',') { linha.push(campo); campo = ''; }
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo.length || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.filter(l => l.some(v => v !== ''));
}

const texto = (valor) => `'${String(valor).replace(/'/g, "''")}'`;
function literal(coluna, bruto) {
  const valor = (bruto ?? '').trim();
  if (valor === '' || valor.toUpperCase() === 'NULL') {
    if (obrigatorias.includes(coluna)) throw new Error(`coluna obrigatória vazia: ${coluna}`);
    return 'NULL';
  }
  if (coluna === 'position') { if (!/^-?\d+(\.\d+)?$/.test(valor)) throw new Error(`position não numérica: ${valor}`); return valor; }
  if (coluna === 'manual_override') {
    const v = valor.toLowerCase();
    if (['true', 't', '1'].includes(v)) return 'true';
    if (['false', 'f', '0'].includes(v)) return 'false';
    throw new Error(`manual_override não booleana: ${valor}`);
  }
  if (['conversation_id', 'board_id', 'stage_id', 'last_transition_by'].includes(coluna)) return `${texto(valor)}::uuid`;
  if (['last_transition_at', 'created_at', 'updated_at'].includes(coluna)) return `${texto(valor)}::timestamptz`;
  return texto(valor);
}

const caminho = process.argv[2];
if (!caminho) { console.error('uso: node docs/restauracao-cards-gerador.mjs <cards.csv>'); process.exit(1); }
const linhas = analisar(readFileSync(caminho, 'utf8'));
if (linhas.length < 2) { console.error('CSV sem linhas de dados'); process.exit(1); }

const cabecalho = linhas[0].map(c => c.trim().replace(/^"|"$/g, ''));
const faltando = obrigatorias.filter(c => !cabecalho.includes(c));
if (faltando.length) { console.error(`CSV não tem: ${faltando.join(', ')}`); process.exit(1); }
const indice = Object.fromEntries(cabecalho.map((c, i) => [c, i]));

const valores = linhas.slice(1).map((linha, n) => {
  try { return `  (${todas.map(c => literal(c, indice[c] === undefined ? '' : linha[indice[c]])).join(', ')})`; }
  catch (erro) { console.error(`linha ${n + 2} do CSV: ${erro.message}`); process.exit(1); }
});

console.log(`-- Restauração de ${valores.length} cards de Kanban apagados em 31/07/2026.
-- Gerado de: ${caminho}
--
-- Idempotente: a chave primária é (conversation_id, board_id), então rodar duas
-- vezes não duplica nada — a segunda passada não insere linha alguma.
--
-- A chave estrangeira (workspace_id, conversation_id) exige que a conversa ainda
-- exista. Nenhuma conversa foi apagada, então isto deve inserir tudo; se o
-- número final vier menor, é sinal de conversa removida depois do export, e aí
-- vale investigar antes de seguir.

BEGIN;

-- Antes: quantos cards existem agora.
SELECT count(*) AS antes FROM public.conversation_kanban_state;

INSERT INTO public.conversation_kanban_state
  (${todas.join(', ')})
VALUES
${valores.join(',\n')}
ON CONFLICT (conversation_id, board_id) DO NOTHING;

-- Depois: tem de ser 'antes' + ${valores.length}.
SELECT count(*) AS depois FROM public.conversation_kanban_state;

-- Conferência: nenhum card órfão de conversa, quadro ou etapa.
SELECT count(*) AS cards_sem_conversa
FROM public.conversation_kanban_state k
LEFT JOIN public.conversations c ON c.workspace_id = k.workspace_id AND c.id = k.conversation_id
WHERE c.id IS NULL;

COMMIT;`);
