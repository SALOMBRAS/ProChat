# Integridade de conversas

Para mensagens de grupo, o identificador da conversa é sempre o `chatId` que
termina em `@g.us`. `participant` é somente metadado do autor e é exposto como
`senderWhatsappId`; ele nunca é usado para criar ou atualizar conversa direta.

O script `scripts/audit-conversation-integrity.ts` permanece em dry-run por
padrão e só classifica casos inequívocos. Ele não apaga mensagens.

## Limpeza reversível — 2026-07-21

Após export verificável do Supabase em `web/backups/` (arquivo ignorado pelo
Git, SHA-256 registrado no arquivo `.sha256` ao lado), a auditoria revalidou
63 registros: 26 participantes falsos foram marcados como `quarantined` e um
registro técnico como `technical`. Os 12 casos ambíguos não foram alterados.

Nenhuma query de `DELETE` ou `TRUNCATE` foi executada e mensagens/mídias não
foram alvo da limpeza. Para desfazer, restaure o snapshot ou atualize somente
as 26 conversas de `quarantined` para `visible` usando o relatório de auditoria
guardado em `backups/`; não é necessário reimportar o histórico.
