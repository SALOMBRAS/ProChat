# Integridade de conversas

Para mensagens de grupo, o identificador da conversa é sempre o `chatId` que
termina em `@g.us`. `participant` é somente metadado do autor e é exposto como
`senderWhatsappId`; ele nunca é usado para criar ou atualizar conversa direta.

O script `scripts/audit-conversation-integrity.ts` permanece em dry-run por
padrão e só classifica casos inequívocos. Ele não apaga mensagens.
