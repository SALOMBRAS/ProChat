# Dashboard operacional de SLA

## Contrato

`GET /api/v1/inbox/operations/sla-summary` devolve uma projeção compacta:

- `generatedAt`
- `totals`: ativos, aguardando operador/cliente, dentro do SLA, atenção, atrasados e congelados
- `averages`: primeira resposta, espera do operador e espera do cliente em segundos
- `percentages.withinSla`
- `critical`: no máximo 20 conversas amarelas/vermelhas, com `conversationId` para navegação interna, `displayName`, `phoneNumber`, estado, indicador, prazo e última atividade

O endpoint não devolve `conversation_sla_metrics` integralmente. A configuração SLA é carregada uma vez por workspace e as métricas são agregadas no serviço. A lista crítica é ordenada por atrasados e, depois, por prazo.

## Escala e realtime

O dashboard deve consumir uma única requisição compacta na entrada e invalidá-la de forma agrupada para eventos `conversation.sla.updated`, `conversation.kanban.moved` e `conversation.updated`. Atualização periódica recomendada: 60 segundos, pausada em aba oculta e refeita em `visibilitychange`.

Não há N+1, mensagens completas, polling por card ou carregamento de toda a lista de métricas no navegador. Para a amostra crítica, a API consulta as conversas selecionadas uma vez e resolve identidades WhatsApp e contatos ChatPro em lotes restritos ao workspace.

## Dashboard visual

`SlaOperationalDashboard` é composto pela `HomeDashboard` e consome apenas
`GET /api/v1/inbox/operations/sla-summary`. A seção mantém os demais módulos da
Home visíveis durante loading, preserva o último resumo válido em falhas de
atualização e oferece retry manual isolado.

O componente usa um único intervalo de 60 segundos, que não atualiza com a aba
oculta. Ao retornar à aba, atualiza somente se o último carregamento tiver mais
de 60 segundos. Eventos `conversation.sla.updated`,
`conversation.kanban.moved` e `conversation.updated` são agrupados por 750 ms
antes de uma única atualização do resumo.

### Lista crítica com altura previsível

A lista fica dentro de um contêiner com rolagem própria dimensionado por
`--sla-critical-row` e `--sla-critical-rows` (~10 linhas), limitado também por
`62vh` para não dominar telas baixas. A altura deriva da altura de uma linha, não
de um pixel fixo: em telas até 760px cada item ganha uma segunda linha (o prazo
quebra) e a variável de linha é ajustada, deixando o teto de viewport valer.

O cabeçalho da seção (título, subtítulo e badge) fica fora da área rolável. O
badge conta `totals.warning + totals.overdue`, ou seja, todos os atendimentos em
risco — não o tamanho da amostra devolvida. Como a API corta `critical` em 20,
uma linha auxiliar informa quantos dos quantos estão visíveis quando há corte. O
frontend não aplica corte próprio: tudo o que a API devolve é renderizado.

A área rolável é `role="region"` com `aria-label` e `tabIndex={0}`, contendo uma
`<ul>` de itens, então é alcançável por teclado e anunciada como região nomeada.
Um elemento `position: sticky` no fim do contêiner cria o fade que sinaliza
conteúdo abaixo; ao chegar ao fim, ele repousa sobre o espaço vazio final. Os
estados vazio e de erro ficam fora do contêiner e não têm altura mínima.

Sem nenhum resumo carregado o painel não desenha corpo algum: só o cabeçalho e o
alerta de erro. Antes, uma falha na primeira carga caía no mesmo caminho da lista
vazia e exibia "0 em foco" com o ✓ verde de "Nenhum atendimento exige atenção
neste momento" ao lado do erro — uma afirmação de fila limpa que o painel não
tinha como sustentar. O estado vazio positivo agora só aparece quando existe um
resumo e ele traz `critical` vazio. Falhas de atualização posteriores continuam
preservando a última lista boa.

Não há virtualização e ela não é necessária. Medido em Chrome headless (inserção
da lista mais layout síncrono forçado, mediana de 9 execuções a 1440x900): 20
itens em 2,4 ms, 49 em 3,9 ms, 100 em 5,6 ms, 200 em 10,1 ms, 500 em 31,9 ms e
1000 em 52,2 ms — custo linear, sem O(n²). A rolagem fica em 16,7 ms por quadro
(o teto de 60 fps) com 20, 49 e 1000 itens; o pior quadro com 1000 foi 18,9 ms.
O custo de montagem do React medido em jsdom acompanha: 16,4 ms com 20 itens e
18,5 ms com 49.

Com o teto de 20 itens da API o DOM real fica em ~160 nós e a diferença entre 20
e 49 linhas é de ~1,5 ms — abaixo de um quadro. Reavaliar só se o corte do
servidor subir para a casa dos milhares; hoje o projeto não tem dependência de
virtualização e adicionar uma seria a única forma de resolvê-lo.

Os itens críticos usam a ordem devolvida pelo servidor e navegam para a Inbox
com `conversationId` na URL. A seleção é feita sem pré-carregar mensagens ou
métricas individuais. Quando a conversa ainda não está na página atual, a Inbox
faz uma única consulta direcionada a
`GET /api/v1/inbox/conversations/:conversationId` e reutiliza o carregamento
normal de mensagens.

## Limitações atuais

O schema SLA não duplica a identidade do contato: ela é projetada somente para a amostra crítica. A prioridade é nome WhatsApp, nome ChatPro e telefone normalizado; ausências e identificadores técnicos resultam em `Contato sem identificação`.

Estados vazio e de erro passaram a ter cobertura automatizada, junto com a lista
cheia, a contagem do badge e o contrato de altura/rolagem em `styles.css`. Como o
jsdom não tem motor de layout, a altura máxima é verificada no nível da folha de
estilo, não medindo o elemento renderizado. O teste também afirma que
`.sla-critical-empty` e `.sla-operational-error` não declaram altura em nenhum
bloco da folha (ela mistura regras minificadas e legíveis, e alguns seletores
aparecem nos dois) e que `--sla-critical-row`, `--sla-critical-row-gap` e
`--sla-critical-rows` só existem dentro de `.sla-critical-scroll` — do qual os
dois estados são irmãos, nunca descendentes, então não há o que herdar.

## Validação em viewport real

O que o jsdom não prova foi medido em Chrome headless via CDP, sobre o DOM
extraído do próprio componente e a `styles.css` real, em 1440x900, 1280x800,
900x700, 760x1024, 412x915, 360x640 e 320x568.

- Altura efetiva: a linha declarada (`3.05rem` no desktop, `4.2rem` até 760px) é
  uma aproximação dependente de fonte. O app não embute a Inter, então a pilha cai
  no fallback do sistema e o item mede entre 47px e 53px no desktop e entre 66px e
  75px abaixo de 760px, conforme a fonte resolvida. Com a fonte do ambiente medido
  (53px/75px) o contêiner mostra 9,3 linhas em vez das ~10 nominais — o "~" da
  especificação, não um corte.
- Quem manda no teto: o cálculo por linha só vence em viewports altas (acima de
  ~900px de altura no desktop). Em qualquer viewport estreita realista o teto de
  `62vh` é que governa — 634px em 760x1024, 397px em 360x640, 352px em 320x568.
- Abaixo de 760px o item vira duas linhas de grid (31px + 14px), o prazo quebra e
  "Abrir →" some, como previsto.
- Nada é cortado: em todos os viewports, zero elementos com transbordo vertical e
  transbordo horizontal zero na página, no contêiner e em cada item. Nome longo sem
  espaços continua elipsado, sem empurrar largura.
- Nada de rolagem dupla: a página estreita tem exatamente um contêiner rolável
  interno (`.sla-critical-scroll`), com `overscroll-behavior: contain`, além da
  rolagem normal do documento.
- Fade: no fim da rolagem o último item termina ~24px acima da borda do contêiner,
  ou seja, o fade repousa sobre a própria faixa vazia e não cobre a última linha.
- Estados vazio e de erro: `min-height` computado `0px`, `max-height` `none` e as
  variáveis de linha não resolvidas, confirmando em layout real o que o teste
  afirma na folha de estilo.

Ainda sem validação em viewport real: abertura por link direto, atualização
realtime agrupada e atualização multiusuário.
