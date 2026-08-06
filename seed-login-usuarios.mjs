// Seed de usuários de login no Supabase (PostgREST + service_role do .env.local).
// Cria/atualiza os usuários em workspace_users e as senhas (scrypt) em
// auth_credentials — mesmo formato do AuthService da API (scrypt:saltB64:hashB64).
// Uso: node seed-login-usuarios.mjs
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('./web/.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter(line => /^[A-Z_]+=/.test(line))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()])
);

const url = env.SUPABASE_URL?.replace(/\/+$/, '');
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const workspaceId = env.WAHA_WEBHOOK_WORKSPACE_ID || 'default-workspace';
if (!url || !key) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes no web/.env.local');

const USERS = [
  { email: 'admin@chat.com', password: 'admin', displayName: 'Administrador', role: 'owner' },
  { email: 'colaborador1@chat.com', password: 'colaborador1', displayName: 'Colaborador 1', role: 'agent' },
  { email: 'colaborador2@chat.com', password: 'colaborador2', displayName: 'Colaborador 2', role: 'agent' },
];

const hashPassword = password => {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('base64')}:${scryptSync(password, salt, 32).toString('base64')}`;
};

const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

async function api(path, init = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// 0) auth_credentials precisa existir (migration 20260806000100_auth.sql no SQL Editor)
const probe = await fetch(`${url}/rest/v1/auth_credentials?select=user_id&limit=1`, { headers });
if (probe.status === 404) {
  console.error('❌ A tabela auth_credentials NÃO existe no Supabase.');
  console.error('   Rode antes o SQL de web/supabase/migrations/20260806000100_auth.sql no SQL Editor do Supabase e execute este script de novo.');
  process.exit(2);
}

const now = new Date().toISOString();
for (const user of USERS) {
  const email = user.email.toLowerCase();
  const found = await api(`workspace_users?workspace_id=eq.${workspaceId}&email=eq.${encodeURIComponent(email)}&select=id,role`);
  let userId = found?.[0]?.id;
  if (userId) {
    await api(`workspace_users?id=eq.${userId}`, { method: 'PATCH', body: JSON.stringify({ role: user.role, status: 'active', display_name: user.displayName, updated_at: now }) });
  } else {
    userId = randomUUID();
    await api('workspace_users', { method: 'POST', body: JSON.stringify({ id: userId, workspace_id: workspaceId, email, display_name: user.displayName, avatar_url: null, role: user.role, status: 'active', created_at: now, updated_at: now, last_seen_at: now }) });
  }
  await api('auth_credentials', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ user_id: userId, password_hash: hashPassword(user.password), updated_at: now }) });
  console.log(`✔ ${email} (${user.role}) — senha cadastrada`);
}
console.log('\nPronto. Teste o login em http://localhost:5173 (dashboard) com e-mail + senha.');
