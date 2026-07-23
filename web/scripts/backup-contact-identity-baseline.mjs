import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const webRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(webRoot, '..');
const destination = resolve(webRoot, 'backups/code/contact-identity-before-openwa');
const sourceCommit = process.env.CONTACT_IDENTITY_BASELINE_COMMIT ?? 'unknown';
const createdAt = new Date().toISOString();

const files = [
  'apps/api/src/services/contact-identity-resolver.service.ts',
  'apps/api/src/services/whatsapp-identity-sync.service.ts',
  'apps/api/src/services/waha-webhook.service.ts',
  'apps/api/src/services/internal-inbox.service.ts',
  'apps/api/src/services/conversation-identity.ts',
  'apps/api/src/persistence/repositories.ts',
  'apps/api/src/persistence/supabase-repositories.ts',
  'apps/api/migrations/001_initial_persistence.sql',
  'apps/api/migrations/002_waha_webhook_store.sql',
  'apps/api/migrations/003_conversations.sql',
  'apps/api/migrations/005_whatsapp_group_persistence.sql',
  'apps/api/migrations/006_whatsapp_identity_sync.sql',
  'apps/api/migrations/020_contact_identity_aliases.sql',
  'supabase/migrations/002_waha_webhook_store.sql',
  'supabase/migrations/003_conversations.sql',
  'supabase/migrations/005_whatsapp_group_persistence.sql',
  'supabase/migrations/006_whatsapp_identity_sync.sql',
  'supabase/migrations/013_contact_identity_aliases.sql',
  'apps/api/test/conversation-identity.test.ts',
  'apps/api/test/waha-webhook.test.ts',
  'apps/api/test/contact-identity-characterization.test.ts',
  'scripts/backup-contact-identity-baseline.mjs',
  'docs/contact-identity-baseline.md',
  'dashboard/src/api/inbox.ts',
  'dashboard/src/api/domain.ts',
  'packages/contracts/src/index.ts'
];

if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
for (const file of files) {
  const source = resolve(webRoot, file);
  if (!existsSync(source)) continue;
  const target = resolve(destination, file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

const copied = files.filter(file => existsSync(resolve(destination, file))).map(file => {
  const target = resolve(destination, file);
  return {
    originalPath: relative(repositoryRoot, resolve(webRoot, file)).replaceAll('\\', '/'),
    snapshotPath: file,
    sha256: createHash('sha256').update(readFileSync(target)).digest('hex')
  };
});

writeFileSync(resolve(destination, 'manifest.json'), `${JSON.stringify({ createdAt, sourceCommit, files: copied }, null, 2)}\n`);
writeFileSync(resolve(destination, 'README-RESTORE.md'), `# Restore contact identity baseline\n\nCreated: ${createdAt}\nSource commit: ${sourceCommit}\n\n## Git restore\n\n\`\`\`powershell\ngit switch backup/chatpro-identity-before-openwa\n# or: git checkout backup-before-openwa-identity-adaptation -- web\n\`\`\`\n\n## File restore\n\nCopy files from this directory back to their paths under \`web/\`. Verify every SHA-256 in \`manifest.json\` before copying. This snapshot intentionally excludes secrets, dependencies, media, databases, and temporary files.\n`);
console.log(JSON.stringify({ destination, files: copied.length, sourceCommit }, null, 2));
