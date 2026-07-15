# Auditoria do estado atual — ChatPro

Data: 15/07/2026. Escopo: inspeção estática; Electron, banco, migrações, WhatsApp e serviços externos **não foram iniciados**. Classificações: **Confirmado**, **Provável**, **Não identificado** e **Divergente**.

## 1. Resumo executivo

**Confirmado.** O artefato é um aplicativo desktop Electron 3.0.1, com UI React compilada, processo principal concentrado em `build/electron.js` (6.778 linhas), ponte IPC em `build/preload.js`, lógica Node em `build/services/` e SQLite local. Não há fonte React, scripts npm, `package-lock.json`, `.env.example` ou repositório Git na pasta auditada. A migração para web exige criar frontend-fonte e uma API/worker servidor; não é uma troca de hospedagem do `build/` existente.

**Divergente.** `09-ChatPro-Rebranding-Checklist.md` marca todos os textos como rebatizados e arquivos suspeitos removidos. A marca principal está como ChatPro em `package.json:2-6`, `build/config/app.config.js:10-15`, `build/index.html:1` e `build/manifest.json:2-4`, mas ainda há segredo/nomes LeadWave e caminhos/artefatos do licenciamento. O iframe citado em documentos anteriores não está em `build/index.html`; portanto, sua remoção é compatível com o código atual.

**Próxima tarefa recomendada:** criar o esqueleto versionado da aplicação web (monorepo ou `web/` + `api/`), começando pelo contrato HTTP/WebSocket para sessões WhatsApp, contatos, templates e eventos. Não portar UI minificada nem expor o SQLite diretamente ao navegador.

## 2. Estado do rebranding

| Achado | Estado | Evidência | Classificação |
|---|---|---|---|
| Identidade ChatPro aplicada | ativo | `package.json:2-6`; `app.config.js:10-15`; `index.html:1`; `manifest.json:2-4` | Confirmado |
| Segredo de desenvolvimento LeadWave | referência ativa de segurança/licença | `build/config/security-config.js:83` contém `LEADWAVE-2025-DEV-SECRET-CHANGE-IN-PRODUCTION` | Confirmado |
| Assinaturas e backup LeadWave | referência ativa/interna de licença | `build/electron.js:229,540,1793` usam `LEADWAVE_LICENSE_SECRET`, `leadwave-backup.zip`, `LEADWAVE_SECRET` | Confirmado |
| Logo legado | artefato de marca | comentário em `build/assets/images/1213logo.svg:2` | Confirmado |
| NewLic/CloudLicense | nomes internos necessários enquanto o licenciamento existir | serviços e IPC em `build/services/*license-service.js`, `electron.js:1925-3355` | Confirmado |
| Nome antigo de empresa/domínio | não identificado fora de exemplos e dependências | busca dirigida não encontrou domínio empresarial ativo; há `127.0.0.1` padrão | Não identificado |

Ocorrências em traduções como `example.com`, `company.com` e `@s.whatsapp.net` são exemplos/falsos positivos, não marca antiga. Imagens `logo*.png`, `logo.svg` e `assets/images/*logo*` existem, mas não foi possível atribuir a identidade visual somente por texto.

## 3. Licenciamento e autenticação

**Estado: ainda ativo.** O renderer contém estados de entrada/renovação (`build/static/js/main.09f84bf6.js:2`, strings `licenseInput`/`licenseRenewal`); o preload expõe operações; `electron.js` registra 17 handlers `license:*`, cinco `cloud-license:*` e quatro `newlic-license:*`.

| Componente | Papel observado | Evidência |
|---|---|---|
| LocalLicenseService | trial, ativação, dados locais e validação | `build/services/local-license-service.js`; handlers `electron.js:2427-3230` |
| CloudLicenseService | ativação/validação/informações remotas | `build/services/cloud-license-service.js`; `electron.js:2359`, `5114-5118` |
| NewLic | máquina, arquivo cifrado, assinatura/tamper | `build/services/newlic-license-service.js`; `electron.js:1925-2314,3355` |
| Configuração | URL e segredo por variável de ambiente, com fallback | `build/config/security-config.js:45,83` |
| Revenda | endpoints de trial e branding | `build/config/reseller-config.js:45-91` |

Há dependências ausentes: `electron.js:80-81` tenta carregar `security/anti-tamper` e `security/hardware-fingerprint`; `reseller-config.js:9` requer `security/config-encryption`; e `electron.js:3422` requer `scripts/clean-installation.js`. Os `try/catch` podem permitir fallback em parte do fluxo, mas o comportamento em produção é **Provável**, não confirmado. Não foi encontrada evidência de iframe ou redirecionamento remoto de licença no HTML atual.

## 4. Arquitetura atual e 5. Fluxo de inicialização

```
React compilado -> window.electronAPI -> preload/IPC -> electron.js
                                              -> AppService -> SQLite / Baileys / serviços
```

1. `package.json:5` aponta para `build/electron.js`.
2. `electron.js:32` redefine `userData` para AppData com o nome do app; `:250-325` tenta migrar dados locais.
3. `app.whenReady()` (`:1524`) carrega/inicializa `AppService` (`:1385`) ou cria fallback de banco/WhatsApp (`:1160-1326`).
4. Inicializa Live Chat (`:1395-1398`), cria `BrowserWindow` (`:843-1092`) com `contextIsolation: true` e preload, e carrega `build/index.html`.
5. Configura encaminhamento de eventos (`:1426-1521`) e serviço de atualização (`:1741-1743`). A conexão WhatsApp é restaurada/criada pelo serviço conforme sessões persistidas; não há evidência de conexão antes de a UI pedir sessão.

## 6. Mapa Electron e IPC

`build/preload.js` publica `window.electronAPI` via `contextBridge`; `electron.js` tem 215 declarações `ipcMain.handle` (inclui duplicata de `license:validate`). O retorno é Promise/objeto de serviço; listeners de eventos retornam função de limpeza. A tabela agrupa todos os canais para manter a leitura útil.

| Canal/função (quantidade) | Origem / argumentos típicos | Serviço | Equivalente web |
|---|---|---|---|
| `whatsapp:*` (52) | `electron.js:3540-4457`; sessão, destinatário, mídia, grupo | `whatsapp.service.js` | REST + WebSocket/SSE |
| `license:*` (17), `cloud-license:*` (5), `newlic-license:*` (4) | `:1925-3355` | serviços de licença | API de autenticação/licença servidor |
| `backup:*` (6), `update:*` (12) | `:410-615`, `:6594-6755` | backup/update | jobs, armazenamento e pipeline de deploy |
| `live-chat:*` (20), `optOut:*` (9), `recall-bot:*` (6), `warmer:*` (10) | `:4563-6579` | serviços homônimos | endpoints autenticados + worker |
| `ai-*` (14), `support-bot:*` (4), `translation:*` (8) | `:1543-1716`, `:5186-5659` | AI, documentos, tradução | API + fila para documentos/IA |
| `proxy:*` (16), `email:*` (4), `campaign-scheduler:*` (4) | `:4740-6151` | proxy/email/scheduler | segredo no servidor + worker agendado |
| `db-query`, `database:delete-all-data` | `:4525,6770`; SQL/parâmetros | DatabaseService | substituir por API específica (não SQL livre) |
| `fs-read-file`, `fs-write-file`, `shell-open-external`, diálogos | `:4855-4878`, `:513-537` | Node/Electron | upload/download, URL allowlist, File System Access opcional |
| `BrowserWindow`, `dialog`, `shell`, ciclo `app` | `:3`, `:843-1092`, `:636-840` | Electron | navegador/servidor, sem equivalente 1:1 |

`electron-updater` é dependência e `update-service.js` é iniciado. Não foi encontrado uso de `child_process` ou `Notification` nativo no processo principal. O acesso arbitrário a SQL e caminhos fornecidos pelo renderer é risco de segurança no desktop e não deve ser levado à web.

## 7. Mapa do frontend

**Confirmado:** React 18 e React Router 6 são dependências (`package.json:35-36`); só há bundles minificados em `build/static/js/`, carregados por `build/index.html:1`. Não há arquivos `.jsx`, `.tsx`, `src/`, sourcemaps ou configuração de build. O bundle referencia `window.electronAPI`, portanto não funciona diretamente em navegador comum.

Rotas identificáveis no bundle: `/dashboard`, `/devices`, `/single-message`, `/templates`, `/contacts`, `/bulk-messages`, `/proxies`, `/warmer`, `/opt-out-management`, `/auto-reply`, `/chatbot`, `/support-bot`, `/ai-chatbot`, `/call-responder`, `/follow-up`, `/recall-bot`, `/live-chat`, `/group-grabber`, `/manage-group`, `/reports`, `/localization`, `/settings`. Estado interno e biblioteca de UI além de React não são identificáveis com confiança no bundle.

HTML, CSS, fontes e manifestação podem abrir no navegador, mas a aplicação funcional, licenciamento, arquivos, banco e WhatsApp precisam ser reconstruídos sobre API. CSP atual ainda depende de CDN SheetJS e permite `unsafe-inline`/`unsafe-eval` (`index.html:1`).

## 8. Mapa dos serviços

Reutilizáveis após desacoplamento: domínio de contatos/templates/models, campanhas, opt-out, follow-up, live chat, IA, tradução, e-mail, proxy e backup. Diretamente desktop/Node: `whatsapp.service.js`, `database.service.js`, `update-service.js`, `notification-sound.service.js`, `voice-transcription.service.js`, operação de arquivos e qualquer serviço que use `app.getPath`, `fs`, `better-sqlite3` ou Electron.

`app.service.js` orquestra banco, WhatsApp e serviços; a regra de negócio está misturada com paths locais e processo principal. A extração recomendada é: contrato de domínio -> API Node -> worker de WhatsApp/agendamentos -> adaptadores de banco/arquivos.

## 9. Mapa do banco

**Confirmado:** `better-sqlite3` (`package.json:16`) é usado por `build/services/database.service.js`. Em Electron, o arquivo é `app.getPath('userData')/data/wapp.db` (`:23-24`); fora dele usa `build/data/wapp.db` (`:18`). Há cópia de banco embarcado, backup e recuperação (`:54-219,2706-2775`). Nenhum `.db` foi aberto ou alterado.

Tabelas principais declaradas no serviço: `whatsapp_sessions`, `message_templates`, `contacts`, `contact_groups`, `contact_group_members`, `bulk_campaigns`, `bulk_campaign_recipients`, `message_history`, `app_settings`, `activity_logs`; consentimento (`communication_preferences`, `opt_out_*`, `compliance_audit_log`); bots (`auto_reply_*`, `chatbot_*`, `ai_*`); atendimento (`live_chat_*` nas migrações); infraestrutura (`proxies`, `proxy_*`, `backup_*`, `email_*`, `warmer_*`, `reminders`, `voice_transcriptions`); traduções e enquetes. Migrações SQL: seis em `build/database/migrations/`.

Relações aparentes incluem grupo-contato por `contact_group_members`, campanha-destinatário por `bulk_campaign_recipients`, e sessão associada a dados de WhatsApp/campanhas. Chaves/índices completos e o esquema efetivamente aplicado são **Não identificados** sem abrir o banco.

## 10. Mapa WhatsApp / Baileys

`build/services/whatsapp.service.js` importa Baileys (`:2-3`), cria credenciais sob `userData/auth_sessions` (`:42,74-76`), usa `useMultiFileAuthState` e `makeWASocket` (`:870-893,1006-1052`), trata `connection.update`, `creds.update` e `messages.upsert` (`:923-931,1092-1100`). Tem reconexão exponencial (`:333-405`) e migração de diretório legado (`:547-603`).

Capacidades confirmadas: QR/código de pareamento, criar/desconectar/reconectar/remover sessão, texto/templates/mídia/interativos/enquetes, contatos/chats/histórico, grupos, labels/bloqueio, recebimento de mensagens/presença/chamadas e envio em massa por serviços de campanha. O IPC encaminha eventos ao renderer em `electron.js:1426-1521`. Nenhuma credencial foi exibida e nenhuma conexão foi iniciada.

## 11. Bloqueadores da versão web

| Bloqueador | Arquivos | Substituição | Dificuldade / dependência |
|---|---|---|---|
| UI só compilada e dependente de `electronAPI` | `static/js/main.*`, `preload.js` | reconstruir React e cliente HTTP/WS | Alta; contrato API |
| IPC monolítico (215 handlers) | `electron.js`, `preload.js` | API versionada por domínio | Alta; autenticação/validação |
| Baileys e credenciais locais | `whatsapp.service.js` | worker servidor persistente, cofre/volume de credenciais | Alta; tenancy e segurança |
| SQLite no perfil da máquina | `database.service.js` | banco servidor + migração/importador | Alta; modelagem e backup |
| arquivos, diálogos e shell locais | `electron.js:4855-4878` | upload/download e armazenamento de objetos | Média; autorização |
| update/desktop/window/sons | `update-service.js`, `electron.js`, `notification-sound.service.js` | CI/CD, Web Push/áudio browser | Média; infraestrutura |
| licença ligada a máquina/paths | serviços de licença, `electron.js` | autorização servidor por usuário/organização | Alta; decisão de produto |
| jobs de campanha/agendamento | scheduler, warmer, follow-up | workers e fila persistente | Alta; observabilidade |

## 12. Riscos e 13. Ordem recomendada

Riscos: segredo LeadWave de desenvolvimento no artefato; módulos de segurança/criptografia referenciados mas ausentes; SQL e filesystem genéricos expostos por IPC; CSP permissiva; fonte React e lockfile ausentes; e credenciais Baileys locais. Não há como validar runtime/fluxos remotos dentro deste escopo.

1. Recuperar/criar repositório-fonte, lockfile, `.env.example` e testes básicos sem alterar o desktop.
2. Definir autenticação, tenancy, modelo de licença e contrato OpenAPI/WS para núcleo (sessões, contatos, templates, envio, eventos).
3. Extrair API e worker Baileys; migrar SQLite para banco servidor com backup/importação.
4. Reconstruir as telas principais a partir dos fluxos, não do bundle; depois migrar campanhas, IA e integrações.
5. Endurecer segredos, autorização, auditoria e operação antes de disponibilizar web.
