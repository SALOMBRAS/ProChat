# Checklist de validação integrada

## Estado atual e commits

- Branch auditada: `feat/replace-repository-with-chatpro`.
- HEAD: `f6747ce` — abertura direta de conversa por `conversationId`.
- Base relevante: `44b8638` (shell modular), `38b3410` (dashboard SLA) e
  `f6747ce` (deep link da Inbox).
- A infraestrutura Kanban/SLA remota foi registrada em `5b047a7`. Esta etapa
  não reaplica schema, migrations, SQL ou dados.

## Pré-requisitos para iniciar o ambiente

1. Usar um workspace de validação com pelo menos duas conversas existentes,
   uma delas fora da primeira página da Inbox.
2. Disponibilizar dois atendentes autorizados para o mesmo workspace e um
   contato de teste explicitamente autorizado.
3. Subir WAHA, worker, API e dashboard com as configurações do ambiente de
   validação; não usar produção para criar dados de teste.
4. Confirmar os healthchecks e a conexão WebSocket antes de qualquer envio.
5. Abrir logs da API, worker e WAHA em paralelo. Registrar horário, workspace,
   IDs de conversa e resultados sem copiar tokens, chaves ou payloads sensíveis.

## Ordem exata dos testes

| # | Ação | Resultado esperado |
| --- | --- | --- |
| 1 | Abrir uma conversa existente | Lista, histórico, CRM lateral e SLA carregam sem erro. |
| 2 | Receber texto inbound do contato de teste | Uma mensagem é persistida, a conversa sobe na lista e o SLA passa a aguardar atendente. |
| 3 | Enviar texto outbound | WAHA confirma envio, a mensagem aparece uma vez e o SLA passa a aguardar cliente. |
| 4 | Enviar imagem | Preview permite remover antes do envio; após confirmar, a imagem aparece sem texto técnico. |
| 5 | Enviar documento | Nome/tamanho são exibidos e o download permanece disponível quando fornecido pelo backend. |
| 6 | Gravar e enviar áudio | Estados gravando/cancelar/enviar funcionam; se o backend não suportar áudio, não há falso sucesso nem regressão de texto. |
| 7 | Atualizar a página | A conversa e o histórico continuam consistentes; não há duplicação. |
| 8 | Abrir `/inbox?conversationId=<uuid>` de conversa fora da primeira página | A Inbox consulta somente a conversa solicitada, abre histórico e não percorre páginas. |
| 9 | Usar voltar/avançar | A seleção e o parâmetro `conversationId` acompanham a navegação. |
| 10 | Abrir duas abas com o mesmo workspace | Eventos atualizam apenas os itens afetados, sem refresh manual. |
| 11 | Mover card no Kanban | UI é otimista; conflito retorna o card à posição anterior. O estágio persistido corresponde ao visível. |
| 12 | Observar a segunda aba após mover o card | Recebe `conversation.kanban.moved` e atualiza o card/etapa correta. |
| 13 | Repetir inbound e outbound | Indicador/prazo SLA mudam na Inbox, Kanban e dashboard agregado. |
| 14 | Aguardar um ciclo de 60 segundos | O dashboard SLA atualiza uma vez; não há polling por card nem `SLA tick failed`. |
| 15 | Validar em viewport mobile | Composer, preview, painel, cards Kanban e lista crítica permanecem legíveis e operáveis. |

## Logs que devem ser observados

Esperados durante o fluxo: `message.received`, `message.sent`,
`conversation.updated`, `conversation.kanban.moved` e
`conversation.sla.updated`.

Investigar imediatamente qualquer ocorrência de: `23503`, `PGRST202`,
`PGRST205`, HTTP `500`, `duplicate key`, `SLA tick failed` ou
`Kanban post-persistence automation failed`. Para cada ocorrência, preservar
hora, correlação, conversa e estágio; nunca registrar credenciais ou conteúdo
completo de mensagens.

## Erros que exigem interrupção

- Dados de workspace diferente aparecem na Inbox, Kanban, SLA ou endpoint de
  conversa direta.
- Uma mensagem é enviada/persistida mais de uma vez ou uma confirmação retorna
  erro ao usuário apesar de persistência bem-sucedida.
- Movimento Kanban cria estado divergente entre as abas após o realtime.
- A falha de SLA ou automação Kanban interrompe persistência da Inbox.
- `PGRST202`, `PGRST205`, erro de foreign key, conflito sem rollback visual ou
  HTTP 500 repetível.

Interromper novos envios e movimentações, manter os logs e reportar o cenário
antes de qualquer correção.

## Dados que não devem ser apagados

- Conversas, mensagens, anexos, métricas SLA e estados Kanban existentes.
- Boards, etapas, eventos/histórico Kanban, configurações SLA e identidades de
  contato.
- Logs de ocorrência associados aos testes.

Use apenas o contato autorizado e não execute limpeza, reset, backfill, SQL
manual ou migration durante a validação.

## Checklist mobile

- [ ] Composer vazio mostra adicionar, emoji, campo e microfone.
- [ ] Com texto, microfone vira enviar e os alvos de toque permanecem adequados.
- [ ] Preview de imagem/documento não corta nome, remoção ou legenda.
- [ ] Player de áudio e modal de imagem cabem na viewport.
- [ ] Lista, painel CRM, SLA e Kanban não causam rolagem horizontal indevida.
- [ ] Lista crítica SLA e deep link continuam abrindo a conversa correta.

## Checklist multiaba/multiusuário

- [ ] Ambas as abas estão no mesmo workspace e conectadas ao realtime.
- [ ] Inbound/outbound atualizam a conversa aberta e o SLA sem reload global.
- [ ] Movimento Kanban em uma aba atualiza somente o card afetado na outra.
- [ ] Atualização SLA chega à Inbox, Kanban e dashboard de forma agrupada.
- [ ] Conflito de arraste é revertido visualmente e não sobrescreve o estado do outro atendente.
- [ ] Conversas de outro workspace não podem ser abertas por `conversationId`.

## Checklist final de regressão

- [ ] Inbox: texto, mídia, preview, remoção, áudio e realtime sem duplicação.
- [ ] Navegação: Home → Inbox, SLA crítico → Inbox, refresh e histórico do navegador.
- [ ] Kanban: boards/etapas persistidos, drag otimista, rollback e realtime.
- [ ] SLA: transições inbound/outbound, indicador, prazo, dashboard e ciclo de 60 s.
- [ ] Performance: sem N+1, paginação massiva, polling inferior a 60 s, listeners/timers residuais ou resposta obsoleta aplicada.
- [ ] Banco/API: sem `23503`, `PGRST202`, `PGRST205` ou erro estrutural conhecido; isolamento por workspace preservado.
- [ ] Registrar resultados e anomalias antes de fazer alterações corretivas.

## Riscos de integração a observar

1. O caminho de mídia e áudio depende de confirmação real WAHA/backend; a UI
   preparada não deve ser interpretada como garantia de suporte de transporte.
2. Realtime precisa ser validado em duas abas reais para cobrir conexão,
   workspace e ordem de eventos além dos testes automatizados.
3. O deep link consulta uma conversa direcionada quando ela não está na página;
   validar 404/403 e troca rápida de links em navegador real.
4. A automação Kanban é isolada da persistência da Inbox, mas um aviso de falha
   precisa ser investigado sem reenviar a mensagem ou alterar a conversa.
