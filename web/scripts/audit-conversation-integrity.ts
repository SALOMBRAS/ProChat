/**
 * Read-only by default. `--apply` only changes reversible visibility metadata;
 * it never deletes conversations or messages.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { isConversationChatId, isDirectChatId, isGroupChatId } from '../apps/api/src/services/conversation-identity.js';

type Row = { id: string; workspace_id: string; waha_session: string; chat_id: string; conversation_type: string; created_at: string; last_message_at: string };
type Classification = 'valid_direct' | 'valid_group' | 'technical' | 'probable_false_direct' | 'inconclusive';
const args = new Set(process.argv.slice(2));
const output = process.argv.find(value => value.startsWith('--output='))?.slice(9) ?? 'docs/conversation-integrity-audit.json';
const apply = args.has('--apply');
const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).flatMap(line => { const hit = line.match(/^([^#=]+)=(.*)$/); return hit ? [[hit[1].trim(), hit[2].trim()]] : []; }));
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env.local');
const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function all<T>(table: string, columns: string): Promise<T[]> { let from = 0; const rows: T[] = []; while (true) { const { data, error } = await client.from(table).select(columns).range(from, from + 999); if (error) throw error; rows.push(...(data ?? []) as T[]); if (!data || data.length < 1000) return rows; from += data.length; } }
function mask(id: string) { const [local, suffix = ''] = id.split('@'); return `${local.slice(0, 3)}***${local.slice(-2)}@${suffix}`; }

const conversations = await all<Row>('conversations', 'id,workspace_id,waha_session,chat_id,conversation_type,created_at,last_message_at');
const messages = await all<{ workspace_id: string; waha_session: string; chat_id: string; direction: string }>('whatsapp_messages', 'workspace_id,waha_session,chat_id,direction');
const participants = await all<{ participant_whatsapp_id: string }>('whatsapp_group_participants', 'participant_whatsapp_id');
const messageStats = new Map<string, { total: number; outbound: number }>();
for (const row of messages) { const key = `${row.workspace_id}:${row.waha_session}:${row.chat_id}`; const stat = messageStats.get(key) ?? { total: 0, outbound: 0 }; stat.total += 1; stat.outbound += row.direction === 'outbound' ? 1 : 0; messageStats.set(key, stat); }
const participantIds = new Set(participants.map(row => row.participant_whatsapp_id));
const results = conversations.map(row => {
  const key = `${row.workspace_id}:${row.waha_session}:${row.chat_id}`; const stat = messageStats.get(key) ?? { total: 0, outbound: 0 };
  let classification: Classification = 'inconclusive'; let reason = 'insufficient_evidence';
  if (!isConversationChatId(row.chat_id)) { classification = 'technical'; reason = 'technical_or_non_chat_identifier'; }
  else if (isGroupChatId(row.chat_id)) { classification = 'valid_group'; reason = 'group_chat_id'; }
  else if (isDirectChatId(row.chat_id) && !participantIds.has(row.chat_id) && stat.total > 0) { classification = 'valid_direct'; reason = 'direct_chat_messages_present'; }
  // A participant alone is intentionally inconclusive until WAHA chat-list evidence is supplied.
  else if (isDirectChatId(row.chat_id) && participantIds.has(row.chat_id) && stat.outbound === 0) { reason = 'group_participant_without_outbound_direct_evidence;_WAHA_chat_list_required_before_quarantine'; }
  return { conversation_id: row.id, chat_id_masked: mask(row.chat_id), workspace_id: row.workspace_id, waha_session: row.waha_session, classification, reason, message_count: stat.total, outbound_count: stat.outbound };
});
if (apply) {
  const targets = results.filter(row => row.classification === 'technical' || row.classification === 'probable_false_direct');
  for (const row of targets) { const visibility = row.classification === 'technical' ? 'technical' : 'quarantined'; const { error } = await client.from('conversations').update({ visibility_state: visibility, integrity_classification: row.classification, integrity_reason_safe: row.reason, integrity_reviewed_at: new Date().toISOString() }).eq('workspace_id', row.workspace_id).eq('id', row.conversation_id); if (error) throw error; }
}
const totals = Object.fromEntries((['valid_direct', 'valid_group', 'technical', 'probable_false_direct', 'inconclusive'] as Classification[]).map(category => [category, results.filter(row => row.classification === category).length]));
const report = { generated_at: new Date().toISOString(), mode: apply ? 'apply-reversible-classification' : 'dry-run', total_conversations: results.length, totals, no_messages_deleted: true, waha_chat_list_verified: false, records: results };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, ...report, records: undefined }, null, 2));
