#!/usr/bin/env node
// =====================================================================
// Verificação de M1 e M2 — SQLite
// =====================================================================
// Rode DEPOIS de aplicar 022_contact_block.sql e 023_contact_soft_delete.sql.
//
//   cd web && node docs/migrations-m1-m2-verificacao.mjs
//   cd web && node docs/migrations-m1-m2-verificacao.mjs --fresh
//
// Sem --fresh: usa o banco de CHATPRO_DATABASE_PATH. Rode DEPOIS de aplicar,
// para validar o banco de verdade.
// Com --fresh: cria um banco novo em tmp, aplica apps/api/migrations e, se as
// migrations 021/022 ainda não existirem lá, EXTRAI as seções "M1 / SQLite" e
// "M2 / SQLite" de migrations-propostas-contatos.sql e aplica. Assim o SQL pode
// ser validado ANTES de virar migration, sem tocar em banco nenhum.
//
// Saída: exit 0 se tudo passar, 1 se algo falhar.
// Procedimento em migrations-m1-m2-aplicacao.md.
// =====================================================================

import { readdirSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const require = createRequire(join(WEB, 'package.json'));
const Database = require('better-sqlite3');

const FRESH = process.argv.includes('--fresh');
const WS = '__verify_m1m2__';

let pass = 0, fail = 0, skip = 0;
const ok = (m) => { console.log(`  \x1b[32mPASS\x1b[0m ${m}`); pass++; };
const no = (m, e) => { console.log(`  \x1b[31mFAIL\x1b[0m ${m}${e ? ` — ${e}` : ''}`); fail++; };
const sk = (m) => { console.log(`  \x1b[33mSKIP\x1b[0m ${m}`); skip++; };
const sec = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
// espera que `fn` lance, e que a mensagem case com `re`
const throws = (label, fn, re) => {
  try { fn(); no(`${label} — deveria ter falhado e passou`); }
  catch (e) { re.test(e.message) ? ok(`${label} (${e.message})`) : no(label, `erro inesperado: ${e.message}`); }
};

// Extrai uma seção do arquivo de proposta ("-- M1 / SQLite" até o próximo marcador).
function secaoDaProposta(migration) {
  const src = readFileSync(resolve(HERE, 'migrations-propostas-contatos.sql'), 'utf8').split('\n');
  const marcador = /^-- (M[123]) \/ (SQLite|Supabase|ROLLBACK)/;
  const inicio = src.findIndex((l) => l.startsWith(`-- ${migration} / SQLite`));
  if (inicio < 0) throw new Error(`seção "${migration} / SQLite" não encontrada na proposta`);
  const resto = src.slice(inicio + 1).findIndex((l) => marcador.test(l));
  return src.slice(inicio, resto < 0 ? undefined : inicio + 1 + resto).join('\n');
}

let db, tmp;
if (FRESH) {
  tmp = mkdtempSync(join(tmpdir(), 'verify-m1m2-'));
  db = new Database(join(tmp, 'fresh.sqlite'));
  db.pragma('foreign_keys = ON');
  const dir = resolve(WEB, 'apps/api/migrations');
  // Mesmo filtro de apps/api/src/persistence/database.ts:30. Este runner é uma
  // terceira cópia da regra — a correção da #91 pegou o de produção e o do teste
  // e deixou este de fora, e ele quebrou em `no such column: "chatsTotal"`:
  // ordenado, `021_x.rollback.sql` vem ANTES de `021_x.sql`, então o rollback
  // roda primeiro, num banco onde a coluna ainda não existe.
  const arquivos = readdirSync(dir).filter((f) => f.endsWith('.sql') && !f.endsWith('.rollback.sql')).sort();
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)');
  const marcar = db.prepare('INSERT OR IGNORE INTO schema_migrations (id, appliedAt) VALUES (?, ?)');
  for (const f of arquivos)
    db.transaction(() => { db.exec(readFileSync(resolve(dir, f), 'utf8')); marcar.run(f, new Date().toISOString()); })();
  console.log(`Banco novo em ${tmp} — ${arquivos.length} migrations de apps/api/migrations`);

  // Se M1/M2 ainda não viraram migration, aplica direto da proposta.
  for (const [mig, arquivo] of [['M1', '022_contact_block.sql'], ['M2', '023_contact_soft_delete.sql']]) {
    if (arquivos.includes(arquivo)) continue;
    db.transaction(() => { db.exec(secaoDaProposta(mig)); marcar.run(arquivo, new Date().toISOString()); })();
    console.log(`  + ${mig} aplicada a partir de migrations-propostas-contatos.sql (ainda não é migration)`);
  }
} else {
  const path = process.env.CHATPRO_DATABASE_PATH ?? resolve(WEB, '../.chatpro-data/backend.sqlite');
  if (!existsSync(path)) {
    console.error(`Banco não encontrado: ${path}\nDefina CHATPRO_DATABASE_PATH ou rode com --fresh.`);
    process.exit(1);
  }
  db = new Database(path);
  db.pragma('foreign_keys = ON');
  console.log(`Banco: ${path}`);
}

const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const has = (type, name) => db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type=? AND name=?`).get(type, name).c === 1;
const now = new Date().toISOString();

// ------------------------------------------------------------ 1. estrutura M1
sec('1. M1 — colunas, índices e tabela');
for (const c of ['blockState', 'blockPropagation', 'blockRequestedAt', 'blockConfirmedAt', 'blockLastErrorSafe'])
  cols('contacts').includes(c) ? ok(`contacts.${c}`) : no(`contacts.${c} ausente`);
cols('conversations').includes('blockedAt') ? ok('conversations.blockedAt') : no('conversations.blockedAt ausente');
has('table', 'contact_block_events') ? ok('contact_block_events') : no('contact_block_events ausente');
has('index', 'idx_contacts_block_state') ? ok('idx_contacts_block_state') : no('idx_contacts_block_state ausente');
has('index', 'idx_conversations_blocked') ? ok('idx_conversations_blocked') : no('idx_conversations_blocked ausente');

sec('2. M2 — coluna, índice e tabela');
cols('contacts').includes('deletedAt') ? ok('contacts.deletedAt') : no('contacts.deletedAt ausente');
has('table', 'contact_deletion_log') ? ok('contact_deletion_log') : no('contact_deletion_log ausente');
has('index', 'idx_contacts_workspace_created_active') ? ok('idx_contacts_workspace_created_active') : no('índice parcial ausente');
has('index', 'idx_contacts_workspace_created') ? ok('idx_contacts_workspace_created (original) preservado') : no('índice original sumiu');

if (fail) { console.log('\n\x1b[31mEstrutura incompleta — as migrations não foram aplicadas. Parando.\x1b[0m'); process.exit(1); }

// -------------------------------------------------- 3. migrations registradas
sec('3. Migrations registradas no runner');
for (const id of ['022_contact_block.sql', '023_contact_soft_delete.sql']) {
  const n = db.prepare('SELECT count(*) c FROM schema_migrations WHERE id=?').get(id).c;
  n === 1 ? ok(`${id} registrada`) : no(`${id} não registrada — o runner vai tentar reaplicar`);
}

// ---------------------------------------------------- 4. dados não alterados
sec('4. Nenhum dado existente foi alterado');
const estados = db.prepare(`SELECT blockState, count(*) c FROM contacts WHERE workspaceId <> ? GROUP BY 1`).all(WS);
const foraDeActive = estados.filter((r) => r.blockState !== 'active').reduce((a, r) => a + r.c, 0);
foraDeActive === 0
  ? ok(`todos os ${estados.reduce((a, r) => a + r.c, 0)} contatos existentes em blockState='active'`)
  : sk(`${foraDeActive} contatos fora de 'active' — esperado se você já bloqueou alguém`);
const del = db.prepare(`SELECT count(*) c FROM contacts WHERE deletedAt IS NOT NULL AND workspaceId <> ?`).get(WS).c;
del === 0 ? ok('nenhum contato soft-deleted') : sk(`${del} contatos soft-deleted — esperado se já usou a funcionalidade`);

// ------------------------------------------------------------------- setup
sec('5. Setup do workspace de teste');
const limpar = () => {
  db.exec(`DELETE FROM conversations WHERE workspaceId='${WS}'`);
  db.exec(`DELETE FROM contact_deletion_log WHERE workspaceId='${WS}'`);
  db.exec(`DELETE FROM contact_block_events WHERE workspaceId='${WS}'`);
  db.exec(`DELETE FROM contacts WHERE workspaceId='${WS}'`);
};
try {
  limpar();
  db.exec(`INSERT INTO contacts (id,workspaceId,displayName,phoneNumber,createdAt,updatedAt)
           VALUES ('v1','${WS}','Verificacao','+000000000001','${now}','${now}')`);
  db.exec(`INSERT INTO conversations (id,workspaceId,wahaSession,chatId,contactId,status,lastMessageAt,unreadCount,createdAt,updatedAt)
           VALUES ('vc1','${WS}','verify','+000000000001@c.us','v1','open','${now}',0,'${now}','${now}')`);
  ok('contato e conversa de teste criados');
} catch (e) { no('setup', e.message); process.exit(1); }

// -------------------------------------------------------------- 6. CHECKs
sec('6. CHECKs impõem a máquina de estados');
throws('blockState inválido recusado',
  () => db.exec(`UPDATE contacts SET blockState='invalido' WHERE workspaceId='${WS}' AND id='v1'`),
  /CHECK constraint failed/);
throws('blockPropagation inválido recusado',
  () => db.exec(`UPDATE contacts SET blockPropagation='invalido' WHERE workspaceId='${WS}' AND id='v1'`),
  /CHECK constraint failed/);
try {
  db.exec(`UPDATE contacts SET blockState='blocking', blockPropagation='pending', blockRequestedAt='${now}' WHERE workspaceId='${WS}' AND id='v1'`);
  const r = db.prepare(`SELECT blockState, blockPropagation FROM contacts WHERE workspaceId=? AND id='v1'`).get(WS);
  r.blockState === 'blocking' && r.blockPropagation === 'pending' ? ok('transição válida aceita') : no(`estado inesperado ${JSON.stringify(r)}`);
} catch (e) { no('transição válida', e.message); }

sec('7. Auditoria de bloqueio');
try {
  db.exec(`INSERT INTO contact_block_events (id,workspaceId,contactId,action,outcome,occurredAt,createdAt)
           VALUES ('ev1','${WS}','v1','block','requested','${now}','${now}')`);
  ok('evento de bloqueio aceito');
} catch (e) { no('inserir evento', e.message); }
throws('outcome inválido recusado',
  () => db.exec(`INSERT INTO contact_block_events (id,workspaceId,contactId,action,outcome,occurredAt,createdAt)
                 VALUES ('ev2','${WS}','v1','block','banana','${now}','${now}')`),
  /CHECK constraint failed/);

// -------------------------------------------------- 8. índice parcial é usado
sec('8. Índice parcial é realmente usado');
const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM contacts WHERE workspaceId=? AND blockState <> 'active'`).all(WS);
JSON.stringify(plan).includes('idx_contacts_block_state')
  ? ok("idx_contacts_block_state usado com <> (escreva o predicado assim, não com IN)")
  : no(`índice parcial não usado: ${JSON.stringify(plan)}`);

// ------------------------------------------------------------- 9. INSERT
sec('9. INSERT nomeado sobrevive ao ADD COLUMN');
try {
  db.exec(`INSERT INTO contacts (id,workspaceId,displayName,phoneNumber,createdAt,updatedAt)
           VALUES ('v3','${WS}','Nomeado','+000000000003','${now}','${now}')`);
  ok('INSERT com colunas nomeadas funciona');
} catch (e) { no('INSERT nomeado', e.message); }
throws('INSERT posicional quebra, como esperado',
  () => db.exec(`INSERT INTO contacts VALUES ('v4','${WS}','Pos','+000000000004',NULL,NULL,'${now}','${now}')`),
  /values were supplied/);

// --------------------------------------------------------- 10. soft delete
sec('10. Soft delete');
try {
  db.exec(`UPDATE contacts SET deletedAt='${now}' WHERE workspaceId='${WS}' AND id='v1'`);
  ok('deletedAt marcado');
  const c = db.prepare(`SELECT contactId FROM conversations WHERE workspaceId=? AND id='vc1'`).get(WS);
  c.contactId === 'v1' ? ok('conversa PRESERVA o vínculo (FK não dispara)') : no(`vínculo virou ${c.contactId}`);
} catch (e) { no('soft delete', e.message); }

try {
  db.exec(`INSERT INTO contact_deletion_log (id,workspaceId,contactId,mode,actorUserId,affectedJson,occurredAt,createdAt)
           VALUES ('dl1','${WS}','v1','soft','verify-user','{"contactSoftDeleted":1}','${now}','${now}')`);
  ok('log de exclusão aceito');
} catch (e) { no('log de exclusão', e.message); }
throws('affectedJson não-objeto recusado',
  () => db.exec(`INSERT INTO contact_deletion_log (id,workspaceId,contactId,mode,affectedJson,occurredAt,createdAt)
                 VALUES ('dl2','${WS}','v1','soft','nao-e-json','${now}','${now}')`),
  /CHECK constraint failed/);
throws('mode inválido recusado',
  () => db.exec(`INSERT INTO contact_deletion_log (id,workspaceId,contactId,mode,affectedJson,occurredAt,createdAt)
                 VALUES ('dl3','${WS}','v1','banana','{}','${now}','${now}')`),
  /CHECK constraint failed/);

sec('11. Telefone continua ocupado após soft delete');
throws('recadastro do mesmo telefone é recusado (comportamento conhecido)',
  () => db.exec(`INSERT INTO contacts (id,workspaceId,displayName,phoneNumber,createdAt,updatedAt)
                 VALUES ('v5','${WS}','Recadastro','+000000000001','${now}','${now}')`),
  /UNIQUE constraint failed/);

sec('12. Listagem ativa usa o índice parcial');
const plan2 = db.prepare(
  `EXPLAIN QUERY PLAN SELECT id FROM contacts WHERE workspaceId=? AND deletedAt IS NULL ORDER BY createdAt DESC LIMIT 25`
).all(WS);
/idx_contacts_workspace_created/.test(JSON.stringify(plan2))
  ? ok('listagem de ativos usa índice (sem varredura)')
  : no(`listagem sem índice: ${JSON.stringify(plan2)}`);

// ---------------------------------------------------------------- limpeza
sec('13. Limpeza');
try { limpar(); ok('workspace de teste removido'); } catch (e) { no('limpeza', e.message); }

console.log(`\n\x1b[1m${pass} passaram, ${fail} falharam, ${skip} pulados\x1b[0m`);
if (!FRESH) console.log('Dica: rode com --fresh para validar o SQL num banco novo, sem tocar neste.');
db.close();
if (tmp) rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
