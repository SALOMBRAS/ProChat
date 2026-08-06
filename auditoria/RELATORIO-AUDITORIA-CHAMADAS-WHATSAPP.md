# Auditoria Técnica — Chamadas WhatsApp e Recursos Avançados
## ChatPro · Estudo de WaCalls, BulkWhatsAppCall e whatsapp-web.js

**Data:** 2026-08-05
**Escopo:** somente auditoria. Nenhum arquivo do ChatPro foi alterado, nenhum código foi implementado.
**Fonte primária:** código-fonte dos três repositórios, clonados e inspecionados em `auditoria/` (WaCalls, BulkWhatsAppCall, whatsapp-web.js), mais os READMEs fornecidos. Documentação pública do WAHA e do WhatsApp Business Platform foi consultada apenas para a seção de comparação com o provider atual.
**Regra de evidência:** tudo o que está afirmado aqui foi visto no código. Quando algo não existe no código, está marcado como **"não encontrado no código analisado"**.

---

# Resumo executivo

1. **Somente um dos três projetos implementa chamadas de verdade: o WaCalls.** Ele é uma reimplementação completa, em Go puro, da pilha VoIP do WhatsApp: sinalização `<call>` via whatsmeow, transporte via relays STUN/SCTP do WhatsApp (Pion WebRTC), mídia SRTP e o codec proprietário **MLow** da Meta portado para Go. Chamadas 1:1 de voz (saída e entrada) com áudio bidirecional funcionam, segundo o próprio README e a estrutura de testes presente no repositório.

2. **O BulkWhatsAppCall não contém nenhuma implementação de chamada.** É apenas um frontend React que consome o pacote npm proprietário e fechado `wavoip-api` (SaaS pago, wavoip.com). O que existe de original no repositório é a técnica de **interceptação do `getUserMedia`** para injetar um MP3 como se fosse o microfone — e a finalidade declarada é disparo de ligações em massa com áudio pré-gravado, o pior padrão possível em termos de risco de banimento.

3. **O whatsapp-web.js não faz chamadas.** Ele apenas (a) emite evento `incoming_call`, (b) rejeita chamadas recebidas (`Call.reject()`) e (c) gera **links de chamada** (`https://call.whatsapp.com/...`). Em compensação, é um catálogo enorme de recursos aproveitáveis para o ChatPro além de chamadas: gestão completa de grupos (incluindo links de convite e aprovação de membros), edição/exclusão/fixação de mensagens, enquetes, eventos agendados, canais (newsletters), etiquetas, listas de transmissão, notas de cliente, mapeamento LID↔telefone, download de mídia em streaming, entre outros.

4. **O WAHA atual não suporta chamadas com áudio — nem esconde essa função.** A API de calls do WAHA (verificada na documentação vigente) se limita a: eventos `call.received` / `call.accepted` / `call.rejected` e endpoint `POST /api/{session}/calls/reject`. Nenhum engine (WEBJS, NOWEB/Baileys, GOWS/whatsmeow) implementa a pilha de mídia — o WaCalls construiu essa pilha do zero sobre o `DangerousInternals()` do whatsmeow.

5. **Descoberta relevante sobre o próprio ChatPro:** o worker (`web/apps/worker`) já possui dependência do `@itsukichan/baileys@7.3.2` e um adapter Baileys (`baileys-whatsapp-worker.adapter.ts`), mas ele é um esqueleto — só gerencia sessões; envio de mensagens, histórico, contatos e reações retornam `NOT_IMPLEMENTED` e só funcionam via provider WAHA. Isso muda o desenho de um futuro "Call Provider": já existe um ponto de encaixe arquitetural para um segundo provider no worker.

6. **Recomendação curta:** manter WAHA para mensagens; estudar o WaCalls como referência canônica para um Call Provider paralelo; tratar chamadas em massa com áudio injetado como recurso **não viável** (risco altíssimo e dependência de SaaS fechado); e, se chamadas forem estratégicas para o SaaS, avaliar em paralelo a **WhatsApp Business Calling API oficial** (lançada em julho/2025), único caminho sem risco de banimento.

---

# Projeto 1 — WaCalls

**Repositório:** https://github.com/JotaDev66/WaCalls · **Licença:** MIT · **Linguagem:** Go 1.26 (servidor) + React 19/TypeScript (cliente)

## 1. Visão geral

- **Objetivo:** fazer e receber chamadas de voz 1:1 do WhatsApp diretamente do navegador, sem app do WhatsApp, pareando contas via QR code.
- **Arquitetura:** monólito Go (`cmd/server`) expondo API HTTP + SSE para um cliente React; a pilha VoIP vive em `internal/voip`; a ponte com o protocolo WhatsApp vive em `internal/wa`.
- **Bibliotecas principais** (vistas em `go.mod`):
  - `go.mau.fi/whatsmeow` — biblioteca Go do protocolo WhatsApp Web/multidevice (mesma família do engine GOWS do WAHA);
  - `github.com/pion/webrtc/v4` — stack WebRTC pura em Go (ICE + DTLS + SCTP), usada **contra os relays do WhatsApp**, não apenas no navegador;
  - `google.golang.org/protobuf` — codificação da mensagem de chave de chamada;
  - `modernc.org/sqlite` — persistência de sessões em SQLite puro-Go (`wacalls.db`);
  - `github.com/mdp/qrterminal` — QR no terminal.
- **Estrutura de pastas:**
  - `cmd/server/` — HTTP/SSE (`httpapi.go`, `broker.go`), gerenciador de sessões (`sessionmanager.go`, `session.go`), ponte WebRTC com o navegador (`bridge.go`), registro de chamadas concorrentes (`callregistry.go`, `callrouting.go`);
  - `internal/wa/socket.go` — adaptador `VoipSocket` sobre o whatsmeow;
  - `internal/voip/core` — tipos de domínio e a interface `VoipSocket`;
  - `internal/voip/signaling` — construção/parsing das stanzas `<call>`, criptografia da call-key, parsing de relay-ack;
  - `internal/voip/transport` — STUN e o relay SCTP (`sctprelay.go`), subscriptions;
  - `internal/voip/media` — RTP, SRTP, SSRC, PCM, derivação de chaves e o codec **MLow** vendored (`mlow/`, ~50 arquivos com vetores de teste);
  - `internal/voip/call` — `CallManager`, a máquina de estados que orquestra uma chamada ponta a ponta;
  - `client/` — React 19 + Vite + Tailwind v4 + shadcn/ui (dialer, modal de chamada recebida, histórico, multi-sessão).
- **Maturidade:** **projeto experimental de altíssima engenharia, próximo de "produção single-tenant"** — e com **arquitetura aproveitável**. Justificativa: tem CI (`.github/workflows/ci.yml`), testes unitários em praticamente todos os pacotes de protocolo (SRTP, STUN, RTP, relay-ack, codec, máquina de estados), tratamento de multi-sessão e multi-chamada concorrente (até 8 por sessão, configurável), histórico de chamadas e um cliente web completo. Não é prova de conceito descartável: o codec Mlow tem vetores de teste de referência (saída do libopus e capturas reais de frames do WhatsApp). Por outro lado, a API não tem autenticação (o próprio README avisa "rode apenas em LAN confiável") e parâmetros expostos na API (`duration_ms`, `record`) **não têm implementação localizada** no código — são aceitos e ignorados.
- **Limites encontrados no código:** vídeo está apenas **esboçado** — as stanzas de offer/accept aceitam `isVideo` e incluem bloco `<video enc="vp8">`, mas **não existe codec de vídeo no repositório**; o caminho de mídia é somente áudio. Chamadas de grupo: **não encontradas** (a máquina de estados é 1:1).

## 2. Comunicação com o WhatsApp

- **Biblioteca:** whatsmeow (Go). **Não usa** Baileys, whatsapp-web.js, WAHA ou Puppeteer. O navegador do usuário fala apenas com o servidor Go; quem fala com o WhatsApp é o whatsmeow via WebSocket binário.
- **Autenticação:** QR code de "aparelhos conectados" (`client.GetQRChannel`), igual ao WhatsApp Web; sessão persiste em SQLite.
- **Envio de comandos / recebimento de eventos:** o arquivo `internal/wa/socket.go` é a peça-chave. Ele usa o `cli.DangerousInternals()` do whatsmeow para:
  - `SendNode` / `Query` — enviar stanzas binárias arbitrárias (`waBinary.Node`) e aguardar resposta por `id` (`WaitResponse`);
  - `EncryptMessageForDevices` — criptografar a **call-key** com Signal Protocol para cada dispositivo do destinatário;
  - `DecryptDM` — decriptar a call-key recebida (mensagens `pkmsg`/`msg`);
  - `GetUserDevices` (USync) — enumerar os dispositivos do peer;
  - `MakeDeviceIdentityNode` — incluir identidade do dispositivo nas stanzas;
  - resolução **LID↔PN** (`ResolveLIDForPN`) e **privacy token** (`GetTCToken`, bloco `<privacy>` no offer).
- **Eventos:** handler whatsmeow (`events.CallOffer`, `events.CallAccept`, `events.CallTransport`, `events.CallTerminate`, `events.CallReject`) roteado por `call-id` para o `CallManager` correto (`cmd/server/session.go`).
- **Fluxo completo:** Navegador → HTTP/SSE → servidor Go → whatsmeow (WebSocket binário, stanzas `<call>` criptografadas Signal) → servidores WhatsApp; mídia trafega por caminho separado: relays WhatsApp (SRTP sobre SCTP/DataChannel).

## 3. Sistema de chamadas (análise profunda)

O fluxo abaixo foi reconstruído de `signaling_build.go`, `callmanager.go`, `callmanager_signaling.go`, `sctprelay.go`, `stun.go`, `encryption.go`, `rtp.go` e `bridge.go`.

**Chamada de saída:**

1. `POST /api/sessions/{sid}/calls {phone}` → `CallManager.StartCall`:
   - gera `callID` e uma **call-key de 32 bytes** (`crypto/rand`);
   - resolve o LID do peer e lista os dispositivos dele via **USync**;
   - monta a stanza `<call><offer call-id call-creator>` contendo: `<privacy>` (TC token, quando existe), `<audio enc="opus" rate="8000">` e `rate="16000"`, `<net medium="3">`, `<capability ver="1">` com bytes fixos de capacidade (`01 05 f7 09 e4 bb 07`), `<destination>` com a **call-key criptografada Signal para cada dispositivo do peer** (`encopt keygen="2"`) e, quando necessário, o device-identity;
   - envia como query e aguarda o **ack**.
2. O **ack do offer** devolve os **endpoints de relay** (IP/porta/token — porta padrão `3480`, constante `WARelayPort`), a lista de participantes e a **hop-by-hop key** (parser `ParseRelayFromAck`, formato estruturado `<relay><te2>`).
3. O cliente envia `<preaccept>` e conecta nos relays: **STUN binding/allocate** nos relays do WhatsApp, depois **ICE + DTLS + SCTP DataChannel** via Pion — ou seja, o relay de mídia do WhatsApp é tratado como um peer WebRTC.
4. Quando o peer aceita (`events.CallAccept`): decripta a call-key do peer, inicializa o **SRTP** e envia stanzas `<transport>` e `<mute_v2>`, além de receipt de accept.
5. **Mídia ativa (estado ACTIVE):**
   - **Subida:** microfone do navegador → PCM cru 16 kHz mono → **WebRTC Data Channel** ("pcm") até o servidor Go (`bridge.go`) → **encode MLow** (frames de 960 amostras @16 kHz) → packetização **RTP PT=120** → **SRTP** → relay;
   - **Descida:** relay → SRTP → **decode MLow** → PCM 16 kHz → Data Channel → alto-falante do navegador (AudioWorklets em `client/public/worklets/`).
6. **Encerramento:** stanza `<terminate>` (ou `<reject>`), cleanup do bridge e do relay.

**Criptografia de mídia:** as chaves SRTP são derivadas por **HKDF-SHA256** sobre a call-key com `info = deviceJid`, produzindo 46 bytes → master key (16) + master salt (14) (`media/encryption.go`). O **SSRC é determinístico**, gerado a partir de `callID + JID` (`GenerateSecureSsrc`), e recalculado quando o ack revela os JIDs de dispositivo reais. Existe keepalive de "silêncio" (pacotes periódicos) para manter o relay vivo.

**Chamada de entrada:** `events.CallOffer` → decripta call-key → extrai relays (formato atributo ou estruturado te2) → envia `<preaccept>` imediato → usuário aceita via API → `<accept>` com call-key criptografada → conecta relays → ACTIVE. Rejeição/timeout por capacidade envia `<reject>`.

**Sobre os termos pedidos:** WebRTC **sim** (Pion, mas usado de forma não convencional — SCTP/DataChannel como transporte de relay, não mídia SRTP padrão WebRTC); sinalização **própria do WhatsApp** (stanzas binárias, não SDP); ICE/STUN **sim**, implementados à mão contra os relays; TURN **não** (o relay do WhatsApp faz esse papel); protobuf **sim** (mensagem de call-key); socket/binário **sim** (protocolo whatsmeow). Não há nenhuma manipulação do WhatsApp Web (não usa Puppeteer nem injeção em página).

## 4. Possível aproveitamento no ChatPro

**Copiar/adaptar com facilidade (conceitos e desenho):**
- Separação em camadas `signaling / transport / media / call` — é exatamente o desenho que um "Call Provider" do ChatPro precisaria;
- Máquina de estados de chamada (`callstate.go`) e o modelo de eventos (ringing → accepted → active → ended) — mapeia direto para a inbox do ChatPro;
- API HTTP + SSE por sessão, histórico de chamadas, registro de chamadas concorrentes por operador — análogo ao multi-atendente do ChatPro;
- Bridge navegador↔servidor por Data Channel com PCM cru + AudioWorklets — resolve o problema "como o operador atende pelo browser".

**Desenvolvimento médio:**
- Reimplementar a camada de sinalização `<call>` (offer/accept/terminate/reject/preaccept/transport) em TypeScript sobre Baileys, **se** o fork `@itsukichan/baileys` expuser envio de nós arbitrários e decriptação Signal equivalente ao `DangerousInternals` — **não verificado nesta auditoria**;
- Serviço Go separado (fork do WaCalls) rodando ao lado do worker, consumindo a mesma conta WhatsApp como **sessão própria** (ver riscos abaixo).

**Exigiria alterar arquitetura:**
- Pilha de mídia completa (MLow + RTP/SRTP + STUN/relay) em ambiente Node/TypeScript: não existe implementação pronta em TS; o caminho realista é Go (aproveitando o código do WaCalls, licença MIT), o que adiciona uma nova linguagem/runtime à stack do ChatPro;
- Múltiplas chamadas concorrentes por conta com roteamento por operador.

**Não viável:**
- Reutilizar a sessão WAHA existente para chamadas: o WaCalls precisa de **credenciais próprias** (whatsmeow/SQLite) — seria outro "aparelho conectado" na mesma conta, ou outra conta;
- Compartilhar a mesma identidade de sessão entre WAHA e um Call Provider sem que o WhatsApp os veja como dispositivos distintos.

## 5. Riscos do projeto

- Engenharia reversa profunda (bytes de capability, protocolo de relay, codec MLow) → **sensível a atualizações do WhatsApp**;
- Licença MIT e código testado mitigam o risco de adoção;
- Sem auth na API → exigiria endurecimento para SaaS;
- Videochamada e chamadas de grupo não existem no código — quem prometer isso estará desenvolvendo do zero.

---

# Projeto 2 — BulkWhatsAppCall

**Repositório:** https://github.com/pedroherpeto/BulkWhatsAppCall · **Licença:** MIT · **Linguagem:** JavaScript (React 18, react-scripts)

## 1. Visão geral

- **Objetivo:** frontend para "disparar ligações em massa com injeção automática de áudio" usando a plataforma paga **Wavoip** (wavoip.com).
- **Arquitetura:** aplicação React de página única, **sem backend próprio**. Todo o arquivo relevante é `src/App.js` (~2.670 linhas).
- **Bibliotecas principais:** `wavoip-api@^2.0.0` (pacote npm **proprietário/de código fechado**, cliente do SaaS Wavoip), `react-dropzone`, `react-hot-toast`, `lucide-react`.
- **Estrutura:** `src/App.js` + CSS + `public/`. Nada mais.
- **Maturidade:** **prova de conceito / demo comercial**. Justificativa: um único componente gigante, sem testes, sem tipagem, tokens e números inseridos via `prompt()`, sem persistência, e — ponto crítico — **não existe loop de disparo em massa**: o código só chama `makeCall(token, number)` a partir de um clique de botão por combinação dispositivo×número. Toda a "inteligência" de chamada está dentro do SaaS fechado.

## 2. Comunicação com o WhatsApp

- **Biblioteca:** `wavoip-api`. O repositório **não contém** nenhuma comunicação direta com o WhatsApp: nem Baileys, nem whatsapp-web.js, nem Puppeteer, nem WebSocket próprio.
- **Autenticação:** token de dispositivo do Wavoip (`WAV.connect(token)`), obtido na plataforma paga. O pareamento real do WhatsApp acontece na infraestrutura do Wavoip, fora deste código.
- **Eventos:** `whatsapp_instance.socket.on('signaling', ...)` com tags `offer` / `accept` / `reject` / `terminate`, e eventos `connect`/`disconnect` do socket.
- **Fluxo:** UI React → `wavoip-api` → servidores Wavoip → (implementação desconhecida, fechada) → WhatsApp.

## 3. Sistema de chamadas

**No código analisado não existe implementação de chamada.** O que existe:

- `wavoip.callStart({ whatsappid })` — inicia chamada (implementação dentro do pacote fechado);
- Tratamento de sinalização: ao receber `accept`, dispara a injeção de áudio;
- **A técnica original do projeto — injeção de áudio:** interceptação global de `navigator.mediaDevices.getUserMedia` (`setupGlobalAudioInterception`). Quando a biblioteca Wavoip pede o microfone, recebe um `MediaStream` sintético vindo de um `AudioBufferSourceNode` (MP3 decodificado via Web Audio API) em vez do microfone real. Há 5 estratégias em cascata: interceptação global, substituição direta de track, "captura forçada" (tocar o áudio alto no elemento HTML para o microfone capturar acusticamente), reprodução simples via AudioContext e reprodução HTML otimizada — com vários `setTimeout` encadeados, o que indica comportamento frágil e dependente de timing;
- WebRTC aparece apenas **indiretamente**: o `getUserMedia` interceptado pressupõe que a `wavoip-api` monta um `RTCPeerConnection` no navegador. **Não foi possível verificar** STUN/TURN/codec/sinalização, pois isso está no pacote fechado.

## 4. Automações encontradas

- Multi-token/multi-dispositivo (N instâncias Wavoip lado a lado);
- Upload de MP3/WAV/OGG/M4A/AAC e reprodução automática no evento `accept`;
- Logs em tempo real e painel de status por dispositivo;
- **Não encontrado:** fila de disparo, controle de taxa, retry, distribuição automática ou importação de CSV — o README descreve esses recursos como se existissem, mas o código não os implementa (chamada é manual, por clique).

## 5. Possível aproveitamento no ChatPro

**Copiar/adaptar com facilidade:**
- A **técnica de interceptação do `getUserMedia`** para injetar áudio pré-gravado numa chamada WebRTC no navegador — é genérica e reutilizável em qualquer Call Provider baseado em browser (inclusive sobre o bridge do WaCalls, onde seria ainda mais simples: basta alimentar o Data Channel PCM com o arquivo em vez do microfone).

**Desenvolvimento médio:** nada além disso — o projeto não tem componentes de backend reutilizáveis.

**Não viável / não recomendado:**
- Adotar a `wavoip-api`/Wavoip como dependência do ChatPro: SaaS fechado, pago, sem transparência de protocolo, plano free com 5 ligações/dia — incompatível com uma plataforma SaaS própria;
- O caso de uso central do projeto (ligações em massa com áudio pré-gravado) é o padrão clássico de spam que o WhatsApp mais pune: **risco de banimento altíssimo**, sem nenhuma proteção no código.

---

# Projeto 3 — whatsapp-web.js

**Repositório:** https://github.com/wwebjs/whatsapp-web.js · **Licença:** Apache-2.0 · **Versão auditada:** 1.34.7 · **Linguagem:** JavaScript (Node.js)

## 1. Visão geral

- **Objetivo:** biblioteca Node.js completa para controlar o WhatsApp Web via navegador automatizado.
- **Arquitetura:** Puppeteer (Chrome) abre o `web.whatsapp.com`; a biblioteca injeta funções na página (`window.WWebJS`) e acessa os módulos internos do webpack do WhatsApp Web via `window.require('WAWeb*')`; a comunicação Node↔página usa `page.evaluate` e `exposeFunction`.
- **Bibliotecas principais:** `puppeteer@24`, `fluent-ffmpeg` (conversão de mídia/stickers), `node-webpmux` (metadados de sticker), `mime`, `node-fetch`.
- **Estrutura:** `src/Client.js` (~3.500 linhas, o coração), `src/structures/` (Chat, GroupChat, Message, MessageMedia, Contact, Call, Poll, Channel, Label, Order, Payment, ScheduledEvent...), `src/authStrategies/` (LocalAuth, RemoteAuth, NoAuth), `src/webCache/` (fixação de versão do WA Web), `src/util/Injected/Utils.js` (~1.800 linhas de código injetado).
- **Maturidade:** **produção.** É o projeto mais maduro do ecossistema não-oficial, com releases frequentes, documentação gerada (`docs/`), suíte de testes, e é a base do engine **WEBJS do WAHA** que o ChatPro já usa.

## 2. Comunicação com o WhatsApp

- Não fala o protocolo diretamente: o **Chrome real** roda o WhatsApp Web oficial e a biblioteca o pilota por dentro. Sessão via QR ou **código de pareamento** (`requestPairingCode`); persistência por `LocalAuth` (arquivos) ou `RemoteAuth` (store externo);
- A `WebCache` (Local/Remote) fixa uma versão conhecida do `web.whatsapp.com` para reduzir quebras quando o WhatsApp atualiza o front;
- Eventos são capturados por hooks nos modelos internos (ex.: `WAWebCollections.Msg`, e para chamadas o `WAWebCallCollection`).

## 3. Chamadas — o que existe e o que não existe

**Encontrado no código:**
- **Evento `incoming_call`** (`Client.js` ~linha 935–950 e 1129–1147): intercepta o `Map.set` do `WAWebCallCollection` e expõe `{ id, peerJid, offerTime, isVideo, isGroup, outgoing, canHandleLocally, webClientShouldHandle, participants }`;
- **`Call.reject()`** (`structures/Call.js`): rejeita a chamada via função injetada `WWebJS.rejectCall(peerJid, id)`;
- **`createCallLink(startTime, callType)`** (`Client.js` ~linha 3252): gera link oficial `https://call.whatsapp.com/video|voice/XXXX` usando o módulo interno `WAWebGenerateEventCallLink` — útil para agendamento de chamadas por link.

**Não encontrado no código (afirmativo):** iniciar chamada de voz/vídeo, atender chamada, qualquer manipulação de mídia WebRTC, STUN/TURN/ICE próprios, SRTP, codec, protobuf de chamada. O whatsapp-web.js **não é um caminho para chamadas com áudio**.

## 4. Recursos encontrados além de chamadas (inventário do código)

**Grupos (`GroupChat.js`, `Client.js`):**
- `createGroup(title, participants, options)` — com envio automático de convite V4 para contatos com restrição de privacidade;
- `addParticipants` (com resultado por participante: já está no grupo, erro, convite enviado), `removeParticipants`, `promoteParticipants`, `demoteParticipants`;
- `setSubject`, `setDescription`, `setPicture`, `deletePicture`;
- `setAddMembersAdminsOnly`, `setMessagesAdminsOnly`, `setInfoAdminsOnly`;
- **`getInviteCode` / `revokeInvite`** — gerar e revogar link de convite;
- **`getGroupMembershipRequests` / `approveGroupMembershipRequests` / `rejectGroupMembershipRequests`** — fila de aprovação de entrada (grupos com admissão moderada);
- `acceptInvite(inviteCode)` e `getInviteInfo(inviteCode)` — entrar em grupo pelo link e inspecionar antes de entrar;
- eventos: `group_join`, `group_leave`, `group_admin_changed`, `group_update`, `group_membership_request`.

**Contatos:**
- `getContacts`, `getContactById`, `getBlockedContacts`, `getProfilePicUrl`, `getCommonGroups`, `getContactDeviceCount`;
- **`getContactLidAndPhone(userIds)`** — mapeamento LID↔número (diretamente relevante para a cura de LIDs que o ChatPro já faz);
- **`saveOrEditAddressbookContact` / `deleteAddressbookContact`** — gravar contato na agenda do WhatsApp;
- **`addOrEditCustomerNote` / `getCustomerNote`** — notas de cliente do WhatsApp Business;
- `isRegisteredUser`, `getNumberId`, `getFormattedNumber`, `getCountryCode`; evento `contact_changed`.

**Mensagens (`Message.js`, `Client.js`):**
- `edit` (edição pós-envio), `delete(everyone)` (apagar para todos ou só para mim), `star`/`unstar`, `pin(duration)`/`unpin`, `forward`, `reply` com quote, `react` + `getReactions`;
- **enquetes**: enviar `Poll`, `vote`, `getPollVotes`, evento `vote_update`;
- **eventos agendados de grupo**: `ScheduledEvent`, `sendResponseToScheduledEvent`, `editScheduledEvent`;
- `Buttons` e `List` (mensagens interativas legadas), `Location`, contatos (vCard) em mensagem;
- menções de usuários e **menções de grupos** (`groupMentions`), `getMentions`, `getGroupMentions`, `getQuotedMessage`;
- opções de envio: `sendAudioAsVoice` (com waveform), `sendVideoAsGif`, `sendMediaAsSticker` (com autor/categorias), `sendMediaAsDocument`, `sendMediaAsHd`, `isViewOnce`, `linkPreview`, `quotedMessageId`, `sendSeen`, `waitUntilMsgSent`;
- `searchMessages`, `getPinnedMessages`, `getMessageById`, `getInfo` (recibos de leitura/entrega por participante), `syncHistory(chatId)`;
- eventos: `message`, `message_create`, `message_ack`, `message_edit`, `message_revoke_everyone`, `message_revoke_me`, `message_reaction`, `message_ciphertext`, `media_uploaded`, `unread_count`.

**Mídia:**
- `downloadMedia()` e **`downloadMediaStream({ chunkSize })`** — download em streaming por chunks (10 MB padrão) — interessante para anexos grandes;
- upload/processamento com `fluent-ffmpeg` e `node-webpmux` (stickers);
- `setAutoDownloadAudio/Documents/Photos/Videos`, `setBackgroundSync`.

**Chats e organização:**
- `archiveChat`/`unarchiveChat`, `pinChat`/`unpinChat`, `muteChat(unmuteDate)`/`unmuteChat`, `markChatUnread`, `sendSeen`;
- **etiquetas (labels)**: `getLabels`, `getChatLabels`, `getChatsByLabelId`, `addOrRemoveLabels` — paralelo ao Kanban/CRM do ChatPro;
- **listas de transmissão**: `getBroadcasts`, `getBroadcastById`.

**Canais (newsletters):** `createChannel`, `getChannels`, `subscribeToChannel`/`unsubscribeFromChannel`, `searchChannels`, `sendChannelAdminInvite`/`accept`/`revoke`, `transferChannelOwnership`, `deleteChannel`, estrutura `Channel`.

**Conta/presença:** `setStatus`, `setDisplayName`, `setProfilePicture`/`deleteProfilePicture`, `sendPresenceAvailable/Unavailable`, `getState`, eventos `change_state`, `change_battery`, `disconnected`.

**Automação:** a biblioteca em si não tem filas; a automação do WAHA (webhooks + REST) já cobre isso. Não encontrado: agendamento/fila interna de envio.

## 5. Aproveitamento no ChatPro

**Copiar/adaptar com facilidade** (a maioria já existe no WAHA ou é exposta por ele, pois o engine WEBJS é esta biblioteca — basta habilitar/usar endpoints):
- Eventos de chamada (`call.received` + reject) na inbox — notificação "X está te ligando", botão recusar, registro no CRM;
- `createCallLink` — botão "criar link de chamada" na conversa;
- Links de convite de grupo (`getInviteCode`/`revokeInvite`) e fila de aprovação de membros;
- Edição de mensagem, apagar para todos, fixar mensagem, enquetes, eventos agendados;
- `getContactLidAndPhone` para fortalecer a cura de identidade LID/PN;
- Notas de cliente e labels como ponte nativa com o CRM/Kanban.

**Desenvolvimento médio:**
- Download de mídia em streaming por chunks para anexos grandes;
- Agenda de contatos do WhatsApp (`saveOrEditAddressbookContact`) sincronizada com o CRM;
- Canais/newsletters (caso o ChatPro queira suportar).

**Exigiria alterar arquitetura:** nada aqui exige — o ChatPro já consome esse universo via WAHA.

**Não viável:** usar o whatsapp-web.js para chamadas com áudio (recurso inexistente no código).

---

# Comparação com o WAHA atual

## O que o WAHA suporta hoje em chamadas (verificado na documentação vigente)

| Recurso | WEBJS | WPP | GOWS | NOWEB |
|---|---|---|---|---|
| `POST /api/{session}/calls/reject` | ✔️ | ✔️ | ✔️ | ✔️ |
| Evento `call.received` | ✔️ | ✔️ | ✔️ | ✔️ |
| Evento `call.accepted` | — | — | ✔️ | ✔️ |
| Evento `call.rejected` | ✔️ (só quando rejeitada via API) | — | ✔️ | ✔️ |

E, desde a versão 2025.12, um "Calls App" de **auto-rejeição com resposta automática** (rejeita e manda mensagem orientando o usuário a escrever).

**Conclusões:**
- **O WAHA não suporta fazer/atender chamadas com áudio, e não "esconde" essa função** — a limitação está nos engines: nenhum deles (nem o GOWS, que usa whatsmeow — a mesma base do WaCalls) implementa a pilha de mídia. O WaCalls prova que é possível construí-la sobre whatsmeow, mas isso foi trabalho de engenharia reversa do próprio projeto, não algo que o WAHA possa simplesmente "ligar".
- **Não é necessário trocar de provider** para nada que existe hoje no ChatPro; o WAHA continua adequado para mensagens e já entrega os eventos de chamada.
- **É possível criar um provider paralelo** — e o ChatPro já tem o encaixe: o worker define a porta `WhatsAppWorkerPort` com providers WAHA e Baileys (esqueleto). Um `CallProvider` seria mais um provider no mesmo padrão.
- **Usar Baileys só para chamadas:** o Baileys (e o fork `@itsukichan/baileys`) emite eventos de chamada e tem `rejectCall`, mas **não existe pilha de mídia pronta no ecossistema Baileys** (a única que existe em JS é a fechada do Wavoip). Portar MLow+SRTP+relay do WaCalls para TypeScript é esforço grande e de alto risco. O caminho de menor atrito para chamadas reais é **Go/whatsmeow (aproveitando o WaCalls)**, não Baileys.

## Modelos possíveis

**Modelo A (estado atual + eventos de chamada) — recomendado como passo 1:**

```
ChatPro → WAHA → Mensagens (+ eventos call.received / reject)
```
Custo baixíssimo: habilitar os eventos `call.*` no webhook do WAHA (hoje o `docker-compose.waha.yml` já configura `WHATSAPP_HOOK_URL`; bastaria assinar os eventos de chamada) e criar UI/CRM para "chamada recebida/perdida/rejeitada". **Zero risco novo.**

**Modelo B (Call Provider paralelo, estilo WaCalls) — para chamadas reais:**

```
                 ┌→ WAHA ────────────→ Mensagens/grupos/contatos
ChatPro → Worker ┤
                 └→ Call Provider ───→ Chamadas de voz
                     (serviço Go baseado no WaCalls/whatsmeow)
```
- **Vantagens:** não toca no caminho de mensagens (estável); a pilha VoIP fica isolada e escala por si; aproveita código MIT testado; o bridge PCM-por-DataChannel resolve o áudio do operador no browser; multi-chamada concorrente por conta já existe no desenho.
- **Riscos/custos:** exige **sessão WhatsApp própria** (outro aparelho conectado na mesma conta — ou uma conta dedicada a chamadas); adiciona Go à stack operacional; dependência de engenharia reversa sensível a updates do WhatsApp; precisa endurecer auth (o WaCalls não tem); precisa de estratégia de pairing por workspace no SaaS.
- **Atencão de identidade:** como seria uma sessão separada da sessão WAHA, o ChatPro precisaria reconciliar que "a mesma conta" aparece em dois providers (JID/LID já é domínio que o ChatPro domina).

**Modelo C (oficial — WhatsApp Business Calling API):** lançada em julho/2025 dentro do WhatsApp Business Platform (Cloud API): chamadas iniciadas pelo usuário (aceitar/rejeitar/terminar) e pela empresa (mediante permissão), deep links, horário comercial, etc. **Único caminho sem risco de banimento**, mas exige migrar a conta para a API oficial (modelo de cobrança e onboarding diferentes, incompatível com WAHA para a mesma linha). Recomendado avaliar como oferta separada para clientes enterprise, não como substituto do fluxo atual.

---

# Segurança e riscos (classificação por recurso)

| Recurso | Risco de ban/bloqueio | Estabilidade | Dependência de eng. reversa | Quebra por update do WA | Escala SaaS |
|---|---|---|---|---|---|
| Eventos de chamada + reject via WAHA | **Baixo** | Alta | Baixa (via engine) | Baixa | Alta |
| Links de chamada (`createCallLink`) | **Baixo** | Alta | Média | Média | Alta |
| Recursos de grupo/contatos/mensagens (whatsapp-web.js via WAHA) | **Baixo–Médio** | Alta | Média | Média (WebCache mitiga) | Alta |
| Chamada 1:1 com áudio (estilo WaCalls) para contatos conhecidos | **Médio** | Média (protocolo interno) | **Alta** (MLow, relay, capability bytes) | **Alta** | Média (1 sessão Go por conta; chamadas concorrentes OK) |
| Chamadas de saída para desconhecidos (prospecção) | **Alto** | Média | Alta | Alta | Baixa–Média |
| Chamadas em massa com áudio pré-gravado (modelo BulkWhatsAppCall) | **Muito alto** | Baixa | Alta (e opaca, SaaS fechado) | Alta | Baixa |
| WhatsApp Business Calling API (oficial) | **Nenhum (oficial)** | Alta | Nenhuma | Nenhuma | Alta |

Notas:
- Qualquer caminho não-oficial de chamada depende de detalhes internos que o WhatsApp pode mudar sem aviso (o histórico do ecossistema mostra que mensageria via WEBJS/Baileys quebra ocasionalmente; a pilha VoIP, por ser menos exercitada pela comunidade, tende a ter menos olhos para consertar rápido).
- Para SaaS multi-tenant, o modelo de "uma sessão de chamadas por conta cliente" precisa de política de pareamento, quota de chamadas concorrentes e monitoramento de saúde da conta (o WaCalls já expõe `-max-calls-per-session`).

---

# Arquitetura sugerida para o ChatPro (futura — sem implementação)

```
┌─────────────────────────────┐
│  Dashboard React (Vite/TS)  │  ← inbox, softphone (PCM via Data Channel/WebRTC),
└──────────────┬──────────────┘    modal de chamada recebida, histórico de chamadas
               │
        ┌──────▼──────┐
        │  API (Node/ │  ← rotas /calls/* espelhando o contrato do WaCalls
        │  Express)   │     (start/accept/reject/end/history + SSE de eventos)
        └──────┬──────┘
               │ comandos tipados (WorkerCommand + novos CallCommand)
        ┌──────▼───────────────────────────────────────┐
        │  Worker (WhatsApp Services)                  │
        │  ├── Message Provider  → WAHA (atual)        │
        │  ├── Baileys Adapter   → (esqueleto atual)   │
        │  ├── Call Provider     → NOVO: serviço Go    │
        │  │    (fork WaCalls: signaling/transport/    │
        │  │     media/MLow, 1 sessão por conta)       │
        │  ├── Group Service     → WAHA (convites,     │
        │  │    aprovação, admins)                     │
        │  ├── Contact Service   → WAHA (LID↔PN,       │
        │  │    agenda, notas)                         │
        │  └── Event Bus         → SSE/webhooks → CRM, │
        │         Kanban, inbox (message.* + call.*)   │
        └──────┬───────────────┬───────────────────────┘
               │               │
           WAHA HTTP      WhatsApp WS (whatsmeow) + relays SRTP/SCTP
               │               │
        ┌──────▼───────────────▼──────┐
        │  SQLite / Supabase          │  ← sessões, chamadas (call_logs),
        └─────────────────────────────┘    contatos, identidades LID/PN
```

**Módulos necessários:**
1. **Call Provider (Go)** — fork endurecido do WaCalls: auth na API, multi-tenant (workspaceId), métricas, reconciliação de sessão com o cadastro do ChatPro;
2. **Softphone no frontend** — componente React (referência: `client/` do WaCalls: Dialer, IncomingCallModal, AudioWorklets de captura/playback);
3. **Call Commands/Events nos contratos** — `startCall/acceptCall/rejectCall/endCall`, eventos `call.ringing/accepted/ended` publicados no mesmo barramento dos eventos de mensagem;
4. **Call logs no banco** — tabela de chamadas vinculada a contato/conversa/CRM (o `history` do WaCalls é o modelo);
5. **Group/Contact Services** — expor no ChatPro o que o WAHA/WEBJS já entrega (convites, aprovação de membros, LID↔PN, notas);
6. **Reconciliador de identidade** — mapear que a sessão de chamadas e a sessão WAHA pertencem à mesma conta (JID/LID).

---

# Comparação geral dos três projetos

| Recurso | Projeto | Viabilidade no ChatPro | Complexidade |
|---|---|---|---|
| Chamada de voz 1:1 com áudio real | WaCalls | Viável como provider paralelo em Go | **Alta** |
| Chamada de entrada: detectar/rejeitar | WaCalls · whatsapp-web.js · WAHA | **Viável já hoje via WAHA** | **Baixa** |
| Link de chamada (call.whatsapp.com) | whatsapp-web.js | Viável via WAHA/WEBJS | **Baixa** |
| Videochamada | WaCalls (só stanzas; sem codec) | Não viável sem desenvolvimento grande | **Muito alta** |
| Chamadas de grupo | — (não encontrado em nenhum dos três) | Não viável no momento | **Muito alta** |
| Chamadas em massa + injeção de MP3 | BulkWhatsAppCall | **Não recomendado** (risco muito alto; SaaS fechado) | Média |
| Técnica de injeção de áudio (getUserMedia) | BulkWhatsAppCall | Reutilizável como conceito no softphone | Baixa |
| Grupos: criar/gerir/convite/aprovação | whatsapp-web.js | Viável via WAHA | **Baixa–Média** |
| Contatos: LID↔PN, agenda, notas | whatsapp-web.js | Viável via WAHA | **Baixa–Média** |
| Mensagens: editar/apagar/fixar/enquete/eventos | whatsapp-web.js | Viável via WAHA | **Baixa–Média** |
| Mídia: download em streaming | whatsapp-web.js | Viável | Média |
| Canais/newsletters, labels, broadcast | whatsapp-web.js | Opcional, via WAHA | Média |
| Pilha de sinalização `<call>` (design de referência) | WaCalls | Referência canônica para o Call Provider | — |
| Multi-sessão/multi-chamada concorrente por operador | WaCalls | Modelo direto para multi-atendente | Média |

---

# Recomendação final

**1. Qual projeto tem maior valor para estudarmos?**
**WaCalls**, disparado — é o único que responde "como fazer chamadas WhatsApp" de verdade, com código testado e licença MIT. O whatsapp-web.js é o segundo em valor, mas por outro motivo: é um catálogo de recursos de produto (grupos, contatos, mensagens avançadas) que o ChatPro pode ligar via WAHA com baixo custo. O BulkWhatsAppCall tem valor apenas como referência da técnica de injeção de áudio e como estudo de caso de risco.

**2. Qual caminho parece mais seguro para implementar chamadas?**
Em etapas: **(a)** agora — eventos de chamada + rejeição via WAHA (risco baixo, valor imediato para a inbox/CRM); **(b)** PoC de chamadas reais com um **fork do WaCalls como Call Provider Go paralelo** (Modelo B), validando estabilidade e taxa de bloqueio com contas descartáveis antes de qualquer rollout; **(c)** em paralelo, avaliar a **WhatsApp Business Calling API oficial** como oferta enterprise — é o único caminho definitivo em termos de segurança de conta. Não recomendo o caminho Baileys-para-chamadas: exigiria portar toda a pilha de mídia (MLow/SRTP/relay) para TypeScript, esforço maior que adotar o código Go pronto.

**3. Devemos continuar com WAHA ou criar um provider próprio?**
**Continuar com WAHA para mensagens** — ele não é o gargalo e já cobre (ou cobre com ajustes de configuração) praticamente todo o catálogo do whatsapp-web.js. Criar provider próprio **somente para chamadas**, no padrão de provider paralelo que o worker do ChatPro já suporta arquiteturalmente. Trocar o provider de mensagens agora seria custo sem ganho.

**4. Quais funcionalidades deveriam ser priorizadas depois dessa análise?**
1. **Eventos de chamada na inbox** (`call.received` → notificação/registro no CRM; botão rejeitar; log de chamada perdida) — barato e imediato;
2. **Gestão de grupos via WAHA** — link de convite/revogação e fila de aprovação de membros (alto valor de produto, baixo risco);
3. **Mensagens avançadas** — edição, apagar para todos, fixar, enquetes, eventos agendados de grupo;
4. **Fortalecimento de identidade** — `getContactLidAndPhone` como fonte adicional na cura LID/PN que o ChatPro já executa;
5. **PoC do Call Provider (WaCalls)** — chamada 1:1 com áudio entre dois números de teste, medindo estabilidade por 2–4 semanas antes de decidir productização.

---

## Anexos

- Repositórios clonados para inspeção: `auditoria/WaCalls`, `auditoria/BulkWhatsAppCall`, `auditoria/whatsapp-web.js` (somente leitura; não fazem parte do build do ChatPro).
- READMEs fornecidos: `auditoria/README - WaCalls.md`, `auditoria/README - BulkWhatsAppCall.md`, `auditoria/README - whatsapp-web.js.md`.
- Arquivos-chave inspecionados no WaCalls: `internal/wa/socket.go`, `internal/voip/signaling/signaling_build.go`, `internal/voip/call/callmanager*.go`, `internal/voip/transport/sctprelay.go` + `stun.go`, `internal/voip/media/encryption.go`, `cmd/server/{session,bridge,httpapi}.go`, `go.mod`.
- Arquivos-chave no whatsapp-web.js: `src/Client.js`, `src/structures/{Call,GroupChat,Message}.js`, `src/util/Injected/Utils.js`, `package.json`.
- BulkWhatsAppCall: `src/App.js`, `package.json` (íntegros).
- Itens declarados como **não encontrados no código analisado**: implementação de chamada no BulkWhatsAppCall (está no SaaS fechado `wavoip-api`); envio/atendimento de chamada e pilha de mídia no whatsapp-web.js; videochamada funcional e chamadas de grupo no WaCalls; implementação dos parâmetros `duration_ms` e `record` da API do WaCalls; fila/disparo em massa automatizado no BulkWhatsAppCall.
