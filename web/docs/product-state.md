# Estado do produto ChatPro

## Produto

ChatPro é um SaaS de atendimento e operação comercial por WhatsApp. Ele reúne
conversas, contexto de contatos, gestão operacional, Kanban e SLA em uma única
experiência para equipes que precisam responder com rapidez e consistência.

O público-alvo são pequenas e médias empresas, times comerciais, suporte e
operações de atendimento que usam WhatsApp como canal principal. O objetivo
comercial é transformar conversas em um processo gerenciável, auditável e
escalável para equipes.

## Funcionalidades atuais

- **WhatsApp/WAHA:** sessões, QR, webhook, sincronização de histórico e
  integração com worker WAHA ou Baileys.
- **Inbox:** lista paginada de conversas, histórico, contexto e operação por
  conversa.
- **Mensagens:** envio e recebimento de texto com persistência e realtime.
- **Imagens e documentos:** envio, recebimento, preview, visualização e acesso
  à mídia conforme o suporte existente.
- **Áudio:** renderização de áudio, player e estrutura de gravação no navegador
  integrada ao composer.
- **Pesquisa:** interfaces de pesquisa global e dentro da conversa preparadas
  para consultas incrementais e paginadas.
- **Contatos:** cadastro, etiquetas, opt-out e associação com conversas.
- **Identidade LID/JID:** aliases, resolução LID para telefone quando há
  evidência, isolamento por workspace e sanitização de exibição.
- **Realtime:** eventos de mensagem, contexto, gerenciamento, Kanban e SLA.
- **SLA:** ciclo inbound/outbound, métricas persistidas, atualização por timer,
  resumo operacional e alertas críticos.
- **Kanban:** boards, etapas, cards, movimento persistente, rollback otimista e
  realtime.
- **Dashboard operacional:** indicadores agregados de SLA e lista limitada de
  atendimentos críticos com identidade do contato.
- **Deep link:** abertura direta de conversa por `conversationId`, sem carregar
  todas as páginas da Inbox.

## Funcionalidades em evolução

- **CRM:** experiência mais rica de perfil, contexto e histórico comercial.
- **Contatos avançados:** campos personalizados, origem, dados de empresa e
  relações comerciais.
- **Pipeline comercial:** aprofundamento de pipelines, regras de etapa e visão
  de gestão.
- **Automações:** regras de distribuição, follow-up, gatilhos e ações
  operacionais mais avançadas.
- **IA:** assistência de atendimento e automações orientadas por contexto.
- **Ligações:** voz, vídeo e integrações de telefonia.

Essas frentes não devem ser apresentadas como prontas nem simuladas sem um
contrato de backend e uma integração real.

## Decisões arquiteturais importantes

- A identidade de contato usa aliases e resolução canônica; LID não é telefone
  por si só e nunca deve gerar contato duplicado.
- UUID, JID, LID, `messageId` e IDs internos WAHA não são informação visível ao
  usuário. Eles podem ser usados internamente em APIs, estado, rotas e deep
  links.
- SQLite atende o runtime local; Supabase atende o remoto. Alterações precisam
  preservar os dois providers e o isolamento por workspace.
- Eventos realtime atualizam o item afetado sempre que possível; não devem
  disparar recarga integral desnecessária.
- Consultas devem evitar N+1, paginação massiva e chamadas por card/conversa.
- O fluxo WhatsApp — WAHA, webhook, normalização, identidade, persistência,
  realtime e Inbox — é crítico e exige testes de regressão antes de mudanças.

## Roadmap recomendado

### Curto prazo

- Contatos avançados.
- Base de CRM com campos e histórico comercial consistentes.

### Médio prazo

- Pipeline comercial e governança de etapas.
- Automações operacionais e de atendimento.
- Notificações internas e de SLA.

### Longo prazo

- Telefonia, voz e vídeo.
- IA para assistência, qualidade e automação contextual.
- Omnichannel com preservação da mesma identidade de contato e operação.
