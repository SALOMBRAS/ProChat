# Sincronização de histórico WhatsApp

Na Inbox, use **Sincronizar histórico** para criar ou retomar o job da sessão WAHA conectada. A API também aceita `POST /api/v1/inbox/sync/start` com `{ "wahaSession": "..." }`; sem esse campo, ela seleciona a sessão conectada do workspace. Consulte `GET /api/v1/inbox/sync/status?wahaSession=...` e interrompa com `POST /api/v1/inbox/sync/cancel`.

O job busca chats em páginas de 25 e mensagens em páginas de 100. Cada ciclo processa, por padrão, até 25 chats ou 1.000 mensagens; ao atingir esse ponto, o checkpoint é salvo, o estado fica brevemente em `pending` e o próximo ciclo inicia automaticamente. Não é necessário clicar novamente para concluir o histórico.

O sincronizador trabalha por ciclos: processa até 25 conversas e 1.000 mensagens por ciclo, em páginas de até 100 mensagens. Ao fim de um ciclo, o job permanece em `pending`, persiste o checkpoint e continua automaticamente no próximo ciclo. A única guarda de emergência é `WHATSAPP_HISTORY_SYNC_EMERGENCY_MAX_MESSAGES` (padrão: 100.000 por execução); ela não é um limite cumulativo do histórico. Timeouts e indisponibilidade recebem até três tentativas com backoff exponencial. Erros de validação, autorização ou não encontrado falham sem retry e podem ser retomados manualmente após correção.

## Checklist de validação real

1. Inicie API e worker e confirme a sessão `WORKING`.
2. Inicie uma execução e confira que os contadores passam por mais de um lote sem novo clique.
3. Compare uma conversa direta, um grupo e uma mensagem com mídia.
4. Repita o job para confirmar idempotência.
5. Envie ou receba uma mensagem durante a execução e confirme que permanece única.
6. Cancele no meio de uma página, inicie novamente e confirme a retomada pelo checkpoint.
7. Confirme que nenhuma mensagem histórica criou não lidas ou substituiu a última atividade recente.
