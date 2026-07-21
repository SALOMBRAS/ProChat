import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).flatMap(line => { const hit = line.match(/^([^#=]+)=(.*)$/); return hit ? [[hit[1].trim(), hit[2].trim()]] : []; }));
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE configuration is required');
const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const tables = ['conversations', 'whatsapp_messages', 'whatsapp_groups', 'whatsapp_group_participants'] as const;
async function all(table: string) { let from = 0; const rows: unknown[] = []; for (;;) { const { data, error } = await client.from(table).select('*').range(from, from + 999); if (error) throw error; rows.push(...(data ?? [])); if (!data || data.length < 1000) return rows; from += data.length; } }
const snapshot = { createdAt: new Date().toISOString(), provider: 'supabase', tables: Object.fromEntries(await Promise.all(tables.map(async table => [table, await all(table)]))) };
const folder = resolve('backups'); mkdirSync(folder, { recursive: true });
const file = join(folder, `inbox-integrity-${snapshot.createdAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(snapshot));
const size = statSync(file).size; if (!size) throw new Error('Backup file is empty');
const checksum = createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync(`${file}.sha256`, `${checksum}  ${file.split(/[\\/]/).pop()}\n`);
console.log(JSON.stringify({ file, size, checksum, counts: Object.fromEntries(Object.entries(snapshot.tables).map(([table, rows]) => [table, (rows as unknown[]).length])) }, null, 2));
