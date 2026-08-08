# Fase 1 — proposta: sessões WAHA em `whatsapp_provider_sessions`

Proposta técnica. **Nada aqui foi implementado.** Complementa
`provider-session-architecture.md` e corrige um ponto dele (§6).

## 1. Objetivo

Criar uma linha `provider='waha'` em `whatsapp_provider_sessions` para cada
sessão WAHA existente, sem tocar em nenhuma tabela da Inbox e sem alterar o
comportamento do WAHA. É pré-requisito da Fase 2: hoje o resolver devolve
`undefined` para 100% das sessões WAHA, porque nenhuma linha existe.

## 2. Estado medido

Levantado em 08/08/2026 contra o Supabase de produção e o registry local.

Valores distintos de `waha_session`, idênticos nas quatro tabelas:

| `waha_session` | conversas | mensagens | identidades | grupos |
|---|---:|---:|---:|---:|
| `chatpro-87a9de04…` | 526 | 27.347 | 921 | 12 |
| `chatpro-42217e8d…` | 526 | 1.481 | 527 | 5 |
| `chatpro-a14338b9…` | 17 | 837 | 8.248 | 7 |
| `chatpro-6141eb2f…` | 10 | 492 | 10 | 5 |

Todas em `default-workspace`. Total: 1.079 conversas, 30.157 mensagens.

`whatsapp_provider_sessions` **não existe no Supabase remoto** (PostgREST
`PGRST205`). A migration precisa ser aplicada antes de qualquer coisa abaixo.

## 3. Como descobrir as sessões WAHA

A autoridade **não** é o banco: `waha_session` guarda o nome do lado da WAHA, e
esse nome não é invertível para o `sessionId` público. A autoridade é o registry
do worker, `<dataDir>/waha-sessions.json`, que é o único lugar com o par
`sessionId ↔ wahaName` e com os aliases.

O registry lido nesta máquina tem **uma** entrada, ativa, cobrindo três dos
quatro valores acima: um `wahaName` corrente e dois `aliases`.

Daí decorrem os dois problemas reais da fase.

### 3.1 O mapeamento é muitos-para-um

Uma sessão lógica possui `wahaName` + N `aliases`, todos presentes em linhas
históricas. `whatsapp_provider_sessions` tem `UNIQUE (provider,
providerDeviceId)` e uma coluna só: não cabe alias.

Proposta: a linha guarda o `wahaName` **corrente** em `providerDeviceId`, e os
aliases vão para `providerMetadataJson.aliases` (lista de strings). O guarda
`safeMetadata()` aceita — são hashes, não JID nem token. A Fase 2 resolve
`wahaSession → providerSessionId` consultando `providerDeviceId` **e** a lista
de aliases, e não apenas a coluna.

Alternativa descartada por ora: tabela `whatsapp_provider_session_aliases`. Mais
correta a longo prazo, mas é schema novo numa fase cujo objetivo é não mexer em
schema além da tabela que já existe.

### 3.2 Existe uma sessão órfã, e ela é metade da base

`chatpro-42217e8d…` **não aparece no registry**: nem como `wahaName`, nem como
alias. São 526 conversas (49% do total), 1.481 mensagens e 527 identidades sem
origem declarada.

Nenhum backfill deve rodar antes de isso ser explicado. As hipóteses a testar,
em ordem de custo:

1. o registry de produção é outro arquivo, e o desta máquina é de
   desenvolvimento — **verificar primeiro**, é a explicação mais provável e a
   mais barata;
2. a sessão foi removida e o registry compactado, perdendo o vínculo;
3. dado de uma instalação anterior à convenção de nomes atual.

Se a origem não for recuperável, a linha correspondente deve ser criada
explicitamente como `reconciliationState='unverified'`, jamais inventando um
`sessionId`. Perder o vínculo é aceitável; inventá-lo, não.

## 4. Como preencher `providerDeviceId`

Não há adivinhação: o nome é derivado, e a derivação foi verificada contra o
registry real (recomputação bateu).

```
wahaName = 'chatpro-' + sha256(`${workspaceId}:${sessionId}`).hex.slice(0, 40)
```

Fonte: `WahaProvider.wahaName`, `waha-provider.ts:156`. É a mesma construção do
GOWA (`GowaSessionRegistry.map`), com separador e prefixo diferentes — o que
significa que as duas famílias de `providerDeviceId` nunca colidem.

Portanto `providerDeviceId` deve ser **copiado do registry**, não recalculado, e
a recomputação usada apenas como *assert* de integridade: se divergir, a entrada
está corrompida e a sessão vai para exceção em vez de virar linha.

Demais colunas: `sessionId`/`sessionName` do registry; `provider='waha'`;
`chatproStatus='disconnected'` e `providerStatus='unverified'` (a fase não
consulta a WAHA); `capabilitiesJson` com as 9 capabilities que `WahaProvider`
declara; `reconciliationState='unverified'`; `lastReconciledAt=null`.

## 5. Como evitar duplicação

A tabela já impede o pior por construção — `UNIQUE (workspaceId, provider,
sessionId)` e `UNIQUE (provider, providerDeviceId)`. A escrita deve ser
idempotente por essas chaves (`ON CONFLICT DO NOTHING` no SQLite, `upsert` com
`onConflict` no Supabase), de modo que rodar duas vezes não crie nem altere
nada.

Duas travas adicionais, porque as chaves não cobrem tudo:

- **Entradas com `deletedAt`**: sessão retirada continua dona de linhas
  históricas. Deve gerar linha, com `chatproStatus='stopped'`. Ignorá-la deixa
  órfão na Fase 2.
- **Colisão de alias**: se o mesmo `wahaName` aparecer como corrente de uma
  sessão e alias de outra, é conflito de dados. Abortar e relatar; nunca
  escolher um dos dois.

## 6. Correção a `provider-session-architecture.md`

O documento diz que o backfill da Fase 2 deve resolver cada linha antiga por
`workspaceId + provider=waha + wahaSession`. **Isso não funciona.** Aquele
`wahaSession` é o `wahaName` (hash), e a chave citada compara contra
`sessionId` (o UUID público). A junção correta é

```
conversations.wahaSession  ↔  whatsapp_provider_sessions.providerDeviceId
                              (ou um item de providerMetadataJson.aliases)
```

que é exatamente o eixo que a §3.1 precisa cobrir. Vale corrigir o documento
antes que a Fase 2 seja escrita em cima da chave errada.

Nota relacionada, a resolver antes da Fase 2: o ingresso GOWA grava o
`sessionId` **público** na mesma coluna `wahaSession` em que o WAHA grava o
**hash**. A coluna carrega hoje duas semânticas conforme o provider.

## 7. Rollback

Trivial e sem perda, porque a fase só insere numa tabela que nada referencia:

```sql
DELETE FROM whatsapp_provider_sessions WHERE provider = 'waha';
```

Nenhuma FK aponta para lá e nenhuma tabela da Inbox mudou. O rollback da própria
tabela continua sendo `026_whatsapp_provider_sessions.rollback.sql`.

## 8. Resolver em modo sombra

Objetivo: responder "o backfill vai cobrir 100%?" **antes** de existir coluna
nova, medindo em produção sem alterar nenhum fluxo.

Contrato mantido — entrada `{workspaceId, provider, sessionId}`, saída
`providerSessionId`. Regras:

1. O resultado é **medido e descartado**. Nenhum caminho de leitura, escrita,
   envio ou realtime pode passar a depender dele nesta fase.
2. A chamada é `void`, fora do caminho de resposta: falha ou lentidão do
   resolver não pode alterar latência nem status de nenhuma rota.
3. Registrar por chamada: `workspaceId`, `provider`, `hit|miss` e duração.
   **Nunca** o `sessionId` cru nem o `providerSessionId` — a métrica é
   agregada, não um índice de sessões.
4. Ponto de instrumentação: o ingresso do webhook WAHA, que é onde o par
   (workspace, sessão) chega com maior volume e variedade.
5. Também é preciso um `resolveByProviderDeviceId`, já que na sombra o valor
   disponível é o `wahaSession` (hash) e não o `sessionId` — ver §6.

Critério de saída para a Fase 2: **100% de acerto** por vários dias, com a
sessão órfã da §3.2 explicada. Qualquer `miss` residual é uma linha que a Fase 2
deixaria para trás.

Cache: um `Map` por processo com TTL curto, chaveado por
`workspaceId|provider|sessionId`. Sem ele, a instrumentação vira uma consulta
por mensagem e viola a regra crítica 4 — na sombra, o custo apareceria como
carga extra no Supabase sem nenhum benefício.

## 9. Ordem sugerida

1. Aplicar a migration no Supabase (hoje ausente) e conferir no SQLite local.
2. Localizar o registry de produção e explicar a sessão órfã da §3.2.
3. Script idempotente de criação das linhas WAHA, com relatório de exceções.
4. Conferir cobertura: todo `waha_session` distinto das quatro tabelas resolve.
5. Ligar o resolver em sombra e medir.
6. Só então planejar a Fase 2.
