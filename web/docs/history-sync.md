# Sincronização histórica em lotes

O sincronizador não usa mais um teto cumulativo de conversas ou mensagens.
Ele percorre o histórico em ciclos limitados: até 25 conversas por ciclo,
mensagens em páginas de 100 e orçamento de até 1.000 mensagens por ciclo.

O checkpoint persistido por workspace e sessão contém o chat atual, os
cursores de chat e mensagem e os contadores acumulados. Cada página concluída
é salva antes do próximo trabalho; uma retomada continua desse ponto e a chave
externa da mensagem torna replays idempotentes.

`pending` significa checkpoint recuperável aguardando o próximo ciclo;
`running` indica processamento ativo; `completed` só é usado após não haver
mais chats ou páginas. O guarda emergencial de 100.000 mensagens por execução
também deixa o job em `pending`, jamais em `completed`.
