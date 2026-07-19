# Envio seguro de anexos pela Inbox

O bucket `chatpro-temporary-attachments` é privado. A migration cria/atualiza-o com limite de 50 MB e os MIME types permitidos; não crie política para `anon` ou `authenticated`. Apenas a API e o worker usam `SUPABASE_SERVICE_ROLE_KEY`, que nunca deve chegar ao dashboard.

O dashboard faz `POST /api/v1/inbox/conversations/:id/attachments` como `multipart/form-data`, com o campo `file` e `caption` opcional. A API valida tamanho, MIME e assinatura binária quando aplicável, gera a chave `workspace/conversation/job/nome-saneado`, grava o job e envia ao bucket. O objeto não é público.

O worker recebe uma URL assinada de 300 segundos e chama `POST /api/sendFile` do WAHA 2026.7.1 com `{ session, chatId, file: { url, mimetype, filename }, caption? }`. Base64 e caminhos locais não são usados. Um 2xx muda o job para `sent`; o webhook `message.any` de saída é a confirmação final (`confirmed`). A URL e o conteúdo não entram nos logs.

Limites: imagens JPEG/PNG/WebP, 15 MB; áudio OGG/MP3/MP4/WebM, 25 MB; vídeo MP4/WebM, 50 MB; PDF/TXT/DOCX/XLSX, 25 MB. Executáveis e qualquer MIME não listado são rejeitados.

Configure em `web/.env.local`: `DATABASE_PROVIDER=supabase`, `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`, além das variáveis WAHA existentes. A limpeza remove o objeto na confirmação, no cancelamento e no varrimento de expirados (24 h); o job e seus metadados de auditoria permanecem.

## Checklist para teste real na segunda-feira

1. Aplicar as migrations e confirmar que o bucket é privado no painel Supabase.
2. Enviar um JPEG pequeno e confirmar `pending → sent → confirmed` após `message.any`.
3. Conferir que o URL assinado expira e que o objeto é removido após confirmação.
4. Testar PDF, áudio OGG e vídeo MP4 dentro dos limites em uma sessão WEBJS conectada.
5. Testar MIME falso, arquivo acima do limite, cancelamento antes do envio e duas workspaces distintas.
6. Simular indisponibilidade do WAHA e conferir no máximo três tentativas e erro sem dados sensíveis.
