# Correção: sincronização de histórico travada em "Falhou"

Data: 2026-07-27. Ambiente do diagnóstico: Linux, `WHATSAPP_PROVIDER=waha`
(engine WEBJS), `DATABASE_PROVIDER=supabase`, runtime `npm run dev:waha`.

## O que era

A Inbox exibia `Histórico: Falhou; corrija o problema e retome` com o botão
`Retomar sincronização`, apesar de 618 conversas já carregadas.

O estado real do job, lido em `GET /api/v1/inbox/sync/status`:

```json
{
  "status": "failed",
  "currentChatId": "120363363444637332@g.us",
  "chatCursor": "0",
  "messageCursor": "300",
  "chatsProcessed": 0,
  "messagesProcessed": 300,
  "lastErrorSafe": "TIMEOUT"
}
```

Dois fatos importam nesse estado: o erro é `TIMEOUT`, e `chatsProcessed` é **0**
com `chatCursor` em **0**. A sincronização nunca passou da primeira conversa da
lista — um grupo — e por isso as outras 617 nunca foram sincronizadas.

### Causa raiz

O custo de uma página de mensagens na WAHA com engine WEBJS cresce
**linearmente com o offset pedido**. Medido diretamente contra a instância em
execução, no mesmo grupo (`limit=100`, `downloadMedia=false`):

| offset | tempo | bytes |
| --- | --- | --- |
| 0 | 0,68 s | 540 001 |
| 200 | 3,36 s | 532 400 |
| 300 | 5,25 s | 542 001 |
| 400 | 7,61 s | 528 806 |
| 500 | 13,03 s | 537 278 |

O custo é da **profundidade**, não do volume devolvido: `offset=1000&limit=1`
levou 21,2 s e `offset=2000&limit=1` levou 41,6 s, com payload de um único item.
A inclinação é de aproximadamente **21 ms por mensagem de profundidade**.

Paginar por cursor de timestamp não resolve: `filter.timestamp.lte` é suportado
pela WAHA, mas na mesma profundidade levou 11,25 s contra 13,03 s do offset —
mesma ordem de grandeza, mesma curva.

Com `WAHA_TIMEOUT_MS` no padrão de 10 000 ms, o `AbortController` de
`waha-client.ts` aborta qualquer página além de **~474 mensagens** de
profundidade. O grupo em questão tem mais de 2 000 mensagens, então a última
página necessária nunca caberia no timeout — nem com um timeout maior: o teto
rígido de `WORKER_TRANSPORT_TIMEOUT_MS` é 30 000 ms (`config.ts:35`), que
corresponde a ~1 400 mensagens de profundidade.

O caminho do erro era:

1. `waha-client.ts` aborta em `WAHA_TIMEOUT_MS` → `WahaClientError('timeout')`.
2. `waha-provider.ts:78` (`call`) mapeia `kind === 'timeout'` para o código `TIMEOUT`.
3. `whatsapp-history-sync.service.ts:166` — `TIMEOUT` está em `transientCodes`,
   então tenta 3 vezes (`maxAttempts`) **no mesmo offset**, todas falham, e
   lança `Error('TIMEOUT')`.
4. `whatsapp-history-sync.service.ts:152` — o `catch` do `run()` marca o **job
   inteiro** como `failed`.

O defeito é o passo 4: uma falha inerente a **uma** conversa derrubava a
sincronização **toda**. Como o job retomava sempre do mesmo `chatCursor: 0`,
o grupo era reprocessado e falhava de novo, indefinidamente. Nenhuma das outras
617 conversas tinha chance de ser sincronizada.

### Sobre as variáveis de lote

`WHATSAPP_HISTORY_SYNC_BATCH_CHATS`, `WHATSAPP_HISTORY_SYNC_BATCH_MESSAGES` e
`WHATSAPP_HISTORY_SYNC_EMERGENCY_MAX_MESSAGES` **não causam** e **não corrigem**
este problema. Elas alimentam `maxChatsPerRun`, `maxMessagesPerRun` e
`emergencyMaxMessages` (`app.ts:103`), que controlam quando o job faz checkpoint
e pausa — não o tamanho da página pedida à WAHA.

Achado colateral registrado aqui, sem alteração: `chatPageSize` e
`messagePageSize` **não são configuráveis por ambiente**. Ficam nos padrões 25 e
100 porque `app.ts:103` não os repassa. Reduzir a página também não ajudaria:
como medido acima, o custo vem do offset, não do `limit`.

## O que mudou

Um único arquivo de produção: `web/apps/api/src/services/whatsapp-history-sync.service.ts`.

1. **Isolamento da falha por conversa.** A busca da página de mensagens passou a
   ser envolvida por `try/catch`. Quando o código do erro é `TIMEOUT` (novo
   conjunto `chatScopedCodes`), a conversa é encerrada com o histórico já
   persistido: `currentChatId` e `messageCursor` são limpos, `chatCursor` avança,
   `chatsProcessed` incrementa, `lastErrorSafe` registra o motivo, e o laço
   continua na próxima conversa. Qualquer outro código de erro continua
   derrubando o job como antes — `NOT_FOUND`, `CONFLICT` e falhas de persistência
   mantêm o comportamento original.

2. **Guarda contra provedor degradado.** Se `maxConsecutiveChatTimeouts`
   conversas seguidas estourarem o timeout (padrão 5), o job falha de propósito.
   Sem isso, uma WAHA fora do ar marcaria as 618 conversas como processadas e
   vazias, silenciosamente. Um sucesso zera o contador.

3. **Rótulo honesto.** Um job que concluiu tendo truncado alguma conversa agora
   exibe `Histórico sincronizado; conversas muito longas foram truncadas.` em vez
   de `Histórico sincronizado.`. Sem isso, a truncagem ficaria invisível na
   Inbox, que só renderiza `progressLabel`.

Nenhuma migration foi criada ou aplicada. Nenhum campo novo foi adicionado ao
job: a marcação reusa `lastErrorSafe`, que já existe no schema SQLite e no
Supabase. Nenhuma dependência foi alterada.

### Consequência de comportamento

Conversas mais longas do que o timeout permite alcançar passam a ser
sincronizadas **parcialmente** — as mensagens mais recentes, até a profundidade
que a WAHA consegue entregar dentro de `WAHA_TIMEOUT_MS`. Isso é uma perda real
de histórico antigo nessas conversas, e é deliberado: a alternativa em vigor era
não sincronizar **nada**, em nenhuma conversa.

Aumentar `WAHA_TIMEOUT_MS` aumenta a profundidade alcançada antes da truncagem
(~21 ms por mensagem), com o teto rígido de 30 000 ms do transporte
API↔worker. Não foi alterado aqui por ser configuração de ambiente.

## Como foi validado

**Reprodução do erro real.** O estado do job foi lido pela API em execução, não
inferido: `lastErrorSafe: "TIMEOUT"` no grupo `120363363444637332@g.us`. A curva
de custo foi medida com chamadas diretas à WAHA (tabela acima).

**Testes automatizados.** Dois testes novos em
`web/apps/api/test/whatsapp-history-sync.service.test.ts`:

- `closes a chat that keeps timing out and still finishes the remaining history`
  — a primeira conversa sempre devolve `TIMEOUT`, a segunda sincroniza; o job
  termina `completed` com `chatsProcessed: 2`, `chatCursor: '2'`,
  `lastErrorSafe: 'TIMEOUT'` e rótulo de truncagem. Confirma também que a
  conversa problemática recebeu exatamente 3 tentativas.
- `fails the job when consecutive chats time out, instead of marking them processed`
  — com `maxConsecutiveChatTimeouts: 2`, o job falha em vez de varrer a lista.

Resultados, a partir de `web/`:

```
npm run typecheck   → exit 0, sem erros
npm test            → exit 0
```

Suíte completa: **228 testes passando** em 37 arquivos (linha de base antes da
mudança: 226 em 37; os 2 novos são os descritos acima). Nenhum teste existente
precisou ser alterado.

**Validação contra a WAHA real.** Um script temporário exercitou o serviço
corrigido contra o worker e a WAHA em execução, partindo do checkpoint exato do
job travado (`currentChatId` = o grupo, `messageCursor` = 300). O store de jobs
foi em memória e o `ingest` foi no-op, de propósito: a validação era do fluxo de
controle contra o provedor real, sem escrever no Supabase.

Sequência observada:

```
t=0s    running, chat=120363363444637332@g.us, messageCursor=300, chatsProcessed=0
t=30,8s "chat closed early after repeated provider timeout"  (3 tentativas)
        "WhatsApp history sync closed a chat early" chatId=120363363444637332@g.us offset=300
t=33s   chat=42241305379055@lid, chatCursor=1, chatsProcessed=1
t=51s   chat concluído, chatsProcessed=2, messagesProcessed=645
t=54s   chat=120363419464143076@g.us, chatCursor=2, msgs=745, 445 mensagens ingeridas
```

Antes da correção esse job ficava permanentemente em `chatsProcessed: 0`. Depois,
avançou por 3 conversas e 445 mensagens em 54 segundos, com o grupo problemático
registrado como truncado e a sincronização seguindo normalmente.

O script temporário foi removido e não faz parte do commit.

## O que não foi feito

- Nenhuma migration aplicada no Supabase remoto.
- Nenhuma dependência atualizada; `npm audit fix` não foi executado.
- O `.env.local` não foi alterado. Apenas nomes de variáveis aparecem neste
  documento.
- A sincronização completa das 618 conversas **não foi executada até o fim** —
  levaria horas e escreveria histórico em massa no Supabase. A validação
  comprovou que o bloqueio foi removido e que o job avança; a corrida completa é
  decisão operacional sua.

## Para aplicar

O trabalho está na branch `fix/history-sync-timeout`, criada a partir de
`feat/replace-repository-with-chatpro` (`4ce5559`). Depois de mesclar, clique em
`Retomar sincronização` na Inbox: o job retoma do checkpoint atual, fecha o grupo
problemático e segue para as demais conversas.
