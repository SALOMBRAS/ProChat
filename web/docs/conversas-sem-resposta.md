# Investigação: conversas sem resposta e violação permanente de SLA

Data: 2026-07-27 (medições ao fim da tarde, UTC). Workspace investigado:
`default-workspace`, Supabase remoto, **somente leitura** — nenhuma migration,
nenhum DDL, nenhuma escrita.

> **Estado em 2026-07-28:** a correção de ingestão descrita na seção 6 foi
> implementada. A limpeza retroativa dos dados já gravados continua pendente de
> aprovação, com o SQL proposto em
> `docs/migrations-propostas-eventos-sistema.sql`. A modelagem de "conversa
> nunca trabalhada" (seção 7) segue em aberto, como decisão de produto.

## Sintoma relatado

38 das 50 conversas ativas não têm um único `outbound` em toda a sua história e
46 aparecem como violação de SLA com aproximadamente 77 horas de espera. Três
hipóteses estavam em disputa:

- **(a)** a equipe responde pelo celular e o `outbound` não volta pelo webhook;
- **(b)** são mensagens avulsas que não pedem resposta;
- **(c)** são atendimentos realmente abandonados.

## Conclusão

**A hipótese (a) está refutada.** O webhook entrega mensagens enviadas pelo
celular e o ChatPro as persiste corretamente: há 276 `outbound` na base que
entraram exclusivamente pelo webhook, 236 deles carimbados pelo WAHA com
`source: "app"` — ou seja, digitados no aplicativo do celular, fora do ChatPro.

**A hipótese (c) se sustenta para 5 das 50 conversas** (2 grupos e 3 diretas).

**A hipótese (b) se sustenta para as 38 restantes, mas por uma causa diferente
da suposta.** Não são "mensagens avulsas" enviadas por clientes: são
**notificações de sistema do WhatsApp**, que não são mensagem nenhuma. As 38
conversas sem `outbound` do painel são, todas elas, conversas cujo conteúdo
integral são eventos como "o código de segurança mudou" e avisos de conta
comercial. Nenhum ser humano escreveu nada nelas — nem o cliente, nem a equipe.

Existe portanto um defeito de ingestão, mas ele é o oposto do que a hipótese (a)
descrevia: **não é `outbound` que se perde, é `inbound` que se inventa.** O
normalizador lê o tipo da mensagem no campo errado do payload WAHA, classifica
toda notificação de sistema como texto de entrada e liga o relógio de SLA. Como
nenhum evento simétrico o desliga, a conversa acumula atraso para sempre.

## 1. Método e base medida

Todas as consultas foram `SELECT` via PostgREST com a chave de serviço, agregadas
localmente. Nenhum identificador técnico, telefone ou conteúdo de mensagem é
reproduzido aqui.

| Medida | Valor |
| --- | --- |
| Conversas | 647 (620 visíveis, 26 em quarentena, 1 técnica) |
| Mensagens | 2 943 |
| Eventos de webhook armazenados | 11 718 (`message` 3 682, `message.any` 5 175, `session.status` 2 863) |
| Linhas em `conversation_sla_metrics` | 50 |
| Linhas em `workspace_sla_config` | 0 — valem os padrões de `sla.service.ts:13` |

Como não há configuração gravada, os limites em vigor são os padrões: primeira
resposta 5 min, espera do operador 15 min, espera do cliente 24 h, alerta a 80 %.

Estado do painel no momento da medição, reproduzindo a aritmética de
`SlaService.summary` (`sla.service.ts:47`):

| Indicador | Conversas |
| --- | --- |
| Vermelho (fora do SLA) | 49 |
| Amarelo | 0 |
| Verde | 1 |

49 linhas estão em `expired` e 1 em `waiting_customer`. A espera vai de 1,7 h a
78,8 h, com média de 72,3 h entre as vermelhas. O número relatado de 46 é
compatível: é uma medição anterior da mesma população, que cresce sozinha porque
nada a interrompe.

## 2. A hipótese (a) está refutada

### 2.1 O evento chega

`docker-compose.waha.yml:24` registra `WHATSAPP_HOOK_EVENTS:
message,message.any,session.status`. Nenhum ponto do repositório configura
webhooks por API: `waha-client.ts:40` cria a sessão com `POST /api/sessions`
enviando apenas `{ name }` e `waha-client.ts:41` a inicia sem corpo, então vale a
lista global do compose. `message.any` cobre mensagens com `fromMe: true`.

A confirmação não é teórica. A base contém eventos `message.any` de saída
efetivamente gravados, e o campo `source` do próprio WAHA separa a origem:

| Origem do `outbound` | Quantidade | Como se identifica |
| --- | --- | --- |
| Webhook, `source: "app"` — **enviado do celular** | 236 | `external_event_id` = id cru do WAHA |
| Webhook, `source: "api"` | 40 | idem |
| Envio pelo Inbox do ChatPro | 13 | `external_event_id` começa com `outbound:` |
| Sincronização de histórico | 363 | `external_event_id` começa com `history:` |
| **Total** | **652** | |

Os 236 com `source: "app"` são a prova direta: mensagens que a equipe digitou no
celular, que o WhatsApp propagou, que o WAHA entregou e que o ChatPro gravou.
Elas se distribuem por todos os dias do período, inclusive 24/07 (40 mensagens) e
27/07 (71 mensagens) — exatamente os dias em que as conversas do painel estariam
supostamente sem resposta.

### 2.2 O código processa o evento

`messageFrom` (`waha-webhook.service.ts:122`) deriva
`direction = value.fromMe === true ? 'outbound' : 'inbound'`. Para o payload real
do WEBJS, que não traz `chatId`, `remoteJid` nem `participant`,
`chatIdFromPayload` (`:135`) cai no fallback `firstValid(value.to)` e usa o
destinatário como conversa. `isOwnChatId` (`conversation-identity.ts:41`) não
derruba o evento porque, para `direction === 'outbound'`, o código nunca lê
`from`. O coordenador de SLA é chamado fora do guard de direção
(`waha-webhook.service.ts:55`), então um `outbound` que chegue é honrado.

Confirmado no banco: as 7 linhas de SLA com `first_response_at` preenchido foram
marcadas por mensagens reais (2 de texto, 4 de voz, 1 de imagem), nenhuma delas
originada no Inbox.

### 2.3 O que isso descarta

Fica descartado que o `fromMe` do celular se perca na entrega do WAHA, no
descarte de `messageFrom`, na resolução de identidade ou na deduplicação. Os três
construtores de evento carimbam prefixos distintos em `external_event_id`
(`webhookRecord` id cru, `outboundRecord` `outbound:`, `historyRecord`
`history:`), e a chave primária de `whatsapp_messages` é o
`external_message_id` — o eco do webhook de uma mensagem enviada pelo Inbox é
suprimido, mas isso só alcança ids já gravados, nunca uma mensagem do celular.

## 3. A causa real: notificação de sistema virando mensagem de entrada

### 3.1 O mecanismo

O payload de mensagem do WAHA/WEBJS **não tem** a chave `type` na raiz. O tipo
real fica em `payload._data.type`. Verificado nas 140 notificações
`e2e_notification` da base: `payload.type` está ausente em 140 de 140.

Três leituras dependem desse campo e todas erram:

1. `mediaType(text(value.type), mime, value.hasMedia === true)`
   (`waha-webhook.service.ts:122`, função em `:149`). Sem `type`, sem mime e sem
   mídia, o retorno é `'text'`.
2. `isTechnical` (`:140`) testa `text(payload.type)?.toLowerCase() ?? ''` contra
   `['ack','receipt','reaction','status','protocol','revoked']`. Com o campo
   ausente, compara `''` — nunca casa.
3. `resolveConversationIdentity` (`conversation-identity.ts:24`) recebe o
   `messageType` já resolvido como `'text'`, então `isTechnicalInput` (`:35`)
   também não filtra.

Resultado: uma notificação de sistema é persistida como `whatsapp_messages` com
`direction = 'inbound'`, `message_type = 'text'`, corpo vazio; cria ou atualiza a
conversa; incrementa `unread_count`; publica `message.received` no realtime;
aciona a automação de Kanban; e chama `SlaService.message`, que cria a linha de
métrica com `waitingSinceAt = occurredAt` (`sla.service.ts:38`).

Nenhuma ocorrência de `e2e_notification`, `notification_template`, `call_log`,
`gp2` ou `_data` existe em todo o código de produção — o tipo real nunca é lido.

### 3.2 O tamanho do problema

433 das 2 943 mensagens (15 %) são eventos de sistema gravados como mensagem.
**Todas as 433 receberam `message_type = 'text'`.**

| `_data.type` | Entrada | Saída | O que é |
| --- | --- | --- | --- |
| `e2e_notification` | 130 | 10 | "o código de segurança mudou" (`subtype: encrypt`) |
| `call_log` | 73 | 124 | registro de chamada de voz/vídeo |
| `notification_template` | 47 | 24 | avisos de conta comercial, modo temporário, troca de número |
| `gp2` | 1 | 23 | entrada/saída/remoção de participante de grupo |
| `revoked` | 1 | 0 | mensagem apagada |

Só os eventos que chegam **ao vivo** acionam SLA e Kanban; os importados pelo
histórico são barrados pelo guard `if (historical) return` (`sla.service.ts:35`),
que continua correto. Ao vivo, a entrada é assimétrica:

| Ao vivo (aciona SLA) | Quantidade |
| --- | --- |
| `e2e_notification` **de entrada** | 130 |
| `notification_template` **de entrada** | 44 |
| Qualquer evento de sistema **de saída** | 0 |

**174 eventos de entrada falsos ligaram o relógio e nenhum evento de saída o
desligou.** É por isso que o painel fica integralmente vermelho: o defeito só
empurra numa direção.

### 3.3 Efeito fora do SLA

164 das 647 conversas (25 %) existem exclusivamente por causa desses eventos —
não há uma única mensagem real nelas. Todas estão marcadas como `visible`, 143
diretas e 21 de grupo. 68 delas exibem `unread_count > 0`, e a prévia na lista é
o texto genérico `Mensagem` (84) ou vazia (80).

Ou seja: um quarto da Inbox é conversa fantasma, com badge de não lida.

## 4. As 50 conversas do painel, classificadas

Classificação por natureza real do conteúdo (`_data.type`), não por `body`, para
não confundir mídia sem legenda com ausência de conteúdo:

| Grupo | Conversas | Descrição |
| --- | --- | --- |
| Só evento de sistema, nenhum `outbound` | 34 | nenhuma mensagem humana, em nenhuma direção |
| Só evento de sistema, `outbound` também de sistema | 4 | o "outbound" é `call_log`/`gp2` importado do histórico |
| Cliente escreveu, ninguém respondeu | 5 | 2 grupos e 3 diretas |
| Conversa real, com resposta real | 7 | fluxo normal |
| **Total** | **50** | |

As **38** conversas "sem `outbound`" citadas no sintoma e as **38** conversas
"só de sistema" são conjuntos numericamente iguais mas **não idênticos**: os 2
grupos com centenas de mensagens reais estão no primeiro e não no segundo, e 4
conversas de sistema com `call_log` de saída estão no segundo e não no primeiro.
A coincidência de número é acidental e vale registrar para não induzir erro em
auditoria futura.

O que ancora o relógio de cada linha, cruzando `waiting_since_at` com a mensagem
daquele instante:

| Âncora de `waiting_since_at` | Linhas |
| --- | --- |
| `e2e_notification` | 32 |
| `notification_template` | 10 |
| Mensagem de texto real | 6 |
| Mensagem de voz real | 2 |

**42 das 50 linhas de SLA medem atraso a partir de um evento que não é
mensagem.** As 8 restantes medem atraso real.

### Correção de registro

`docs/sla-historico-investigacao.md` (seção 4) afirma que "46 das 50 conversas
ativas têm uma mensagem de entrada real, recente, e nenhuma resposta jamais
enviada" e conclui que "o painel está certo". A primeira afirmação não se
sustenta: aquela investigação não abriu os payloads, e 42 das 50 âncoras são
eventos de sistema. A conclusão de que o histórico importado não gera SLA
permanece correta e foi reconfirmada aqui.

Nota de auditoria adicional: o commit `4f351e1`, citado como PR #25, é um commit
**vazio** — sua árvore é idêntica à do pai (`b44b17d` em ambos). A mudança de uma
linha em `SlaService.tick` foi entregue dentro de `adc67c6`. Quem tentar ler a
correção por `git show 4f351e1` conclui erradamente que nada mudou.

## 5. Por que o atraso nunca para de crescer

Independentemente da origem do evento, o desenho atual não tem freio:

- O limite aplicado a uma conversa nunca respondida é o de **primeira resposta**,
  5 min por padrão (`sla.service.ts:20`), não o de 15 min do operador. Fica
  vermelha 5 minutos depois do primeiro `inbound`.
- `projectSla:16-17` soma `now - waitingSinceAt` sem teto e sem decaimento, e
  `expired` é tratado como sinônimo de `waiting_operator`.
- O `tick` (`:54`) só promove a `expired`, nunca reverte. Depois disso o vermelho
  é incondicional (`:21`), mesmo que os limites do workspace sejam afrouxados.
- As duas únicas saídas são um `outbound` não histórico (`:42`) ou
  `SlaService.status` (`:45`), que congela a linha.
- `SlaService.status` é chamado de exatamente dois lugares, ambos condicionados a
  arrastar o card do Kanban para uma etapa `resolved`/`archived`
  (`kanban.service.ts:22`, `supabase-kanban.service.ts:31`). Não há rota HTTP
  dedicada, não há ação em lote e não há automação.
- **O seletor "Status" da Inbox, com as opções "Resolvida" e "Arquivada", não
  congela o SLA.** Ele passa por `ConversationManagementService.setStatus`, que é
  construído sem dependência de SLA. São duas alavancas com o mesmo rótulo em
  duas telas e só a do Kanban funciona.
- `listDue` (`:63` e `:73`) filtra apenas `frozen_at IS NULL`. Conversas em
  quarentena continuam contando SLA, ao contrário do Kanban, que filtra
  `visibilityState = 'visible'`.
- O contador "Congeladas" do painel é estruturalmente sempre 0, porque `listDue`
  já exclui as congeladas antes do cálculo (`:47`).
- `firstResponseSeconds` exclui justamente as conversas nunca respondidas, porque
  `firstResponseTime` é nulo nelas. Com 38 de 50 sem resposta, o card "tempo
  médio da primeira resposta" é calculado sobre no máximo 12 conversas e pode
  parecer saudável com o painel inteiro vermelho.

## 6. Correção da ingestão — **implementada**

Entregue em `fix/ingestao-eventos-sistema`. O que mudou:

1. **O tipo real passou a ser lido.** `wahaMessageType`
   (`waha-webhook.service.ts`) resolve `payload.type` e, quando ele está
   ausente, `payload._data.type`. A raiz vem primeiro de propósito: o payload
   sintético de `outboundRecord` não tem `_data` e traz `type: 'text'` na raiz —
   medido, as 13 mensagens enviadas pelo Inbox são exatamente as 13 mensagens da
   base sem `_data`. Ler só `_data` faria o produto descartar o próprio envio.
2. **A lista de tipos técnicos virou fonte única.** Estava duplicada entre
   `isTechnical` e `isTechnicalInput`, que podiam divergir. Agora
   `conversation-identity.ts` exporta `isTechnicalMessageType` e os dois pontos
   consultam a mesma constante, acrescida de `e2e_notification`,
   `notification_template`, `gp2` e `ciphertext`.
3. **O descarte acontece antes de persistir**, no mesmo ponto onde já se
   descartava um `chatId` inválido, com `discardReason: 'technical_message_type'`
   e o tipo recebido no log. O evento bruto continua gravado em
   `waha_webhook_events` antes de qualquer decisão, então nada deixa de ser
   auditável: o que some é a conversa fantasma, não o registro do que chegou.
4. **Cobertura.** 10 testes novos. Seis falham sem a correção — a resolução de
   identidade dos quatro tipos, o helper de classificação, e cada uma das três
   consequências em separado: não vira mensagem, não cria conversa, não
   incrementa não lidas, não abre linha de SLA. Os outros quatro são guardas de
   regressão que passam dos dois lados de propósito: a mensagem real do WEBJS
   (tipo só em `_data`), o payload do Inbox (tipo na raiz, sem `_data`), e a
   caracterização do `call_log`, que segue sendo persistido.
5. **Paridade.** A mudança está inteiramente no normalizador compartilhado pelos
   dois provedores, antes da bifurcação SQLite/Supabase. Nenhuma migration.

### O que deliberadamente NÃO mudou

- **`call_log` continua sendo persistido.** Uma chamada perdida é informação
  operacional, e decidir se ela pede resposta é decisão de produto. São 197
  mensagens na base. Há um teste caracterizando o comportamento atual para que a
  decisão, quando vier, seja explícita.
- **O vocabulário de `message_type` não foi remapeado.** `mediaType` continua
  derivando o tipo armazenado da raiz e do mime, como antes. Ligar `_data.type`
  nele trocaria `text` por `chat`, `audio` por `ptt` e `image` por `sticker` em
  toda mensagem futura, mexendo em prévia, renderização da Inbox e proxy de
  mídia. É mudança maior, com risco próprio, e não é necessária para o defeito
  aqui: o que abre conversa indevida é a classificação técnica, não o rótulo.
- **`biz_content_placeholder` ficou de fora.** Semanticamente é candidato, mas na
  base só aparece no histórico importado (12 ocorrências, nenhuma ao vivo).
  Incluir sem medição seria adivinhação.

### Um terceiro ponto lê a raiz — encontrado, não corrigido aqui

`waha-webhook.controller.ts:19` passa
`messageType: firstString(event.payload.type) ?? null` para
`WhatsAppMediaPersistenceService.persist`. É a mesma leitura defeituosa, e o
valor é `null` em 100% do tráfego real: as únicas 13 mensagens com `type` na raiz
são as sintéticas do Inbox, que nunca têm mídia e portanto nunca chegam nesse
`persist`.

Consequência: `normalizedMime`
(`whatsapp-media-persistence.service.ts:51`) nunca dispara no caminho ao vivo —
`video`/`ptv` → `video/mp4`, `audio` → `audio/mp4` e `sticker` → `image/webp`
não acontecem, e a mídia vai para o Storage com content-type genérico.

Não foi corrigido nesta PR porque corrigir muda o content-type gravado da mídia,
o que é blast radius de armazenamento e merece teste próprio. Achado
independente do mesmo levantamento: `pendingMedia` (`waha-webhook.service.ts:69`
e `:103`) não seleciona a coluna `message_type`, então `importPending` sempre
chama `persist` com `messageType` indefinido — esse ramo do reparo de mime
estaria morto mesmo sem o defeito de `payload.type`.

Auditados e **não** afetados: `id`, `body`, `from`, `to`, `fromMe`, `hasMedia`,
`media`, `timestamp` — todos existem na raiz e estão entre as 13 chaves medidas.
`text`, `sender` e `mediaUrl` são fallbacks herdados de outro formato, inertes.
`replyTo` alimenta `quoted_message_id`, que nenhum consumidor lê no monorepo
inteiro — não há efeito observável, e se há lacuna ali ela é latente.

### Limpeza retroativa — proposta, **não executada**

A correção impede novos casos e não desfaz os já gravados. O SQL está em
`docs/migrations-propostas-eventos-sistema.sql`, com os `SELECT` de conferência
liberados e o `DELETE`/`UPDATE` comentados. Medido em 2026-07-28 (a base é viva;
os números de 2026-07-27 nas seções anteriores mudaram um pouco):

| Alvo | Quantidade |
| --- | --- |
| Mensagens que a nova regra classifica como técnicas | 237 de 3 007 (8 %) |
| — `e2e_notification` / `notification_template` / `gp2` / `revoked` | 141 / 71 / 24 / 1 |
| Conversas que ficariam sem nenhuma mensagem | 156 (134 diretas, 22 grupos) |
| — destas, com badge de não lida | 68 |
| — destas, com `contact_id` vinculado | 69 |
| Conversas mistas: têm técnica **e** real | 17 (37 mensagens técnicas dentro) |
| Linhas de SLA em conversas que somem (cascata da FK) | 37 |
| Linhas de SLA em conversas que sobrevivem | 6 |
| Eventos brutos preservados em `waha_webhook_events` | 12 917 — nada os toca |

Três cuidados que o SQL documenta e que não são óbvios:

1. **As 17 conversas mistas não podem ser apagadas.** Só as mensagens técnicas
   saem; a conversa e o histórico real ficam.
2. **As 6 linhas de SLA que sobrevivem precisam de recálculo, não de remoção.**
   O relógio delas está ancorado numa mensagem técnica que vai deixar de existir.
   Apagar a mensagem não conserta a métrica — deixa-a apontando para o vazio. E
   os acumuladores (`operator_waiting_ms`, `customer_waiting_ms`) absorveram
   intervalos medidos a partir de eventos técnicos, sem como separá-los. Se a
   exatidão importar, o caminho honesto é apagar a linha e deixar a próxima
   mensagem real recriá-la.
3. **Os contatos não são removidos em cascata.** Podem ser compartilhados com
   outra conversa ou criados à mão.

O SQL foi escrito a partir do formato medido, mas **não foi executado nem
validado sintaticamente contra o banco**: o acesso disponível é PostgREST, que
não roda SQL arbitrário. Confira os `SELECT` antes de descomentar qualquer coisa.

## 7. Como o painel deveria modelar conversa nunca trabalhada

As 5 conversas de abandono real e as que sobrarem depois da correção continuam
sem modelagem: hoje elas acumulam atraso para sempre e nada as resolve nem as
tira do cálculo. Propostas, da mais barata para a mais cara:

**Sem migration, só projeção e UI:**

1. **Separar "primeira resposta pendente" de "aguardando atendente".** O sinal já
   existe e já é usado para escolher o limiar (`firstResponseAt === null`,
   `sla.service.ts:20`), e já viaja até o card do Kanban (`projectSlaCard`, `:24`),
   mas nunca é exposto. Basta um bucket no resumo e um rótulo. Hoje uma conversa
   nunca respondida há 77 h e uma conversa em andamento aguardando a terceira
   resposta há 20 min aparecem como o mesmo estado.
2. **Corrigir a alavanca duplicada.** O `PATCH /inbox/conversations/:id/status`
   deve congelar o SLA quando o destino for `resolved`/`archived`, como o Kanban
   já faz. É o conserto de maior efeito imediato: parte das 46 pode já ter sido
   encerrada pela Inbox sem sair do painel.
3. **Expor `workspace_sla_config`.** As rotas existem (`routes/v1.ts:21`), o
   cliente do dashboard não tem método e não há formulário. O limiar de 5 min
   para primeira resposta, sem horário comercial, é irreal para atendimento por
   WhatsApp.
4. **Filtrar `visibility_state` no `listDue`**, alinhando SLA e Kanban.
5. **Publicar "% nunca respondidas" ao lado do tempo médio de primeira
   resposta**, que hoje omite exatamente esse grupo.
6. **Ação em lote no painel** para encerrar as críticas. Hoje seriam 38
   arrastares de card, um a um, sem seleção múltipla.

**Com decisão de produto e possivelmente migration:**

7. **Estado terminal de não atendimento.** A pergunta é se uma conversa nunca
   trabalhada deve continuar no numerador do SLA indefinidamente. Duas saídas:
   congelar por inatividade após um múltiplo do limiar, movendo o tempo para um
   contador próprio de "nunca atendidas"; ou manter no cálculo e assumir que o
   painel é um backlog, não um alarme. O estado `answered` está declarado no tipo
   e no CHECK dos dois bancos e **nunca é escrito por ninguém** — é um slot já
   validado nos dois provedores, mas sua semântica ("respondida") é errada para
   este uso. Um estado novo exige alterar o CHECK em SQLite e Supabase.

A recomendação é fazer 1, 2 e 4 junto com a correção de ingestão, tratar 3 e 5
em seguida, e levar 7 para decisão de produto com o painel já limpo — porque
depois de remover as conversas fantasma o problema pode caber nas 5 conversas
reais, e nesse tamanho ele talvez não precise de modelagem nova.

## 8. Não identificado

- **Se o WAHA de produção roda com `web/docker-compose.waha.yml`.** Não há
  manifesto de deploy no repositório nem diretório `.waha-sessions` no checkout.
  A lista efetiva de eventos foi inferida do compose e confirmada indiretamente
  pela presença de eventos `message.any` de saída no banco.
- **Qual engine WAHA está ativo.** O código nunca o fixa. Os payloads observados
  (chaves `_data`, `source`, `ackName`, ausência de `chatId` na raiz) são
  compatíveis com WEBJS, mas isso é inferência a partir do formato, não
  configuração lida.
- **Por que 40 `outbound` com `source: "api"` chegaram só pelo webhook**, sem o
  prefixo `outbound:` que o envio pelo Inbox carimba. A explicação plausível é
  corrida — o webhook chega antes da resposta da API de envio, e a chave primária
  suprime o segundo gravador — mas isso não foi confirmado.
- **Por que existem 18 mensagens `outbound` com `chat_id` terminado em `@lid` sem
  conversa correspondente.** Podem ser resíduo de canonicalização posterior ou de
  exclusão de contato. Não investigado.
- **Se o `tick` está vivo no ambiente agora.** As 49 linhas em `expired` provam
  que ele rodou; `app.ts:92` o condiciona a `nodeEnv !== 'test'` e usa
  `timer.unref()`. Estado atual do processo não verificado.
- **Se existem gatilhos, RPCs ou jobs no Supabase remoto** que escrevam em
  `conversation_sla_metrics` fora do código. As migrations versionadas só contêm
  `CREATE TABLE`, índice e `GRANT`.
- **O conteúdo de `WHATSAPP_OWN_NUMBERS`.** A variável existe em `.env.local` e
  não está documentada em `.env.example`; seu valor não foi lido, por regra da
  tarefa. Ela não participa do caminho de `outbound`, mas participa do de
  `inbound`.
- **A intenção do estado `answered`.** Declarado nos dois CHECKs e com rótulo no
  dashboard, nunca escrito. Não há comentário, teste ou documento que diga se é
  reserva ou resíduo.

## 9. Assimetria latente encontrada de passagem

`isChatIdentifier` (`waha-webhook.service.ts:139`) aceita `@c.us`, `@lid` e
`@g.us`, mas rejeita `@s.whatsapp.net` — que `isDirectChatId`
(`conversation-identity.ts:32`) aceita e que `normalizeWhatsAppIdentifier`
converte para `@c.us`. Um payload cujo `to` ou `from` venha nesse formato seria
descartado como `missing_chat_id` antes de chegar ao normalizador. Não há
nenhuma ocorrência desse formato na base medida, então isso **não** contribui
para o sintoma investigado; fica registrado por ser uma inconsistência real entre
duas definições do mesmo conceito.
