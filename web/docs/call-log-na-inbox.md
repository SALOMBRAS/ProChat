# Chamadas perdidas na Inbox — decisão

**Decidido em 28/07/2026. Status: fechado.**

Chamadas perdidas do WhatsApp (`call_log`) **continuam aparecendo na Inbox como
hoje**. Nada muda no comportamento; esta decisão fecha uma pergunta que estava
explicitamente em aberto no código.

## O que estava em aberto

O commit `8db9f49` ("stop WhatsApp system events from becoming conversation")
introduziu `technicalMessageTypes` em
[`conversation-identity.ts`](../apps/api/src/services/conversation-identity.ts) —
a lista de eventos de manutenção do WhatsApp que nunca devem abrir conversa,
marcar não-lido nem iniciar relógio de SLA: `ack`, `receipt`, `reaction`,
`status`, `protocol`, `revoked`, `e2e_notification`, `notification_template`,
`gp2`, `ciphertext`.

`call_log` ficou **deliberadamente de fora**, com o comentário registrando que a
escolha era de produto, não de normalização (`conversation-identity.ts:42`):

> `call_log` is deliberately absent: a missed call is operational information,
> and whether it demands a reply is a product decision rather than a
> normalization one.

O teste correspondente carregava a mesma pendência no nome: *"still records a
call log, whose treatment is an open product decision"*.

## A decisão

**Manter `call_log` fora de `technicalMessageTypes`.** A chamada perdida continua
sendo persistida, continua abrindo ou atualizando a conversa, continua contando
como não-lida e continua iniciando o relógio de SLA.

## Por quê

**Uma chamada perdida é um pedido de contato, não manutenção de protocolo.** É a
diferença que separa `call_log` do resto da lista. Uma mudança de código de
segurança, um aviso de conta comercial ou uma alteração de participante de grupo
não são dirigidos a ninguém e ninguém os responde. Uma chamada perdida foi um
cliente tentando falar com a empresa e não conseguindo.

**O modo de falha dos eventos de sistema não se aplica aqui.** O problema que
`8db9f49` corrigiu foi um relógio de SLA *que nada podia parar*, porque nenhum
evento de sistema chega na direção outbound — a violação era inevitável e
fantasma. Com chamada perdida isso não acontece: o atendente responde por
mensagem, a resposta chega outbound e o relógio para pelo caminho normal. O SLA
mede exatamente o que deveria medir — quanto tempo a empresa levou para retornar
um contato perdido.

**Esconder degradaria o atendimento.** Se `call_log` entrasse na lista técnica, um
cliente que só ligou — e não mandou mensagem — sumiria da Inbox. Não haveria
conversa, não haveria não-lido, não haveria sinal. É a pior falha possível num
produto de atendimento: perder um contato de cliente em silêncio.

## O que isso implica

- A conversa aparece na Inbox com a identidade do WhatsApp, seguindo a cadeia de
  identidade normal (`profileName`/`pushName` → nome ChatPro → telefone
  normalizado → `Contato sem identificação`).
- O contador de não-lidos incrementa, como em qualquer mensagem inbound.
- O relógio de SLA começa a correr e é parado pela primeira resposta outbound.
- Se um dia houver relatório de chamadas separado, `call_log` é a fonte que já
  existe — não é preciso capturar nada novo para isso.

## Onde isso está trancado

| Onde | O quê |
|---|---|
| [`conversation-identity.ts:42`](../apps/api/src/services/conversation-identity.ts) | comentário explicando a ausência de `call_log` na lista, e a própria lista |
| [`waha-webhook.test.ts`](../apps/api/test/waha-webhook.test.ts) | `records a call log, keeping the missed call visible in the Inbox by decision` — teste que trava o comportamento |
| [`conversation-identity.test.ts`](../apps/api/test/conversation-identity.test.ts) | `call_log` entre os tipos que resolvem para conversa direta |

## Se isso for reaberto

Duas coisas a considerar antes:

1. **Não basta mover `call_log` para `technicalMessageTypes`.** Isso o descartaria
   por inteiro — nem a conversa existiria. Se a intenção for "mostrar mas não
   cobrar SLA", o lugar da mudança é a política de SLA, não a normalização.
2. **Um segundo canal de chamadas duplicaria o fato.** Se o ChatPro passar a ter
   chamadas próprias (ver [`wacalls-avaliacao-adiada.md`](./wacalls-avaliacao-adiada.md)),
   a mesma chamada perdida existiria como `call_log` vindo da WAHA **e** como
   registro do serviço de chamadas, em dois modelos diferentes, na mesma timeline.
   Reconciliar os dois é pré-requisito daquele projeto, não deste.

## Referências

- [`inbox-flow.md`](./inbox-flow.md) — o ciclo da Inbox
- [`sla-overview.md`](./sla-overview.md) — como o relógio de SLA é iniciado e parado
- [`whatsapp-flow.md`](./whatsapp-flow.md) — webhook, normalização e identidade
- Commit `8db9f49` — a correção que criou a lista de tipos técnicos
