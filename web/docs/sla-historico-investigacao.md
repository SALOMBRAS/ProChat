# Investigação: SLA marcando quase todo o painel como atrasado

Data: 2026-07-27. Workspace investigado: `default-workspace` (Supabase remoto,
somente leitura, apenas agregados).

## Sintoma relatado

O painel operacional mostrava 49 de 50 atendimentos ativos fora do SLA, com
atrasos de aproximadamente 77 horas e "espera média do atendente" de 71h 9min.
A hipótese levantada foi que o relógio do SLA estaria contando desde a
importação do histórico do WhatsApp, e não desde a chegada real da mensagem.

## Conclusão

**A hipótese não se confirma.** O relógio do SLA conta desde o horário real da
mensagem. Mensagens importadas pela sincronização de histórico não geram
métrica de SLA nenhuma, e isso já estava correto antes desta investigação.

Existe um defeito real na mesma área, mas ele é menor do que o sintoma sugere e
não explica o número principal.

## 1. De onde vem `waitingSinceAt`

`waitingSinceAt` é definido exclusivamente em `SlaService.message`
(`apps/api/src/services/sla.service.ts:34`), sempre a partir do parâmetro
`occurredAt`, tanto na criação da linha quanto em cada transição de direção.
`projectSla` deriva dele o tempo de espera e o `deadlineAt`.

Quem alimenta `occurredAt`:

- Webhook ao vivo: `waha-webhook.service.ts:55` passa `event.occurredAt`, que é
  o timestamp do evento WAHA.
- Envio pelo Inbox: `internal-inbox.service.ts:46` passa `persisted.timestamp`.

Em nenhum dos dois o horário de ingestão substitui o horário da mensagem.

## 2. Caminho do histórico comparado ao do webhook

A sincronização de histórico não tem caminho próprio de persistência: ela monta
um registro com `historyRecord` e o entrega ao mesmo `ingest` do webhook
(`whatsapp-history-sync.service.ts:159-160`).

`historyRecord` (`waha-webhook.service.ts:120`) marca o payload com
`_history: true`. `messageFrom` (`waha-webhook.service.ts:122`) converte isso em
`historical: true`, e `SlaService.message` (`sla.service.ts:35`) retorna antes
de qualquer escrita quando `historical` é verdadeiro.

Ou seja: **o histórico importado já não gera métrica de SLA**. A diferença entre
os dois caminhos é exatamente essa flag, e ela está sendo propagada.

### Evidência no banco

| Medida | Valor |
| --- | --- |
| Mensagens totais | 2943 |
| Vindas da sincronização de histórico (`external_event_id` começa com `history:`) | 822 |
| Vindas do webhook ao vivo | 2121 |
| Conversas | 647 |
| Linhas em `conversation_sla_metrics` | 50 |

Se o histórico iniciasse contagem, haveria métrica para uma fração muito maior
das 647 conversas, não 50.

Atraso de ingestão das mensagens de entrada ao vivo
(`received_at` − `occurred_at`), n = 998:

| p50 | p90 | máximo | acima de 1h |
| --- | --- | --- | --- |
| 1s | 12s | 1h46min | 18 |

O webhook entrega em tempo real. Não há replay de histórico em massa entrando
por ele, que seria a única forma de o horário antigo virar início de SLA sem a
flag `_history`.

## 3. O defeito que existe de verdade

`SlaService.tick` marcava como `expired` **qualquer** linha cujo indicador
estivesse vermelho, inclusive as que estavam em `waiting_customer`:

```ts
if (projected.slaIndicator === 'red' && row.slaStatus !== 'expired')
```

Uma conversa já respondida entra em `waiting_customer`. Se o cliente fica calado
além de `customerWaitingThresholdMs` (24h por padrão), o indicador fica vermelho
e a linha virava `expired`. A partir daí o dado passa a mentir, porque `expired`
é agrupado com `waiting_operator` em todo o resto:

- `projectSla:17` soma o tempo decorrido em `operator`, não em `customer`;
- `projectSla:19` passa a reportar esse tempo como `waitingTime` do atendente;
- `projectSla:20` troca o limite de 24h (cliente) por 15min/5min (atendente);
- `summary.totals.waitingOperator` conta a conversa como aguardando atendente;
- `summary.averages.operatorWaitSeconds` inclui o silêncio do cliente na média.

O resultado é uma conversa que **foi respondida** aparecendo como violação de
SLA da equipe, com o silêncio do cliente contado como demora do atendente.

### Correção

`tick` só promove a `expired` quem está em `waiting_operator`. Uma conversa
parada esperando o cliente continua `waiting_customer`, seu tempo continua em
`customerWaitingMs` e ela sai das médias e totais do atendente. Como `expired`
passa a só existir a partir de uma espera do atendente, o agrupamento
`waiting_operator | expired` em `projectSla` fica correto por construção.

O indicador vermelho por silêncio do cliente continua existindo em `projectSla`,
então a conversa parada segue visível no painel — ela deixa de ser contabilizada
como falha da equipe, que é o ponto.

### Tamanho real do defeito

Das 49 linhas `expired` no workspace:

| Origem | Quantidade |
| --- | --- |
| `waiting_since_at` = último **outbound** (estavam em `waiting_customer`, o `tick` virou) | 3 |
| `waiting_since_at` = último **inbound** (atraso real do atendente) | 46 |

As 3 linhas afetadas reportavam 72,4h, 67,4h e 42,5h de silêncio do cliente como
espera do atendente.

Média de espera do atendente como o painel calcula hoje: 68,7h (n=49).
Excluindo as 3 linhas indevidas: 69,2h (n=46).

## 4. O número principal não é defeito

46 das 50 conversas ativas têm uma mensagem de entrada real, recente, e
**nenhuma resposta jamais enviada** — nem pelo ChatPro, nem pelo celular. 38 das
50 conversas não têm um único `outbound` em toda a sua história.

Para essas, "77 horas de atraso" é o tempo real desde a última mensagem do
cliente. O painel está certo.

O que o painel não modela é que uma conversa nunca trabalhada no ChatPro
acumula atraso para sempre: nada a resolve, arquiva ou tira do cálculo. Se a
equipe responde pelo celular sem que o WhatsApp propague o `fromMe` de volta,
ou se boa parte dessas entradas são mensagens avulsas que não pedem resposta, o
painel vai continuar vermelho depois desta correção. **Isso é decisão de
produto, não defeito de código, e está fora do escopo desta mudança.**

## 5. Correção retroativa

As 3 linhas viradas indevidamente para `expired` continuam erradas no banco: o
`tick` corrigido não as traz de volta, porque ele só promove, nunca reverte.

O SQL está proposto em `docs/migrations-propostas-sla.sql` e **não foi
executado**. Ele identifica as linhas pela assinatura do defeito
(`sla_status = 'expired'` com `waiting_since_at` igual ao `last_outbound_at`) e
as devolve para `waiting_customer`, sem tocar em nenhum acumulador.

As 46 linhas `expired` restantes são legítimas e não devem ser alteradas.
