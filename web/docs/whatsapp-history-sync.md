# Sincronização de histórico WhatsApp

Na Inbox, use **Sincronizar histórico** para criar ou retomar o job da sessão WAHA conectada. A API também aceita `POST /api/v1/inbox/sync/start` com `{ "wahaSession": "..." }`; sem esse campo, ela seleciona a sessão conectada do workspace. Consulte `GET /api/v1/inbox/sync/status?wahaSession=...` e interrompa com `POST /api/v1/inbox/sync/cancel`.

O job busca chats em páginas de 20 e mensagens em páginas de 50, importando no máximo 100 chats ou 1.000 mensagens por execução. Ao alcançar o limite, fica em `pending` com checkpoint preservado; inicie novamente para continuar. Timeouts e indisponibilidade recebem até três tentativas com backoff exponencial. Erros de validação, autorização ou não encontrado falham sem retry e podem ser retomados manualmente após correção.

## Checklist de validação real

1. Inicie API e worker e confirme a sessão `WORKING`.
2. Inicie uma execução pequena e confira status e contadores.
3. Compare uma conversa direta, um grupo e uma mensagem com mídia.
4. Repita o job para confirmar idempotência.
5. Envie ou receba uma mensagem durante a execução e confirme que permanece única.
6. Cancele no meio de uma página, inicie novamente e confirme a retomada.
7. Confirme que nenhuma mensagem histórica criou não lidas ou substituiu a última atividade recente.
