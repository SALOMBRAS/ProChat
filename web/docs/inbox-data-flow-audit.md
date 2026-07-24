# Auditoria do fluxo de dados da Inbox

Data da auditoria: 2026-07-21

## Fluxo mapeado

1. O webhook da WAHA entra em `apps/api/src/controllers/waha-webhook.controller.ts`, em `wahaWebhook`.
2. O controlador normaliza o evento com `webhookRecord` e o persiste por meio de `WahaWebhookStore.ingest`.
3. `apps/api/src/services/waha-webhook.service.ts`, em `messageFrom`, usa
   `resolveConversationIdentity` para definir o `chatId` da mensagem. Depois,
   `upsertConversation` cria ou atualiza a conversa no SQLite ou no Supabase.
4. O histórico usa o mesmo `WahaWebhookStore.ingest`: `historyRecord`, em
   `apps/api/src/services/whatsapp-history-sync.service.ts`, fixa o chat listado
   em `_historyChatId` antes de chamar a ingestão.
5. A Inbox usa `listConversations` no mesmo store. Ela retorna somente conversas
   com visibilidade `visible`/`visibility_state = visible`.

## Diagnóstico e recomendações

| Arquivo e função | Causa provável / comportamento observado | Correção recomendada |
| --- | --- | --- |
| `apps/api/src/services/conversation-identity.ts` — `resolveConversationIdentity` | A função já preserva grupos (`@g.us`) e exclui `participant`, mas considera qualquer identificador direto válido como conversa. Não há regra explícita para rejeitar o próprio número da conta. | Transformar este módulo no validador central de conversa, recebendo também a identidade da conta. Rejeitar o próprio JID, status/story e chats técnicos antes de qualquer persistência. |
| `apps/api/src/services/waha-webhook.service.ts` — `messageFrom` e `upsertConversation` | A persistência usa a identidade resolvida, porém mensagens técnicas são classificadas posteriormente para automações. Um evento técnico que contenha um chat direto ainda pode alcançar a criação/atualização da conversa. | Fazer a validação central retornar uma decisão explícita (`accept`/`ignore` e motivo) e interromper a ingestão de conversa antes de `upsertConversation`. Reutilizar a mesma decisão em webhook, histórico, sync manual e importação. |
| `apps/api/src/controllers/waha-webhook.controller.ts` — `wahaWebhook` | Após persistir a mensagem normalizada, o controlador monta o alvo do identity sync a partir de `chatId`, `from`, `to` e `remoteJid` brutos do evento. Isso pode divergir do chat normalizado e encaminhar identificadores removidos, técnicos ou inválidos para a WAHA. | Propagar o `chatId` e o tipo aceitos pelo validador/ingestão; enfileirar identity sync somente para alvos aceitos. Nunca usar `participant` como chat de conversa. |
| `apps/api/src/services/whatsapp-history-sync.service.ts` — `historyRecord` e checkpoint | O histórico reutiliza a ingestão e fixa corretamente o chat real do lote. O checkpoint remoto atual está `pending`, com cursor `500`, `500` conversas e `977` mensagens: são valores persistidos de uma execução anterior, não texto fixo da UI. | Manter o checkpoint sem mutação nesta auditoria. Na correção, separar a configuração legada do novo orçamento de emergência e expor ao frontend estado/cursor atuais, sem recontar nem reiniciar histórico. |
| `apps/api/src/app.ts` e `apps/api/src/config.ts` — criação de `WhatsAppHistorySyncService` | `WHATSAPP_HISTORY_SYNC_MAX_MESSAGES`/`whatsappHistorySyncMaxMessages`, configuração do antigo limite cumulativo, ainda é passada como `emergencyMaxMessages`. Um valor legado como `977` pode portanto continuar atuando como guarda de emergência, apesar do novo valor esperado de `100000`. | Substituir a configuração por uma chave semântica de guarda de emergência, com padrão `100000`, e deixar incompatibilidades legadas explícitas e seguras. Não iniciar o sync para aplicar essa mudança. |
| `apps/dashboard/src/ui/Inbox.tsx` — bloco de status do histórico | A UI exibe `progressLabel`, `chatsProcessed` e `messagesProcessed` recebidos da API; ela não contém os números `500` ou `977` fixos. O texto atual reflete o checkpoint remoto pendente. | Ajustar a resposta de status para expor ciclo/lote e cursor atuais. Enquanto não houver total conhecido, usar texto honesto como “Aguardando próximo ciclo” sem sugerir que os contadores antigos são o limite vigente. |
| `apps/api/src/services/whatsapp-identity-sync.service.ts` — `run` | Respostas WAHA `NOT_FOUND` são registradas como erro indistintamente. Para chat removido, sessão divergente ou alvo descartado, o resultado esperado deveria ser ignorado; o log atual não traz contexto suficiente para diferenciar os casos. | Validar o alvo antes da chamada e tratar `NOT_FOUND` esperado como ignorado estruturado, com motivo, workspace, sessão e alvo mascarado. Manter erro para falhas inesperadas e não deixar uma falha interromper os itens seguintes. |
| `apps/api/src/services/sla.service.ts` — `tick` | Uma falha ao ler ou salvar uma conversa interrompe o `for` inteiro. O `catch` do timer em `app.ts` impede queda da API, mas registra somente o erro global, sem workspace/conversa que falhou. | Isolar cada item devido com `try/catch`, registrar contexto e continuar o lote. Preservar um `catch` externo apenas para falhas de listagem/inicialização e emitir resumo de itens processados/falhos. |

## Conclusões verificadas

- A criação de conversa acontece somente após `messageFrom` produzir uma mensagem
  com `chatId`; os caminhos SQLite e Supabase passam por `upsertConversation`.
- O participante de grupo não é usado pela identidade atual da conversa, mas a
  regra precisa virar uma validação central e obrigatória para todos os pontos de
  entrada.
- `558592369359` ainda pode ser aceito como chat direto porque a identidade local
  não é considerada pela função de resolução.
- `status@broadcast` não resolve como chat de conversa, mas a filtragem de
  eventos técnicos deve acontecer antes da persistência, não apenas em fluxos
  posteriores.
- Não houve alteração de checkpoint, reinício de histórico, migration remota,
  exclusão de dados ou push durante esta auditoria.
