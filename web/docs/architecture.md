# Arquitetura do ChatPro

## Limites de aplicação

O monorepo `web/` separa dashboard, API, worker e contratos. O dashboard só
consome a API; ele não consulta Supabase diretamente. A API seleciona o
provider de persistência por `DATABASE_PROVIDER` e instancia implementações
SQLite ou Supabase para os mesmos serviços.

O worker expõe um transporte interno em loopback. A API usa esse transporte
para sessões, QR e operações de provedor; o worker pode operar com WAHA,
Baileys ou adaptador de demonstração conforme configuração.

## Camadas da API

- `routes/` e `controllers/`: HTTP, contexto de workspace e validação de borda.
- `services/`: regras de Inbox, SLA, Kanban, roteamento, identidade e mídia.
- `persistence/`: bancos SQLite/Supabase e repositórios de domínio.
- `realtime.ts`: hub de eventos que alimenta dashboard e atualizações locais.

Os contratos compartilhados ficam em `packages/contracts`. Ao evoluir payloads,
verifique consumidores API, dashboard e testes antes de mudar o formato.

## Navegação e UI

`App.tsx` coordena shell e navegação. A Home é composta por `HomeDashboard` e
`SlaOperationalDashboard`; `Inbox.tsx` é a tela ativa de atendimento;
`InboxKanban.tsx` consome o Kanban persistente. O deep link de atendimento usa
`/inbox?conversationId=<uuid>` e busca somente a conversa ausente. UUIDs e
outros identificadores técnicos são permitidos em rotas, APIs, estados internos
e deep links; eles nunca devem ser renderizados como informação visível ao
usuário.

## Testes e execução

Vitest cobre cada workspace. `npm run dev:local` sobe API, worker e dashboard
com SQLite. Supabase é usado no runtime remoto; migrations locais e remotas são
artefatos distintos e não devem ser tratados como intercambiáveis.
