# ChatPro: contexto para agentes de IA

## Produto e escopo

ChatPro é um SaaS de atendimento por WhatsApp. O foco operacional é receber e
enviar mensagens, organizar conversas na Inbox/Kanban, manter identidade de
contatos e medir SLA por workspace. O código ativo é o monorepo em `web/`.

Leia este arquivo antes de qualquer alteração. Depois, consulte apenas o
documento específico em `web/docs/`; não faça uma varredura completa do
repositório sem necessidade.

## Arquitetura

```text
Dashboard React/Vite ──HTTP/WebSocket──> API Express ──> SQLite ou Supabase
                                             │
                                             └─> Worker interno ──> WAHA/Baileys ──> WhatsApp
```

- `web/apps/dashboard`: frontend React 18/Vite.
- `web/apps/api`: API Express 5, serviços de domínio e integrações.
- `web/apps/worker`: worker TypeScript; provider WAHA ou Baileys e transporte
  interno HTTP.
- `web/packages/contracts`: tipos e esquemas Zod compartilhados.
- `web/apps/api/migrations`: esquema SQLite local.
- `web/supabase/migrations`: esquema Supabase remoto.
- `web/docs`: documentação técnica canônica.

Stack principal: TypeScript, React, Vite, Express, Zod, Vitest, WebSocket,
Supabase e `better-sqlite3`. O workspace `web/` usa npm workspaces.

## Regras críticas

1. Preserve compatibilidade entre SQLite e Supabase.
2. Nunca crie migration, altere schema, aplique SQL remoto, faça push ou deploy
   sem solicitação explícita.
3. Não altere o ciclo de webhook/identidade/persistência sem testes de regressão.
4. Não carregue listas inteiras, não percorra páginas para localizar uma conversa
   e não introduza N+1 ou polling por item.
5. Respeite `workspaceId` em toda consulta, evento e mutação.
6. Identificadores técnicos nunca devem ser renderizados como informação visível
   ao usuário (UUID, JID, LID, `messageId`, IDs internos WAHA). Entretanto,
   identificadores internos podem ser utilizados em rotas, APIs, estados internos
   e deep links quando necessários para funcionamento da aplicação.

Identidade exibida sempre usa: nome WhatsApp (`profileName`/`pushName`), nome
ChatPro, telefone real normalizado e, por último, `Contato sem identificação`.

## Fluxos que exigem cuidado

- WhatsApp: WAHA -> webhook -> normalização -> resolução de identidade ->
  persistência -> realtime -> Inbox. Veja `web/docs/whatsapp-flow.md`.
- Inbox e mídia: veja `web/docs/inbox-flow.md`.
- SLA/Kanban: veja `web/docs/sla-overview.md` e `web/docs/kanban-architecture.md`.
- Banco e provedores: veja `web/docs/database-overview.md`.
- CRM: veja `web/docs/crm-roadmap.md`.

## Estado atual

Funcional: Inbox, texto, anexos de imagem/documento, áudio, envio/recebimento,
pesquisa preparada, realtime, Kanban persistente, SLA operacional e deep link
por `conversationId`.

Em evolução: CRM avançado, dados de contato avançados, chamadas de voz/vídeo,
automações avançadas e IA. Não simule integrações ainda inexistentes.

## Navegador e conferência visual

NÃO use a extensão do Claude no Chrome (ferramenta de navegador conectado).
Ela está conectada a uma máquina diferente da que hospeda este repositório:
abrir uma página por ela cria janelas no computador de outra pessoa.
Diagnosticado na PR #62 — o `127.0.0.1` que a extensão alcança não é o
desta máquina. Use apenas se o usuário pedir explicitamente, na sessão em
curso.

Consequências práticas:
- Não suba o dev server com `--host 0.0.0.0` para ser alcançado de fora.
- Não peça ao usuário para liberar `127.0.0.1` ou `localhost` na extensão.
- Quando a mudança precisar de conferência visual, faça o que der por teste
  e por leitura de CSS, declare explicitamente o que não foi verificado na
  tela, e deixe a conferência para o usuário.

Permitido: Chrome headless iniciado localmente (CDP, puppeteer) para medição
e inspeção de DOM e estilo. Isso roda nesta máquina e não abre janela para
ninguém — foi como a PR #29 mediu performance em sete viewports.

## Como desenvolver com segurança

1. Audite os arquivos envolvidos e explique impacto antes de editar.
2. Faça a menor alteração testável; reutilize serviços e contratos existentes.
3. Crie/ajuste testes ao mudar lógica ou contrato.
4. Revise `git diff --check` e não inclua arquivos temporários.

Comandos a partir de `web/`:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Para ambiente local: `npm run dev:local`. Para Supabase/WhatsApp real, use os
scripts de runtime e variáveis documentadas em `web/.env.example`; nunca exponha
segredos em código, logs ou documentação.
