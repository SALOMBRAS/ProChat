# Sincronização de histórico WhatsApp

Na Inbox, use **Sincronizar histórico** para criar ou retomar o job da sessão WAHA conectada. A API também aceita `POST /api/v1/inbox/sync/start` com `{ "wahaSession": "..." }`; sem esse campo, ela seleciona a sessão conectada do workspace. Consulte `GET /api/v1/inbox/sync/status?wahaSession=...` e interrompa com `POST /api/v1/inbox/sync/cancel`.

O job busca chats em páginas de 25 e mensagens em páginas de 100. Cada ciclo processa, por padrão, até 25 chats ou 1.000 mensagens; ao atingir esse ponto, o checkpoint é salvo, o estado fica brevemente em `pending` e o próximo ciclo inicia automaticamente. Não é necessário clicar novamente para concluir o histórico.

O sincronizador trabalha por ciclos: processa até 25 conversas e 1.000 mensagens por ciclo, em páginas de até 100 mensagens. Ao fim de um ciclo, o job permanece em `pending`, persiste o checkpoint e continua automaticamente no próximo ciclo. A única guarda de emergência é `WHATSAPP_HISTORY_SYNC_EMERGENCY_MAX_MESSAGES` (padrão: 100.000 por execução); ela não é um limite cumulativo do histórico. Erros de validação, autorização ou não encontrado falham sem retry e podem ser retomados manualmente após correção.

## Custo de leitura por offset

O motor WEBJS da WAHA paga um custo proporcional ao offset pedido. Medição real
contra um grupo do workspace, com a sessão `WORKING`:

| offset | tempo de resposta |
| -----: | ----------------- |
|      0 | 0,7 s             |
|    300 | 3,7 s             |
|  1.000 | 15,1 s            |
|  2.000 | 45–54 s           |
|  3.000 | 70,9 s            |

Duas consequências governam o comportamento do job:

- **Offset 0 é sempre barato**, mesmo em grupos com milhares de mensagens. Um
  timeout na primeira página de uma conversa nunca é explicado pelo tamanho dela,
  então só ele conta como evidência de provedor degradado. Timeouts mais fundos
  são a curva de custo e apenas encerram aquela conversa mais cedo.
- **Um timeout fundo é determinístico**, não transitório: repetir a chamada gasta
  o mesmo deadline de novo e deixa mais leituras concorrentes num provedor que já
  é o gargalo. Por isso o retry com backoff vale para a listagem de chats e para a
  primeira página de mensagens; a partir do offset 1 a conversa é encerrada na
  primeira falha, com o histórico já persistido preservado.

A partir de aproximadamente 1.500–2.000 mensagens, nenhuma conversa consegue ser
paginada até o fim dentro do deadline: o job encerra a conversa, registra o
`chatId` truncado no log `WhatsApp history sync closed a chat early` e segue para
as demais. Ao concluir, o rótulo informa que conversas muito longas foram
truncadas.

## Orçamento de tempo

Veja `docs/worker-command-budget.md`. Em resumo: a API anuncia um orçamento por
comando, o worker gasta **esse** orçamento entre todas as chamadas WAHA que a
página precisa, e o teto de profundidade de uma página é
`WORKER_TRANSPORT_TIMEOUT_MS` (padrão e máximo: 30 s), não `WAHA_TIMEOUT_MS`.

## Custo por mensagem

O job lê a linha do job no banco uma vez por página, não uma vez por mensagem.
Contra a instância remota do Supabase cada leitura custa ~162 ms medidos, então a
versão anterior gastava cerca de um quinto do tempo de execução perguntando ao
banco algo que só `cancel` muda — e `cancel` roda no mesmo processo. O
cancelamento continua interrompendo entre duas mensagens porque o serviço marca
a intenção em memória; a leitura por página permanece e cobre um cancelamento
gravado por qualquer outro processo.

## Listagem de conversas

A WAHA ordena os chats por atividade recente (`sortBy=conversationTimestamp&sortOrder=desc`)
e o job caminha por offset. Uma conversa que recebe mensagem sobe para o topo e
empurra as demais para trás, então a posição de um offset não é estável durante
uma execução longa. Evidência real: o job registrou `chatCursor=2` apontando para
`120363328209240027@g.us`, e duas horas depois essa conversa estava no offset 1.

Duas decisões contêm o efeito:

- **A página de 25 é consumida inteira antes de pedir a próxima.** Antes, cada
  conversa custava uma listagem própria — 550 chamadas para consumir 550
  conversas, cada uma sobre uma ordenação recém-calculada. Agora são ~22, e as 25
  conversas de uma página vêm todas do mesmo instantâneo.
- **Uma conversa já percorrida nesta execução não é percorrida de novo.** Quando
  o deslocamento faz o cursor cair sobre ela, o job avança sem repaginar: o
  histórico dela já está gravado e o que chegar depois entra por webhook.

O deslocamento não pula conversas: uma que sobe para o topo empurra as demais
para *baixo*, na direção que o cursor ainda vai percorrer. Ele causava releitura,
não perda. Eliminar o deslocamento por completo exigiria persistir o conjunto de
conversas já visitadas, o que hoje não cabe no schema do job.

## Provedor degradado

`maxConsecutiveChatTimeouts` (padrão: 5) existe para não marcar centenas de
conversas como processadas e vazias quando a WAHA está fora do ar. Como qualquer
página bem-sucedida zera o contador, o limiar só é alcançado por conversas que não
entregaram nada — isto é, cinco falhas seguidas na chamada mais barata possível.
Várias conversas profundas em sequência não derrubam o job: elas leem as primeiras
páginas antes de estourar mais fundo, e essa leitura já zera o contador.

## Retomada

`Retomar sincronização` retoma do checkpoint persistido: preserva `chatCursor`,
`messageCursor`, `currentChatId` e os contadores, limpando apenas o erro anterior.
Só um job já `completed` reinicia do zero. Um job deixado em `running` por um
processo interrompido é adotado pela próxima retomada depois de
`staleRunningAfterMs` (padrão: 5 minutos) sem escrita — sem isso o checkpoint
ficaria inalcançável, porque o botão da Inbox fica desabilitado enquanto o estado
persistido diz `running`.

Um job `failed` permanece visível como `Falhou; corrija o problema e retome` até
alguém retomá-lo: nada limpa a linha automaticamente. Um rótulo de falha antigo,
portanto, não significa que a sincronização falhou de novo — confira `updatedAt`
em `GET /api/v1/inbox/sync/status` antes de investigar.

## Corrida longa: sobreviver ao terminal e ao reinício

Uma conta grande leva horas. Três coisas precisavam mudar para que uma corrida
dessas chegue ao fim sem ninguém olhando.

**A WAHA era derrubada junto com o runtime.** `scripts/waha-runtime.mjs` chamava
`docker compose stop` em `SIGINT`/`SIGTERM`. Isso não só para o contêiner: marca
ele como parado de propósito, e é exatamente o que desliga o `restart:
unless-stopped` declarado no compose — depois de um `stop` a WAHA não volta nem
quando a máquina reinicia. Medido em 03/08/2026: o contêiner saiu com 143
(SIGTERM) no meio de uma corrida, com os logs mostrando requisições completando
normalmente até o último segundo. Não foi carga; foi o `stop`.

A correção é uma opção explícita, `--keep-waha` (ou `npm run dev:waha:keep`), e
não uma troca de política de restart. A política é global e não distingue as duas
intenções: trocar `unless-stopped` por `always` faria a WAHA ressuscitar no boot
mesmo depois de uma parada deliberada, comprando a corrida longa ao preço de
tirar do operador a capacidade de desligar. Quem sabe qual intenção vale é quem
invoca o runtime, então a escolha mora lá, com o comportamento de
desenvolvimento — Ctrl-C derruba tudo junto — como padrão.

**Nada retoma a sincronização sozinho.** Nenhum caminho de boot chama
`historySync.start()`; o job só anda quando alguém bate em
`POST /inbox/sync/start`. Mas esse POST é idempotente por construção:
`createStart` devolve a visão do job sem relançar enquanto ele está `running` e
teve checkpoint há menos de `staleRunningAfterMs` (5 min). Então um temporizador
que bate de tempo em tempo é seguro e cobre os três casos — corrida saudável não
faz nada, processo morto deixa o job velho e ele é adotado do cursor, job
`failed` é retomado.

Cinco minutos é o intervalo certo porque é o mesmo `staleRunningAfterMs`, e uma
corrida saudável escreve checkpoint a cada página — a página mais lenta já medida
levou 36 s, bem abaixo da janela.

**Fechar o terminal mata a árvore.** O runtime roda em primeiro plano. Para
sobreviver ao logout e ao reinício, ele precisa de uma unit de usuário com
`loginctl enable-linger`; sem o linger, o gerenciador de sessão do usuário não
sobe no boot e nada disso acontece. Uma unit de usuário não pode declarar
dependência de `docker.service`, que é do sistema — em vez disso ela apenas
falha e é reiniciada até o docker existir.

## Checklist de validação real

1. Inicie API e worker e confirme a sessão `WORKING`.
2. Inicie uma execução e confira que os contadores passam por mais de um lote sem novo clique.
3. Compare uma conversa direta, um grupo e uma mensagem com mídia.
4. Repita o job para confirmar idempotência.
5. Envie ou receba uma mensagem durante a execução e confirme que permanece única.
6. Cancele no meio de uma página, inicie novamente e confirme a retomada pelo checkpoint.
7. Confirme que nenhuma mensagem histórica criou não lidas ou substituiu a última atividade recente.
