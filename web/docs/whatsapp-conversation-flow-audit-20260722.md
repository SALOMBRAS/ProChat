# Auditoria definitiva — criação de conversas WhatsApp

Data: 2026-07-22

## Pontos auditados

| Fluxo | Entrada | Criação/persistência | Resultado da auditoria |
| --- | --- | --- | --- |
| Webhook | `WahaWebhookController` para `message` e `message.any` | `messageFrom` → `ingest` → `upsertConversation` | Corrigido: somente `payload.chatId` define a conversa. |
| Ingest SQLite | `SqliteWahaWebhookStore` | `whatsapp_messages` e `conversations` | Mensagem é idempotente por `(workspaceId, wahaSession, externalMessageId)`; conversa por `(workspaceId, wahaSession, chatId)`. |
| Ingest Supabase | `SupabaseWahaWebhookStore` | mesmas entidades remotas | Mantém a mesma regra de identidade e de idempotência. |
| Histórico | `WhatsAppHistorySyncService` | `historyRecord` → ingest | O chat listado é fixado como `chatId`; não usa o participante da mensagem. |
| Identidade | `WhatsAppIdentitySyncService` | `whatsapp_identities` e reconciliação | Aliases conhecidos `@lid` são reconciliados em seu `@c.us` canônico, incluindo mensagens e conversas existentes. |
| Envio | `InternalInboxService` → worker → WAHA | `recordOutbound` após aceite | Timeout de transporte ampliado para 30 s; logs preservam correlação, conversa, sessão e ID externo. |

## Causa raiz

O resolvedor de identidade permitia que `from`, `to` e `remoteJid` fossem alternativas para `chatId`. Em payloads de grupos, esses campos podem conter o LID do participante. Mesmo com `participant` excluído diretamente, o fallback permitia que um identificador de ator fosse promovido a conversa.

O timeout padrão de 2 s entre API e worker era menor do que a latência possível de aceite do WAHA. Isso permitia que a API abortasse e respondesse 504 depois de o provedor já ter aceitado a mensagem.

## Correção aplicada

- `chatId` é a única autoridade para criar ou localizar uma conversa.
- `@g.us` cria somente conversa de grupo; `participant` é salvo apenas em `senderWhatsappId` da mensagem.
- `@c.us` e `@lid` diretos continuam aceitos somente quando forem o próprio `chatId`; aliases conhecidos são normalizados/reconciliados para a identidade canônica.
- Eventos repetidos não duplicam mensagens; eventos `message` e `message.any` para a mesma mensagem continuam compartilhando a chave de mensagem.
- Envio de texto aguarda até 30 s pelo aceite interno e registra início/aceite com o mesmo `correlationId`.

## Regressões cobertas

- Participantes `@lid` de grupo não criam conversa privada.
- Contato `@c.us` cria conversa direta.
- Repetição do mesmo evento/mensagem não duplica mensagem ou conversa.
- `@lid` e `@c.us` do mesmo WhatsApp são reconciliados em uma conversa canônica.
