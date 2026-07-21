/** Read-only by default. --apply changes only reversible integrity metadata. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { isConversationChatId, isDirectChatId, isGroupChatId } from '../apps/api/src/services/conversation-identity.js';

type Conversation = { id: string; workspace_id: string; waha_session: string; chat_id: string; canonical_chat_id: string | null; delivery_chat_id: string | null; conversation_type: string; created_at: string; last_message_at: string; visibility_state: string; integrity_classification: string };
type Message = { workspace_id: string; waha_session: string; chat_id: string; direction: string; occurred_at: string; sender_whatsapp_id: string | null; payload_json: Record<string, unknown> | null };
type Classification = 'valid_direct' | 'valid_group' | 'technical' | 'probable_false_direct' | 'inconclusive';
const args = new Set(process.argv.slice(2)); const apply = args.has('--apply');
const output = process.argv.find(value => value.startsWith('--output='))?.slice(9) ?? 'docs/conversation-integrity-waha-audit.json';
const baseline = JSON.parse(readFileSync('docs/conversation-integrity-audit.json', 'utf8')) as { records: Array<{ conversation_id: string; classification: Classification }> };
const baselineTargets = new Set(baseline.records.filter(row => row.classification === 'inconclusive' || row.classification === 'technical').map(row => row.conversation_id));
const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).flatMap(line => { const hit = line.match(/^([^#=]+)=(.*)$/); return hit ? [[hit[1].trim(), hit[2].trim()]] : []; }));
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.WAHA_BASE_URL || !env.WAHA_API_KEY) throw new Error('SUPABASE and WAHA configuration is required');
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const base = env.WAHA_BASE_URL.replace(/\/+$/, '');

async function all<T>(table: string, columns: string): Promise<T[]> { let from = 0; const rows: T[] = []; while (true) { const { data, error } = await db.from(table).select(columns).range(from, from + 999); if (error) throw error; rows.push(...(data ?? []) as T[]); if (!data || data.length < 1000) return rows; from += data.length; } }
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function chatId(value: unknown): string | undefined { if (typeof value === 'string') return value; if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined; const item = value as Record<string, unknown>; return string(item._serialized) ?? string(item.id) ?? string(item.chatId); }
function rawChatId(item: Record<string, unknown>): string | undefined { return chatId(item.id) ?? string(item.chatId) ?? string(item._serialized) ?? string(item.remoteJid); }
function mask(value: string) { const [local, suffix = ''] = value.split('@'); return `${local.slice(0, 3)}***${local.slice(-2)}@${suffix}`; }
async function inventory(session: string) {
  const valid = new Set<string>(); let offset = 0; let pages = 0; let rawTotal = 0; let technical = 0; const signatures = new Set<string>();
  for (;;) {
    const response = await fetch(`${base}/api/${encodeURIComponent(session)}/chats?limit=100&offset=${offset}&sortBy=conversationTimestamp&sortOrder=desc`, { headers: { accept: 'application/json', 'x-api-key': env.WAHA_API_KEY } });
    if (!response.ok) throw new Error(`WAHA chat inventory failed (${response.status})`);
    const data: unknown = await response.json(); if (!Array.isArray(data)) throw new Error('WAHA chat inventory contract is not an array');
    const ids = data.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) ? [rawChatId(value as Record<string, unknown>)] : []).filter((value): value is string => Boolean(value));
    const signature = ids.join('|'); if (signature && signatures.has(signature)) throw new Error('WAHA chat inventory repeated a page'); signatures.add(signature);
    pages += 1; rawTotal += data.length;
    for (const id of ids) { if (isConversationChatId(id)) valid.add(id); else technical += 1; }
    if (data.length < 100) return { ids: valid, pages, rawTotal, technical, complete: true };
    offset += data.length; if (pages > 10_000) throw new Error('WAHA chat inventory exceeded safe pagination bound');
  }
}

const conversations = await all<Conversation>('conversations', 'id,workspace_id,waha_session,chat_id,canonical_chat_id,delivery_chat_id,conversation_type,created_at,last_message_at,visibility_state,integrity_classification');
const messages = await all<Message>('whatsapp_messages', 'workspace_id,waha_session,chat_id,direction,occurred_at,sender_whatsapp_id,payload_json');
const identities = await all<{ workspace_id: string; waha_session: string; whatsapp_id: string; canonical_whatsapp_id: string | null }>('whatsapp_identities', 'workspace_id,waha_session,whatsapp_id,canonical_whatsapp_id');
const participants = new Set((await all<{ participant_whatsapp_id: string }>('whatsapp_group_participants', 'participant_whatsapp_id')).map(row => row.participant_whatsapp_id));
const sessions = [...new Set(conversations.map(row => row.waha_session))];
const sessionResponse = await fetch(`${base}/api/sessions?all=true`, { headers: { accept: 'application/json', 'x-api-key': env.WAHA_API_KEY } });
if (!sessionResponse.ok) throw new Error(`WAHA session inventory failed (${sessionResponse.status})`);
const sessionStatus = new Map((await sessionResponse.json() as Array<{ name?: unknown; status?: unknown }>).flatMap(item => typeof item.name === 'string' && typeof item.status === 'string' ? [[item.name, item.status] as const] : []));
const inventories = new Map<string, Awaited<ReturnType<typeof inventory>>>();
for (const session of sessions) if (sessionStatus.get(session)?.toUpperCase() === 'WORKING') inventories.set(session, await inventory(session));
const aliases = new Map(identities.map(row => [`${row.workspace_id}:${row.waha_session}:${row.whatsapp_id}`, row.canonical_whatsapp_id ?? row.whatsapp_id]));
const byChat = new Map<string, Message[]>(); for (const message of messages) { const key = `${message.workspace_id}:${message.waha_session}:${message.chat_id}`; byChat.set(key, [...(byChat.get(key) ?? []), message]); }
const beforeVisible = conversations.filter(row => row.visibility_state === 'visible').length;
const reviewed = conversations.filter(row => baselineTargets.has(row.id)).map(row => {
  const key = `${row.workspace_id}:${row.waha_session}:${row.chat_id}`; const ownMessages = byChat.get(key) ?? [];
  const canonical = aliases.get(key) ?? row.canonical_chat_id ?? row.chat_id;
  const candidates = new Set([row.chat_id, canonical, row.delivery_chat_id].filter((value): value is string => Boolean(value)));
  const inventoryIds = inventories.get(row.waha_session)?.ids ?? new Set<string>();
  const inventoryComplete = inventories.get(row.waha_session)?.complete === true;
  const present = [...candidates].some(value => inventoryIds.has(value));
  const outbound = ownMessages.filter(message => message.direction === 'outbound').length;
  const rawDirect = ownMessages.some(message => message.payload_json?._history !== true && [...candidates].includes(rawChatId(message.payload_json ?? {}) ?? ''));
  const historicalOnly = ownMessages.length > 0 && ownMessages.every(message => message.payload_json?._history === true);
  const participantOnly = participants.has(row.chat_id) && !present && !rawDirect && outbound === 0;
  let classification: Classification = 'inconclusive'; let reason = 'conflicting_or_insufficient_evidence';
  if (!isConversationChatId(row.chat_id)) { classification = 'technical'; reason = 'technical_or_non_chat_identifier'; }
  else if (isGroupChatId(row.chat_id)) { classification = 'valid_group'; reason = 'group_chat_id'; }
  else if (isDirectChatId(row.chat_id) && present) { classification = 'valid_direct'; reason = canonical !== row.chat_id ? 'waha_inventory_via_persisted_alias' : 'waha_inventory_direct_match'; }
  else if (isDirectChatId(row.chat_id) && rawDirect) { classification = 'valid_direct'; reason = 'non_historical_raw_message_chat_match'; }
  else if (isDirectChatId(row.chat_id) && outbound > 0) { classification = 'valid_direct'; reason = 'outbound_direct_message_present'; }
  else if (isDirectChatId(row.chat_id) && inventoryComplete && participantOnly && historicalOnly && row.created_at <= '2026-07-20T20:05:00.000Z') { classification = 'probable_false_direct'; reason = 'absent_from_complete_waha_inventory;_group_participant_only;_historical_import_origin;_no_outbound_or_raw_direct_evidence'; }
  return { conversation_id: row.id, workspace_id: row.workspace_id, waha_session: row.waha_session, chat_id_masked: mask(row.chat_id), canonical_chat_id_masked: mask(canonical), conversation_type: row.conversation_type, created_at: row.created_at, last_message_at: row.last_message_at, message_count: ownMessages.length, direct_message_count: ownMessages.filter(message => !isGroupChatId(message.chat_id)).length, group_message_count: ownMessages.filter(message => isGroupChatId(message.chat_id)).length, inbound_count: ownMessages.filter(message => message.direction === 'inbound').length, outbound_count: outbound, presence_in_waha_chat_inventory: present, presence_only_as_group_participant: participantOnly, presence_as_real_message_chat_id: rawDirect, classification, reason };
});
if (apply) for (const row of reviewed.filter(row => row.classification === 'technical' || row.classification === 'probable_false_direct')) { const visibility = row.classification === 'technical' ? 'technical' : 'quarantined'; const { error } = await db.from('conversations').update({ visibility_state: visibility, integrity_classification: row.classification, integrity_reason_safe: row.reason, integrity_reviewed_at: new Date().toISOString() }).eq('workspace_id', row.workspace_id).eq('id', row.conversation_id); if (error) throw error; }
const totals = Object.fromEntries((['valid_direct', 'valid_group', 'technical', 'probable_false_direct', 'inconclusive'] as Classification[]).map(kind => [kind, reviewed.filter(row => row.classification === kind).length]));
const quarantined = reviewed.filter(row => row.classification === 'technical' || row.classification === 'probable_false_direct').length;
const report = { generated_at: new Date().toISOString(), mode: apply ? 'apply-reversible-classification' : 'dry-run', baseline_targets: baselineTargets.size, waha_inventory: Object.fromEntries(sessions.map(session => { const item = inventories.get(session); return [session, item ? { pages: item.pages, total_raw: item.rawTotal, total_valid: item.ids.size, total_technical: item.technical, complete: item.complete, session_status: 'WORKING' } : { pages: 0, total_raw: 0, total_valid: 0, total_technical: 0, complete: false, session_status: sessionStatus.get(session) ?? 'missing' }]; })), total_conversations: conversations.length, reviewed_conversations: reviewed.length, inbox_visible_before: beforeVisible, inbox_visible_after_expected: beforeVisible - quarantined, totals, no_messages_deleted: true, records: reviewed };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ ...report, records: undefined }, null, 2));
