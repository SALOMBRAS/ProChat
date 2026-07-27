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

Não há virtualização e ela não é necessária: com o teto de 20 itens da API o DOM
é trivial. Reavaliar só se o corte do servidor subir para a casa das centenas —
hoje o projeto não tem dependência de virtualização e adicionar uma seria a
única forma de resolvê-lo.

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
estilo, não medindo o elemento renderizado.

Validação visual ainda pendente: layout mobile em viewport real, abertura por
link direto, atualização realtime agrupada e atualização multiusuário.
