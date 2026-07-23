# Baseline restaurável da identidade de contatos

Data: 2026-07-23

## Origem e restauração

- Commit de origem: `61d875fff633965ad50e4c2f2c8857cf5317a55d`
- Tag local: `backup-before-openwa-identity-adaptation`
- Branch local: `backup/chatpro-identity-before-openwa`
- Snapshot local ignorado: `web/backups/code/contact-identity-before-openwa`
- Gerador: `web/scripts/backup-contact-identity-baseline.mjs`

Execute o gerador a partir de `web` para recriar o snapshot e seu manifesto:

```powershell
$env:CONTACT_IDENTITY_BASELINE_COMMIT = git rev-parse HEAD
node scripts/backup-contact-identity-baseline.mjs
```

O `manifest.json` do snapshot registra caminho de origem, SHA-256, commit e data/hora para cada arquivo. `README-RESTORE.md` descreve a restauração pela branch/tag ou por cópia de arquivos verificada por hash. A política atual já ignora `backups/`, portanto o artefato local não entra no commit.

## Conteúdo do snapshot

O snapshot inclui 24 arquivos de código e contrato relacionados a identidade, webhook, Inbox, repositórios, migrations de contatos, testes e contratos do dashboard. Ele exclui `.env`, credenciais, dependências, mídia, bancos, backups de banco e temporários.

## Testes de caracterização

Novos em `apps/api/test/contact-identity-characterization.test.ts`:

- mesmo telefone e aliases em workspaces distintos não se cruzam;
- SQLite com foreign keys ativas rejeita alias cujo `contactId` não existe;
- o fluxo Supabase persiste/obtém o contato antes de inserir aliases, impedindo a ordem que provocaria `23503`.

A cobertura existente em `conversation-identity.test.ts` e `waha-webhook.test.ts` permanece como baseline para:

- número puro, `@c.us` e `@lid` no mesmo contato;
- `message` e `message.any` sem duplicar mensagem ou conversa;
- participante de grupo apenas como autor, sem contato/conversa privada;
- alias pendente sem telefone;
- envio direto com persistência local;
- reconciliação LID para `@c.us` e isolamento de contexto de workspace.

## Falhas e riscos conhecidos antes da próxima fase

Não houve falha reproduzida no SQLite da baseline. O teste Supabase cobre a sequência observável do provider com um double de PostgREST que simula a FK; ele não consulta nem altera Supabase remoto, conforme escopo desta fase.

O risco conhecido continua sendo estrutural: o resolver e a reconciliação Supabase usam várias requisições independentes, sem uma RPC/transação única. Sob falha ou concorrência real, ainda pode existir janela entre criar/confirmar contato, gravar aliases, apagar pendências e reconciliar conversas. A próxima fase deve tratar isso com testes contra PostgreSQL/Supabase efêmero e uma operação transacional, sem alterar os contratos atuais.
