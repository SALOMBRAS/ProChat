# Spec — Reações em Mensagens (estilo WhatsApp)

> **Propósito deste documento:** especificar a feature de reações em mensagens
> (enviar, remover, receber e exibir em tempo real) para ser **portada para outro
> sistema**. A lógica, os fluxos e os contratos aqui são estáveis e reutilizáveis.
> **O visual NÃO é**: ele deve ser reimplementado com os tokens e componentes do
> design system do sistema-alvo. Copiar CSS, classes ou estrutura de DOM de outro
> produto é a causa raiz dos bugs visuais conhecidos (telas em branco, badges
> quebrados, picker fora do lugar). Ver §8 e §11.

---

## 1. Visão geral

Usuários reagem a mensagens com emoji, com paridade de comportamento ao
WhatsApp Web:

- **Uma reação por autor** por mensagem.
- Reagir com **outro emoji substitui** a reação anterior do mesmo autor.
- Reagir com o **mesmo emoji remove** (toggle).
- **Remoção = reação vazia** (`""`) no protocolo do provedor (WAHA).
- Reações feitas pelo operador (no dashboard) e pelo telefone do próprio usuário
  são **indistinguíveis** no protocolo (ambas `fromMe: true`) e precisam ser
  **reconciliadas** como uma só.
- Reações de contatos chegam por **webhook** e aparecem em **tempo real** para
  todos os operadores do workspace.

---

## 2. Regras de negócio (núcleo portável)

### 2.1 Modelo conceitual

Cada reação persistida carrega:

| Campo | Tipo | Descrição |
|---|---|---|
| `emoji` | string (≤ 32 chars) | O emoji. String vazia **nunca** é persistida — representa remoção. |
| `reactorWhatsappId` | string \| null | Identificador do autor. `null` quando `fromMe` (o próprio número não é exposto). |
| `fromMe` | boolean | `true` = reação da própria conta (operador no dashboard **ou** telefone). |
| `reactorName` | string \| null | Nome de exibição do autor (pushName / nome do operador). |
| `reactorPhone` | string \| null | Telefone do autor, quando conhecido. |
| `reactedAt` | datetime ISO-8601 | Carimbo usado na ordenação temporal (§2.3). |

A mensagem expõe `reactions: Reaction[]` (lista de entradas por autor, **não**
agrupada — o agrupamento é responsabilidade da UI, §6.3).

### 2.2 Mutação por autor (toggle/substituição/remoção)

Ao aplicar uma escrita de reação sobre o estado atual da mensagem:

1. **Mesmo autor + mesmo emoji** → remove a entrada do autor (toggle off).
2. **Mesmo autor + emoji diferente** → substitui o emoji da entrada do autor.
3. **Autor novo** → adiciona entrada.
4. **Reação vazia (`""`)** → remove a entrada do autor (remoção explícita).

Identidade do autor:

- Inbound de contato: `participant` do payload (em grupos) ou o próprio `from`/
  `key.participant` (em conversas diretas). Nunca usar `from` de grupos como autor
  (é o id do grupo).
- Inbound `fromMe` (telefone do usuário) e outbound do operador: ambos colapsam
  para a "identidade fromMe" — ver §2.4.

### 2.3 Ordenação temporal (eventos fora de ordem)

Webhooks podem chegar fora de ordem ou duplicados (reentrega). A resolução é
**Last-Writer-Wins por `reactedAt`**:

- Uma escrita só é aplicada se `reactedAt` for **mais novo** que o estado conhecido
  para aquele autor (idempotência natural de reentregas: mesma escrita com mesmo
  timestamp é ignorada).
- **Relógio fromMe:** como operador e telefone são a mesma identidade, mantém-se
  um relógio único `clockFromMe = max(última escrita local, newest reactedAt
  fromMe recebido)`. Escritas fromMe mais antigas que esse relógio são descartadas.
- Isso garante **convergência** mesmo sem transação distribuída: réplicas que
  aplicarem o mesmo conjunto de eventos chegam ao mesmo estado.

### 2.4 Reconciliação operador ↔ telefone

O operador reage no dashboard e o WhatsApp do telefone reflete (e vice-versa) —
mas são a mesma conta. Regra: **uma escrita fromMe substitui/remove qualquer
outra entrada fromMe existente**, independente do `reactorWhatsappId` interno
usado na origem (ex.: `operator:<userId>` local vs `null` vindo do webhook).

### 2.5 Mensagens órfãs

Uma reação pode chegar para uma mensagem que ainda não foi persistida (ordem de
webhook, histórico incompleto). Comportamento: **aceitar o evento (202), não
persistir, não publicar realtime**, registrar métrica/log. Não bloquear a fila de
webhooks por causa disso.

### 2.6 Limites e validações

- `emoji`: obrigatório no envio, 1–32 caracteres (cobre emojis compostos/ZWJ).
- Remoção: envio com `reaction: ""`.
- Cap defensivo de **100 entradas** por mensagem (descarta as mais antigas).
- Resposta da API de envio sempre devolve a **lista completa e atualizada** de
  reações da mensagem (fonte de reconciliação da UI, §6.5).

---

## 3. Integração com o provedor WhatsApp (WAHA)

### 3.1 Envio (outbound)

```
PUT /api/reaction
{ "session": "<wahaSession>", "messageId": "<externalMessageId>", "reaction": "<emoji|''>" }
```

- `messageId` é o **id externo** da mensagem (o id do WhatsApp, não o id interno).
- Remoção: `"reaction": ""`.
- Só enviar se a sessão estiver `connected`; caso contrário, propagar 409 com
  o status da sessão.

### 3.2 Recebimento (inbound, webhook)

Evento `message.reaction` (precisa estar na lista de eventos assinados do
webhook — ex.: `WHATSAPP_HOOK_EVENTS=...,message.reaction`).

Payload relevante:

```
payload.reaction.messageId  → id da mensagem alvo
payload.reaction.text       → emoji ('' = remoção)
payload.fromMe / key.fromMe → autoria da própria conta
payload.participant ?? key.participant → autor em grupos
payload.from                → autor em conversas diretas (não @g.us)
timestamp                   → base do reactedAt
```

Payload malformado (sem `messageId`, tipo inesperado) → **202 + log**, nunca 4xx/5xx
(o provedor reentrega em caso de erro e entupiria a fila).

---

## 4. API do sistema (backend)

### 4.1 Endpoint do operador

```
POST /inbox/conversations/{conversationId}/messages/{messageId}/reactions
Body: { "emoji": "👍" }        → 200 { messageId, reactions: Reaction[] }
```

Pipeline:

1. Valida `conversationId` (uuid), `messageId` (1–200), `emoji` (1–32).
2. Carrega conversa e mensagem → 404 se não existir (e **não** chama o provedor).
3. Verifica que a sessão WhatsApp da conversa ainda existe → 409 com
   `details.reason = 'whatsapp_session_inactive'` se morta.
4. Calcula o toggle (§2.2) contra as reações atuais → emoji final ou `''`.
5. Envia ao worker/provedor (`message.sendReaction`) → falha vira erro tipado
   (status mapeado do provedor).
6. **Persiste otimista** como fromMe (`reactorWhatsappId: null` na leitura,
   autor interno `operator:<userId>`) com `reactedAt = now`.
7. Publica realtime (§4.3) e retorna a lista atualizada.

### 4.2 Ingestão do webhook

Branch dedicado para `message.reaction`, **antes** da trilha genérica de eventos:

1. Parse seguro do payload (§3.2) → inválido: 202 silencioso.
2. Aplica mutação (§2.2–2.4) com LWW (§2.3) dentro de **transação** quando o
   banco permitir; sem transação, aceitar a pequena janela de corrida (o LWW
   converge — documentar a limitação).
3. Resultado classificado: `inserted | updated | removed | noop | orphan`.
4. Publica realtime apenas se `inserted|updated|removed` **e** a conversa existe.
5. Responde 202 sempre.

### 4.3 Evento realtime (WebSocket)

```
type: "message.reaction.updated"
data: { conversationId, messageId, reactions: Reaction[] }
```

- Escopo: workspace da conversa (todos os operadores conectados).
- O payload carrega a **lista completa** — o cliente não precisa recomputar nada.

### 4.4 Comando interno (API → worker)

```
type: "message.sendReaction"
payload: { wahaSession, chatId, messageId, reaction }   // '' = remoção
→ resposta: { reactionSent: { timestamp } }
```

`chatId`: usar `deliveryChatId ?? chatId` da conversa (contatos sincronizados
podem ter id de entrega diferente do id canônico).

---

## 5. Persistência

Duas opções — **no sistema novo, preferir a tabela dedicada**:

### 5.1 (Recomendada) Tabela `message_reactions`

```
message_id (FK) | reactor_key | emoji | from_me | reactor_name | reactor_phone | reacted_at
PK: (message_id, reactor_key)         // reactor_key = whatsappId ou 'me'
```

- Upsert por PK implementa §2.2 de graça; remoção = DELETE por PK.
- Leitura da mensagem faz join/agregação (1 query por página, sem N+1).
- Trilha de auditoria opcional (`message_reaction_events`) para replay/depuração.

### 5.2 (Alternativa sem migration) Embutido no payload da mensagem

Reações dentro do JSON da mensagem-alvo sob uma **chave reservada** (ex.:
`payload.reactions`), extraída na leitura para o campo `reactions` do contrato e
removida de `metadata`. Foi a escolha no ChatPro por proibição de migrations —
funciona, mas perde: consultas por reação, integridade referencial e auditoria.

Em qualquer das opções: `recordOutbound` (mensagem criada pelo envio do operador)
nasce com `reactions: []`.

---

## 6. UX/UI — comportamento detalhado estilo WhatsApp

> **Leitura obrigatória antes de implementar:** esta seção descreve **o que** a
> interface faz e **como se comporta**, nunca **com qual CSS**. Os nomes entre
> ‹colchetes› são **tokens/componentes do design system do sistema-alvo** que
> você deve mapear antes de escrever uma linha de estilo (§8).

### 6.1 Ponto de entrada (como abrir o seletor)

- **Desktop:** um botão de "reagir" (ícone ‹icon-emoji-plus›) aparece **no hover**
  da bolha da mensagem, flutuando na borda superior-direita (mensagens recebidas)
  ou superior-esquerda (próprias). Some quando o mouse sai.
- **Mobile/touch:** **long-press** (~400 ms) na bolha abre o seletor.
- **Teclado:** a bolha focável expõe ação "Reagir" (Enter/Espaço), com
  `aria-label="Adicionar reação"`.

### 6.2 Seletor de reações (picker)

- **Conteúdo:** 6 reações rápidas — `👍 ❤️ 😂 😮 😢 🙏` — seguidas de um botão
  "+" (opcional: abre o seletor completo de emojis do sistema-alvo).
- **Posição:** ancorado à bolha, **acima** dela por padrão; se não couber na
  viewport, inverte para baixo (flip). Nunca renderiza fora da tela — clamp
  horizontal de 8 px das bordas.
- **Animação:** entrada com escala 0.8→1 + fade (~120 ms, ‹motion-ease-out›);
  saída reversa (~90 ms).
- **Fechamento:** clique fora, `Esc`, scroll da lista, ou seleção de um emoji.
- **Apenas um picker aberto** por vez na tela.

### 6.3 Badges de reação (exibição sob a bolha)

- Reações agrupadas **por emoji**: cada badge = `emoji + contagem`.
- Badge da reação **do próprio usuário** (contém entrada fromMe) tem destaque
  visual distinto: fundo ‹color-accent-subtle› + borda ‹color-accent›.
- Badges ordenados por `reactedAt` mais antigo do grupo (estável, não "pula").
- Tooltip/press-longa no badge: lista de autores — **"Você"** para fromMe, nome
  do contato caso contrário ("Você, Maria e mais 2").
- Clique/toque num badge **alterna a reação do próprio usuário** com aquele emoji
  (atalho do toggle, §2.2).
- Overflow: exibir no máximo 3 badges + badge agregador "+N" (opcional, fase 2).

### 6.4 Layout e estados da bolha

- Badges ficam **fora do fluxo do texto** (overlay na base da bolha, meio
  sobreposto, como no WhatsApp) **ou** em linha própria abaixo — **decidir pelo
  que o layout do sistema-alvo suportar sem gambiarras**; as duas formas são
  fiéis ao espírito, a primeira é mais próxima do WhatsApp.
- A bolha precisa de **espaçamento inferior extra** quando tem reações para o
  badge não cobrir o texto da mensagem seguinte.
- **Estado de envio:** a reação aparece **otimista** (§6.5) imediatamente.
- **Estado de erro:** ⚠ discreto próximo à bolha; a reação otimista é revertida.

### 6.5 Otimismo, reconciliação e rollback (cliente)

1. Clique no emoji → aplica a mutação §2.2 **localmente e já renderiza**.
2. `POST` do endpoint §4.1.
3. **Sucesso:** substituir o estado local pela lista da resposta (fonte da
   verdade — resolve divergências de reconciliação operador↔telefone).
4. **Falha:** rollback para o estado anterior + indicador ⚠ com retry.
5. Evento realtime §4.3: aplicar **in-place** na mensagem correspondente
   (por `messageId`), **sem recarregar** a conversa nem paginar nada.
6. Reconexão do socket: ressincronizar a conversa aberta (re-fetch da página
   atual) — reações perdidas durante a queda chegam nesse refresh.

### 6.6 Acessibilidade

- Badges são `<button>` com `aria-label="Reações 👍: 3 — Você, Maria, João"`.
- Picker com `role="menu"`, emojis com `role="menuitem"` e navegação por setas.
- Contraste do badge "mine" conforme ‹color-contrast-AA› do sistema-alvo.

---

## 7. Contratos de dados (resumo copiável)

```jsonc
// Reaction (item de Message.reactions)
{
  "emoji": "👍",
  "reactorWhatsappId": "5511999990000@c.us",  // null quando fromMe
  "fromMe": false,
  "reactorName": "Maria",
  "reactorPhone": "5511999990000",
  "reactedAt": "2026-08-05T22:09:44.000Z"
}

// POST reactions → 200
{ "messageId": "ABCD1234", "reactions": [ /* Reaction[] */ ] }

// WS message.reaction.updated
{ "conversationId": "uuid", "messageId": "ABCD1234", "reactions": [ /* Reaction[] */ ] }
```

---

## 8. Portabilidade visual — regras anti-bug (a parte que mais importa)

Os bugs visuais ao portar ("fica tudo branco", "badge quebrado") vêm de trazer
**acidentalmente** estilo do sistema de origem. Regras:

1. **Proibido copiar** nomes de classe, folhas de estilo, variáveis CSS ou trechos
   de DOM do sistema de origem. A implementação começa **do zero** sobre os
   componentes do sistema-alvo (‹Bubble›, ‹Button›, ‹Tooltip›, ‹Popover›).
2. **Mapear antes de escrever** — preencher esta tabela com os primitivos reais
   do sistema-alvo:

   | Necessidade | Primitivo do sistema-alvo |
   |---|---|
   | Bolha de mensagem | ‹…› |
   | Botão-ícone (hover da bolha) | ‹…› |
   | Popover/menu flutuante (picker) | ‹…› |
   | Badge/chip com contador | ‹…› |
   | Tooltip com lista de nomes | ‹…› |
   | Tokens: cor de destaque, fundo sutil, raio, sombra, easing | ‹…› |
   | Z-index de camadas flutuantes | ‹…› |

3. **Camadas:** picker e badges devem usar o **sistema de camadas do alvo**
   (portal/overlay), nunca `z-index` mágico — picker sob header/modal é o bug
   clássico.
4. **Overflow:** verificar que nenhum ancestral da bolha tem `overflow: hidden`
   que cortaria picker/badges; se tiver, renderizar o picker via **portal**.
5. **Tema:** validar em **tema claro e escuro** — "tudo branco" costuma ser cor
   fixa herdada que não existe no tema do alvo.
6. **Emoji:** não estilizar fonte de emoji; deixar a fonte nativa do SO.
7. **Touch:** em telas touch, hover não existe — garantir o long-press (§6.1)
   antes de considerar pronto.

---

## 9. Fluxos (referência rápida)

**Operador reage:** clique → otimismo → POST → provedor → persistência →
realtime p/ workspace → outros operadores atualizam in-place.

**Operador remove:** mesmo fluxo com `reaction: ""` → entrada fromMe some.

**Contato reage:** webhook `message.reaction` → parse → LWW → transação →
realtime → UI atualiza in-place.

**Telefone do usuário reage:** igual ao contato, mas `fromMe` → reconcilia com a
reação do operador (§2.4) — nunca aparecem duas reações "minhas".

**Fora de ordem:** evento antigo chega depois de um novo → descartado pelo LWW.

**Órfã:** mensagem-alvo não existe → 202, sem estado, sem realtime.

**Sessão morta:** envio → 409 `whatsapp_session_inactive`; UI mantém a conversa
somente-leitura.

---

## 10. Critérios de aceite

1. Reagir com emoji novo → aparece na hora (otimista) e persiste após refresh.
2. Reagir com outro emoji → substitui; com o mesmo → remove.
3. Remoção envia `""` ao provedor.
4. Reação de contato (webhook) aparece em tempo real em **todas** as telas do
   workspace sem reload.
5. Reação feita no telefone físico substitui a do operador (e vice-versa) — nunca
   duplicada.
6. Reentrega do mesmo webhook é idempotente; evento antigo fora de ordem é
   ignorado.
7. Reação para mensagem inexistente não quebra a fila (202, sem realtime).
8. Lista de mensagens não faz query por item (sem N+1) nem polling.
9. UI: picker fecha com Esc/clique-fora/scroll; badge "mine" destacado; tooltip
   com autores; rollback + ⚠ em falha de envio.
10. **Visual 100% construído com o design system do sistema-alvo** — tabela da
    §8 preenchida e checklist da §11 verde.

---

## 11. Checklist de migração para o sistema novo

- [ ] Mapear primitivos do design system (tabela §8.2) **antes** de codar UI.
- [ ] Assinar `message.reaction` nos eventos do webhook do provedor.
- [ ] Criar persistência (tabela dedicada §5.1) + índice por `message_id`.
- [ ] Implementar mutação §2.2 + LWW §2.3 + reconciliação §2.4 com testes de
      ordenação e idempotência.
- [ ] Endpoint do operador §4.1 + comando interno §4.4 + guarda de sessão ativa.
- [ ] Branch de webhook §4.2 (antes da trilha genérica de eventos) + evento
      realtime §4.3.
- [ ] UI: entrada hover/long-press, picker (portal/overlay do alvo), badges
      agrupados, otimismo + rollback, handler WS in-place, ressincronização no
      reconnect.
- [ ] Testes: backend (toggle, substituição, remoção, autores independentes,
      fora de ordem, idempotência, órfã, reconciliação fromMe, 404/409),
      cliente (otimismo, rollback, badge-toggle), e2e (reação vai e volta).
- [ ] Validar temas claro/escuro, mobile (long-press), acessibilidade (§6.6).

---

## 12. Limitações conhecidas (herdadas do desenho, decidir no sistema novo)

1. Sem transação entre leitura e escrita no banco sem suporte → janela de
   corrida pequena, convergida pelo LWW (com tabela dedicada e upsert, some).
2. Realtime atualiza apenas mensagens já carregadas na tela; reações em
   mensagens fora da página chegam no próximo fetch.
3. Se o provedor não entregar `reactedAt` confiável, usar o timestamp do evento
   do webhook e aceitar precisão de segundos.
