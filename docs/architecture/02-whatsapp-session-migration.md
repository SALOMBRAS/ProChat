# Migração do ciclo de sessões WhatsApp

Data: 15/07/2026. Esta etapa extrai o ciclo de vida de sessões para `web/apps/worker`, sem ligar API e worker, sem iniciar conexão real e sem acessar SQLite ou credenciais do Electron.

## Auditoria confirmada do legado

- Biblioteca declarada: `@itsukichan/baileys` com range `^7.3.2`; pacote instalado e inspecionado: `7.3.2`. O worker fixa exatamente `7.3.2`.
- Socket: `makeWASocket(...)`, auth por `useMultiFileAuthState(sessionDir)` e, no fluxo principal legado, chaves envolvidas por `makeCacheableSignalKeyStore`.
- Eventos de sessão: `connection.update` e `creds.update`. O legado também liga `messages.upsert`, `contacts.update`, `call`, `presence.update` e eventos de labels, que estão fora desta migração.
- Configuração relevante: QR no terminal desabilitado, browser macOS/Chrome, `markOnlineOnConnect: false`, histórico completo desabilitado, query/connect timeout de 90 s, keep-alive de 20 s, retry de 2 s e timeout de QR de 120 s. O legado também possui caches, store de mensagens, proxy e versão WA obtida remotamente.
- Credenciais legadas: diretórios em `Electron app.getPath('userData')/auth_sessions/{sessionId}`. O serviço cria/migra diretórios e restaura sessões com apoio do SQLite `whatsapp_sessions`.
- QR legado: recebe `update.qr`, converte para data URL PNG com `qrcode`, mantém no estado, publica ao Electron, persiste no SQLite e registra comprimento/prévia.
- Pairing code: existe por `socket.requestPairingCode(phoneNumber)`, incluindo tentativas de formatos de telefone. O legado registra código e telefone em logs.
- Reconexão: `smartReconnect` usa até oito tentativas, base de 1.500 ms, fator 1,5, jitter e teto de 25 s. Há caminhos adicionais específicos para restart, conflito e códigos de desconexão.
- Disconnect legado: apesar do comentário dizer que preserva dados, chama `socket.logout()`, remove o socket e mantém o registro local. Delete chama logout com timeout, remove runtime, arquivos e desativa o registro SQLite.
- Dependências próprias: Electron `app.getPath`, SQLite, stores/caches, proxy, processadores de mensagens, contatos, chamadas, grupos, campanhas, logs visuais e IPC.

Arquivos consultados: `package.json`, pacote instalado `node_modules/@itsukichan/baileys/package.json`, `build/services/whatsapp.service.js`, `build/services/app.service.js`, regiões WhatsApp de `build/electron.js`, auditoria/inventário em `LeadWave-Analysis`, contratos e fundação em `web/`.

## Comportamento mantido

- Mesma biblioteca e versão instalada do legado.
- `useMultiFileAuthState`, `makeWASocket`, `connection.update` e `creds.update`.
- Configurações essenciais de estabilidade do socket, sem imprimir QR no terminal.
- Estados `disconnected`, `connecting`, `qr_pending`, `connected`, `reconnecting`, `logged_out` e `error`.
- Persistência de credenciais para reconexão e logout na remoção quando há socket ativo.

## Comportamento alterado

- A chave de runtime é `workspaceId + sessionId`; ambos aceitam somente 1 a 128 letras, números, hífen ou underscore.
- Auth usa `CHATPRO_DATA_DIR/workspaces/{workspaceId}/whatsapp/sessions/{sessionId}/auth/` e nunca consulta o diretório Electron.
- `createSession` cria somente metadados em memória. Diretórios e socket surgem apenas em `connectSession`.
- `disconnectSession` usa encerramento local e preserva auth, sem logout remoto. `removeSession` tenta logout, encerra, apaga auth e remove metadados.
- A descoberta de auth apenas registra sessões como `disconnected`; não há auto-connect no bootstrap.
- Reconexão usa backoff `base * 2^(tentativa-1)`, máximo configurável, um timer por sessão e cancelamento em disconnect/remove/shutdown.
- O QR bruto é temporário e aparece somente no evento tipado. Não há conversão, disco, banco ou log; a referência expira em 120 s ou ao conectar.
- Eventos são validados no pacote de contratos e erros externos são reduzidos a classe/código e mensagem genérica.
- A versão WA não é consultada remotamente no bootstrap. O pacote usa seu padrão embarcado, evitando acesso de rede quando a feature flag está desligada.

## Comportamento descartado

- SQLite, restauração automática baseada em banco e migração de diretórios legados.
- Mensagens, histórico, contatos, presença, chamadas, labels, grupos, campanhas, proxy e stores de mensagens.
- Pairing code nesta etapa; sua existência foi auditada, mas não há comando no `WhatsAppWorkerPort` atual.
- Persistência ou logging de QR, código de pareamento, telefone, auth state ou objetos internos do socket.
- Caches específicos da aplicação, busca dinâmica da versão WA, lógica visual, licenciamento e IPC Electron.

## Componentes do worker

- `BaileysWhatsAppWorkerAdapter`: implementa comandos do port sem acoplar API.
- `WhatsAppSessionManager`: ciclo de vida, status, eventos, reconexão e shutdown.
- `SessionRuntimeRegistry`: sockets, operações críticas, tentativas, timers e timestamps por tenant/sessão.
- `BaileysSocketFactory`: único ponto que importa Baileys e cria socket/auth state.
- `FileSystemCredentialStoreAdapter`: paths isolados, descoberta e remoção controlada.
- `StructuredLogEventPublisherAdapter`: execução local sem transporte; registra só metadados do envelope.
- `InMemoryEventPublisherAdapter`: testes e validação de eventos.

## Ciclo de vida e eventos

`createSession` retorna `disconnected` e não abre rede. `connectSession` exige `WHATSAPP_CONNECTION_ENABLED=true`, prepara auth, cria um socket, liga handlers e publica mudanças. `connection.update.qr` leva a `qr_pending`; `open`, a `connected`; `close`, a `reconnecting`, salvo logout 401, que leva a `logged_out`. Ao esgotar tentativas, publica `error` e `worker.error`.

`session.status.changed`, `session.qr.updated` e `worker.error` usam `eventId`, `eventType`, `workspaceId`, `timestamp`, `correlationId` e payload validado. Estados repetidos não são publicados. Credenciais nunca fazem parte do envelope.

## Configuração

- `CHATPRO_DATA_DIR`: raiz provisória do volume local.
- `WHATSAPP_CONNECTION_ENABLED`: padrão seguro `false`; nessa condição connect retorna `SERVICE_UNAVAILABLE` antes de criar auth/socket.
- `WHATSAPP_MAX_RECONNECT_ATTEMPTS`: padrão 5.
- `WHATSAPP_RECONNECT_BASE_DELAY_MS`: padrão 1.500 ms.

## Limitações e riscos atuais

- Metadados e status vivem somente em memória; nomes restaurados usam o `sessionId` até existir repositório persistente.
- O filesystem local exige volume persistente, backup, criptografia/permissões e afinidade de worker no deploy. Múltiplas réplicas não devem compartilhar uma sessão sem coordenação distribuída.
- `useMultiFileAuthState` é adequado à fase de desenvolvimento, mas a infraestrutura final deve avaliar um credential store/cofre persistente.
- Não há transporte entre API e worker; rotas continuam 501 e WebSocket ainda não recebe estes eventos.
- Pairing code, envio/recebimento de mensagens e auto-reconnect no bootstrap não estão conectados.
- A árvore de produção da versão legada obrigatória apresenta 6 alertas no `npm audit` (1 moderado, 4 altos e 1 crítico), originados em dependências transitivas de Baileys; parte não possui correção compatível indicada. A revisão/upgrade controlado do fork deve preceder produção.

## Próxima integração

A próxima tarefa deve definir o transporte interno API-worker e a persistência de metadados, preservando o port atual. A API deverá autorizar workspace/sessão, encaminhar comandos, receber envelopes validados e distribuí-los por sala WebSocket do workspace. Só depois deve substituir os adapters 501; não é necessário mover Baileys para o processo HTTP.
