// Cura LID v3 — vincula LID ↔ número e funde chats/contatos separados.
// Idempotente: relançar completa o que faltar. Grava backup das linhas
// afetadas ANTES de escrever (arquivo cura-lids-v3-backup-*.json na raiz).
//
// Uso:  node scripts/cura-lids-v3.mjs          → simulação (não escreve)
//       node scripts/cura-lids-v3.mjs --apply  → aplica
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const env = Object.fromEntries(readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const W = env.WAHA_WEBHOOK_WORKSPACE_ID;
const WAHA = env.WAHA_BASE_URL?.replace(/\/+$/, '');
const KEY = env.WAHA_API_KEY;
const now = () => new Date().toISOString();

const stats = { identitiesCorrigidas: 0, conversasFundidas: 0, mensagensMovidas: 0, contatosFundidos: 0, contatosSemMapa: 0, pendenciasLimpas: 0 };
const relatorio = { fundidas: [], semMapa: [] };
const backup = { conversations: [], contacts: [], contact_identifiers: [], whatsapp_identities: [], pending: [] };

async function waha(path) {
  const r = await fetch(`${WAHA}${path}`, { headers: { 'X-Api-Key': KEY } });
  if (!r.ok) throw new Error(`WAHA ${path} -> ${r.status}`);
  return r.json();
}
async function fetchAll(query) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query.range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) return out;
  }
}
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, (i + 1) * n));
async function pool(tasks, size = 20) { for (const lote of chunks(tasks, size)) await Promise.all(lote.map(fn => fn())); }

// ---------- 1) mapa LID -> PN da WAHA viva ----------
const sessions = (await waha('/api/sessions?all=true')).filter(s => s.status === 'WORKING').map(s => s.name);
console.log('sessões WAHA ativas:', sessions.join(', ') || '(nenhuma)');
const lidPn = new Map();
for (const s of sessions) {
  for (let offset = 0; ; offset += 500) {
    const page = await waha(`/api/${encodeURIComponent(s)}/lids?limit=500&offset=${offset}`).catch(() => []);
    const items = Array.isArray(page) ? page : [];
    for (const it of items) {
      const lid = String(it.lid ?? '').split('@')[0].replace(/\D/g, '');
      const pn = String(it.pn ?? '').split('@')[0].replace(/\D/g, '');
      if (lid && pn) lidPn.set(lid, { pnDigits: pn, session: s });
    }
    if (items.length < 500) break;
  }
}
console.log('mapa LID→PN da WAHA:', lidPn.size, 'pares');

// ---------- 2) carregar base (paginado) ----------
const [identities, contacts, aliases, lidConvs, pendings] = await Promise.all([
  fetchAll(supabase.from('whatsapp_identities').select('*').eq('workspace_id', W)),
  fetchAll(supabase.from('contacts').select('id, display_name, phone_number, created_at').eq('workspace_id', W)),
  fetchAll(supabase.from('contact_identifiers').select('*').eq('workspace_id', W)),
  fetchAll(supabase.from('conversations').select('*').eq('workspace_id', W).eq('conversation_type', 'direct').like('chat_id', '%@lid')),
  fetchAll(supabase.from('pending_contact_identities').select('*').eq('workspace_id', W)),
]);
console.log(`base: ${identities.length} identidades | ${contacts.length} contatos | ${aliases.length} aliases | ${lidConvs.length} conversas @lid | ${pendings.length} pendências`);
backup.whatsapp_identities = identities; backup.contacts = contacts; backup.contact_identifiers = aliases; backup.conversations = lidConvs; backup.pending = pendings;
if (APPLY) { // backup ANTES de qualquer escrita — se o processo cair no meio, o arquivo já existe
  const file = new URL(`../../../cura-lids-v3-backup-${now().replace(/[:.]/g, '-')}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(backup, null, 1));
  console.log('backup pré-escrita gravado em:', decodeURIComponent(file.pathname));
}

// ---------- 3) corrigir identidades (canonical + phone reais), em lote ----------
const upserts = [];
const seen = new Set();
for (const i of identities) {
  if (!i.whatsapp_id?.endsWith('@lid')) continue;
  const lidDigits = i.whatsapp_id.split('@')[0];
  const live = lidPn.get(lidDigits);
  const canonAtual = i.canonical_whatsapp_id;
  const canonNovo = live ? `${live.pnDigits}@c.us` : (canonAtual?.endsWith('@c.us') ? canonAtual : null);
  const phoneNovo = live?.pnDigits ?? (canonNovo ? canonNovo.split('@')[0] : (i.phone === lidDigits ? null : i.phone));
  if (!((canonNovo && canonNovo !== canonAtual) || phoneNovo !== i.phone)) continue;
  stats.identitiesCorrigidas++;
  const base = { workspace_id: W, waha_session: i.waha_session, name: i.name, push_name: i.push_name, short_name: i.short_name, profile_picture_url: i.profile_picture_url, created_at: i.created_at, updated_at: now() };
  upserts.push({ ...base, id: i.id ?? crypto.randomUUID(), whatsapp_id: i.whatsapp_id, canonical_whatsapp_id: canonNovo ?? canonAtual, phone: phoneNovo });
  if (canonNovo && !seen.has(`${i.waha_session}|${canonNovo}`)) { seen.add(`${i.waha_session}|${canonNovo}`); upserts.push({ ...base, id: crypto.randomUUID(), whatsapp_id: canonNovo, canonical_whatsapp_id: canonNovo, phone: phoneNovo }); }
  i.canonical_whatsapp_id = canonNovo ?? canonAtual; i.phone = phoneNovo;
}
console.log('identidades a corrigir:', stats.identitiesCorrigidas);
if (APPLY && upserts.length) for (const lote of chunks(upserts, 400)) {
  const { error } = await supabase.from('whatsapp_identities').upsert(lote, { onConflict: 'workspace_id,waha_session,whatsapp_id' });
  if (error) console.log('ERRO upsert identidades:', error.message);
}

// ---------- 4) fundir conversas @lid ----------
const identById = new Map(identities.map(i => [`${i.waha_session}|${i.whatsapp_id}`, i]));
for (const conv of lidConvs) {
  const ident = identById.get(`${conv.waha_session}|${conv.chat_id}`);
  const lidDigits = conv.chat_id.split('@')[0];
  const canonical = ident?.canonical_whatsapp_id?.endsWith('@c.us') && ident.canonical_whatsapp_id !== conv.chat_id
    ? ident.canonical_whatsapp_id
    : (lidPn.has(lidDigits) ? `${lidPn.get(lidDigits).pnDigits}@c.us` : null);
  if (!canonical) { relatorio.semMapa.push(conv.chat_id); stats.contatosSemMapa++; continue; }
  const aliasIds = [...new Set([canonical, conv.chat_id, ...identities.filter(x => x.waha_session === conv.waha_session && x.canonical_whatsapp_id === canonical).map(x => x.whatsapp_id)])];
  const { data: irmaos } = await supabase.from('conversations').select('*').eq('workspace_id', W).eq('waha_session', conv.waha_session).eq('conversation_type', 'direct').in('chat_id', aliasIds);
  const todos = irmaos?.length ? irmaos : [conv];
  const primary = [...todos].sort((a, b) => Number(b.chat_id === canonical || b.canonical_chat_id === canonical) - Number(a.chat_id === canonical || a.canonical_chat_id === canonical) || a.created_at.localeCompare(b.created_at))[0];
  const latest = [...todos].sort((a, b) => b.last_message_at.localeCompare(a.last_message_at))[0];
  const unread = todos.reduce((t, c) => t + (c.unread_count ?? 0), 0);
  const earliest = todos.reduce((v, c) => v < c.created_at ? v : c.created_at, primary.created_at);
  const updated = todos.reduce((v, c) => v > c.updated_at ? v : c.updated_at, primary.updated_at);
  let contactId = primary.contact_id;
  if (!contactId && APPLY) {
    const { data, error } = await supabase.rpc('chatpro_resolve_contact_identity', {
      p_workspace_id: W, p_phone_number: ident?.phone ?? lidPn.get(lidDigits)?.pnDigits ?? null, p_display_name: ident?.name ?? ident?.push_name ?? null,
      p_identifiers: [{ identifier: canonical, type: 'whatsapp' }, { identifier: conv.chat_id, type: 'lid' }, ...(ident?.phone ? [{ identifier: ident.phone, type: 'phone' }] : [])],
      p_source: 'cura_lids_v3',
    });
    if (error) console.log('ERRO RPC contato', canonical, error.message);
    else contactId = (Array.isArray(data) ? data[0] : data)?.contact_id ?? null;
  }
  relatorio.fundidas.push(`${conv.chat_id} -> ${canonical} (${todos.length > 1 ? 'merge' : 'renomeia'})`);
  stats.conversasFundidas++;
  if (!APPLY) continue;
  const { data: movidas, error: eMsg } = await supabase.from('whatsapp_messages').update({ chat_id: canonical }).eq('workspace_id', W).eq('waha_session', conv.waha_session).in('chat_id', todos.map(c => c.chat_id)).select('external_message_id');
  if (eMsg) console.log('ERRO mensagens', conv.chat_id, eMsg.message); else stats.mensagensMovidas += movidas?.length ?? 0;
  const duplicadas = todos.filter(c => c.id !== primary.id);
  if (duplicadas.length) {
    // FKs que bloqueiam o delete: kanban (sem ação) e outbox (RESTRICT)
    const dupIds = duplicadas.map(c => c.id);
    const { data: kanbanRows, error: kanbanError } = await supabase.from('conversation_kanban_state').select('conversation_id, board_id').eq('workspace_id', W).in('conversation_id', [primary.id, ...dupIds]);
    if (kanbanError) console.log('ERRO kanban read', kanbanError.message);
    const primaryBoards = new Set((kanbanRows ?? []).filter(r => r.conversation_id === primary.id).map(r => r.board_id));
    const kept = new Set();
    for (const row of (kanbanRows ?? []).filter(r => r.conversation_id !== primary.id)) {
      if (primaryBoards.has(row.board_id) || kept.has(row.board_id)) await supabase.from('conversation_kanban_state').delete().eq('workspace_id', W).eq('conversation_id', row.conversation_id).eq('board_id', row.board_id);
      else { const { error } = await supabase.from('conversation_kanban_state').update({ conversation_id: primary.id, updated_at: now() }).eq('workspace_id', W).eq('conversation_id', row.conversation_id).eq('board_id', row.board_id); if (!error) kept.add(row.board_id); }
    }
    await supabase.from('inbox_outbox_jobs').update({ conversation_id: primary.id, updated_at: now() }).eq('workspace_id', W).in('conversation_id', dupIds);
    const { error } = await supabase.from('conversations').delete().eq('workspace_id', W).in('id', dupIds);
    if (error) console.log('ERRO delete duplicadas', error.message);
  }
  const { error } = await supabase.from('conversations').update({
    chat_id: canonical, canonical_chat_id: canonical,
    delivery_chat_id: canonical.endsWith('@c.us') ? canonical : primary.delivery_chat_id ?? canonical,
    ...(contactId ? { contact_id: contactId } : {}),
    unread_count: unread, last_message: latest.last_message, last_message_at: latest.last_message_at,
    created_at: earliest, updated_at: updated,
  }).eq('workspace_id', W).eq('id', primary.id);
  if (error) console.log('ERRO update primary', conv.chat_id, error.message);
}

// ---------- 4b) varredura: qualquer mensagem ainda endereçada a @lid resolvido ----------
{
  const { data: restantes } = await supabase.from('whatsapp_messages').select('chat_id').eq('workspace_id', W).like('chat_id', '%@lid').limit(2000);
  const porChat = new Map();
  for (const m of restantes ?? []) {
    const digits = (m.chat_id ?? '').split('@')[0];
    const canonical = identities.find(i => i.whatsapp_id === m.chat_id)?.canonical_whatsapp_id ?? (lidPn.has(digits) ? `${lidPn.get(digits).pnDigits}@c.us` : null);
    if (canonical && canonical.endsWith('@c.us')) porChat.set(m.chat_id, canonical);
  }
  if (porChat.size) console.log('mensagens @lid restantes para varrer:', porChat.size, 'chats');
  for (const [lidChat, canonical] of porChat) {
    if (!APPLY) continue;
    const { data: movidas, error } = await supabase.from('whatsapp_messages').update({ chat_id: canonical }).eq('workspace_id', W).eq('chat_id', lidChat).select('external_message_id');
    if (error) console.log('ERRO varredura mensagens', lidChat, error.message); else stats.mensagensMovidas += movidas?.length ?? 0;
  }
}

// ---------- 5) fundir contatos LID-como-telefone (planejado em memória, escrito em lote) ----------
const contactByPhone = new Map(contacts.map(c => [c.phone_number, c]));
const isTechnical = n => !n?.trim() || !/[^\d()\s+.\-]/u.test(n.trim());
const pares = []; // { dupe, twin, lidDigits }
for (const c of contacts) {
  const digits = (c.phone_number ?? '').replace(/\D/g, '');
  const live = lidPn.get(digits);
  const identRow = identities.find(i => i.whatsapp_id === `${digits}@lid`);
  const realPhone = live?.pnDigits ?? (identRow?.canonical_whatsapp_id?.endsWith('@c.us') ? identRow.canonical_whatsapp_id.split('@')[0] : null);
  if (!realPhone || realPhone === digits) continue;
  const twin = contactByPhone.get(realPhone);
  if (twin && twin.id !== c.id) pares.push({ dupe: c, twin, lidDigits: digits });
}
stats.contatosFundidos = pares.length;
console.log('contatos a fundir:', pares.length);
if (APPLY && pares.length) {
  const dupeIds = pares.map(p => p.dupe.id);
  const aliasRows = pares.map(p => ({ id: crypto.randomUUID(), workspace_id: W, contact_id: p.twin.id, identifier: `${p.lidDigits}@lid`, type: 'lid', source: 'cura_lids_v3', created_at: now() }));
  // 1) alias LID no gêmeo: remove antes qualquer linha com o mesmo identifier
  //    (está presa ao duplicado e cairia por CASCADE depois, deixando o gêmeo
  //    sem o alias), e só então insere.
  for (const lote of chunks(aliasRows.map(a => a.identifier), 200)) {
    const { error } = await supabase.from('contact_identifiers').delete().eq('workspace_id', W).in('identifier', lote);
    if (error) console.log('ERRO limpar aliases conflitantes:', error.message);
  }
  for (const lote of chunks(aliasRows, 400)) {
    const { error } = await supabase.from('contact_identifiers').insert(lote);
    if (error) console.log('ERRO insert aliases:', error.message);
  }
  // 2) conversas e mensagens: uma query por par, 20 em paralelo
  await pool(pares.map(p => async () => {
    const { error } = await supabase.from('conversations').update({ contact_id: p.twin.id, updated_at: now() }).eq('workspace_id', W).eq('contact_id', p.dupe.id);
    if (error) console.log('ERRO conversa contato', p.dupe.id, error.message);
  }));
  await pool(pares.map(p => async () => {
    const { error } = await supabase.from('whatsapp_messages').update({ sender_contact_id: p.twin.id }).eq('workspace_id', W).eq('sender_contact_id', p.dupe.id);
    if (error) console.log('ERRO msg contato', p.dupe.id, error.message);
  }));
  // 3) nome: duplicado com nome de verdade cobre rótulo técnico do gêmeo
  await pool(pares.filter(p => isTechnical(p.twin.display_name) && !isTechnical(p.dupe.display_name)).map(p => async () => {
    const { error } = await supabase.from('contacts').update({ display_name: p.dupe.display_name, updated_at: now() }).eq('workspace_id', W).eq('id', p.twin.id);
    if (error) console.log('ERRO nome gêmeo', p.twin.id, error.message);
  }));
  // 4) duplicados fora (aliases caem por ON DELETE CASCADE)
  for (const lote of chunks(dupeIds, 200)) {
    const { error } = await supabase.from('contacts').delete().eq('workspace_id', W).in('id', lote);
    if (error) console.log('ERRO delete duplicados:', error.message);
  }
}

// ---------- 6) pendências: limpar resolvidas e lixo ----------
const pendentesLimpar = pendings.filter(p => {
  const digits = (p.identifier ?? '').split('@')[0];
  return lidPn.has(digits) || p.identifier === '__diagnostico_inexistente__@lid' || p.identifier === '0@c.us'
    || identities.some(i => i.whatsapp_id === p.identifier && i.canonical_whatsapp_id && i.canonical_whatsapp_id !== i.whatsapp_id);
});
stats.pendenciasLimpas = pendentesLimpar.length;
if (APPLY && pendentesLimpar.length) for (const lote of chunks(pendentesLimpar.map(p => p.identifier), 200)) {
  const { error } = await supabase.from('pending_contact_identities').delete().eq('workspace_id', W).in('identifier', lote);
  if (error) console.log('ERRO pendências:', error.message);
}

// ---------- relatório + backup ----------
console.log('\n===== RESULTADO', APPLY ? '(APLICADO)' : '(SIMULAÇÃO — nada foi escrito)', '=====');
console.log(JSON.stringify(stats, null, 1));
console.log('conversas fundidas:', relatorio.fundidas.length);
relatorio.fundidas.slice(0, 35).forEach(x => console.log(' -', x));
if (relatorio.semMapa.length) { console.log('@lid sem mapa conhecido (mantidos):'); relatorio.semMapa.forEach(x => console.log(' -', x)); }
if (!APPLY) console.log('\nRode com --apply para aplicar (backup automático antes das escritas).');
