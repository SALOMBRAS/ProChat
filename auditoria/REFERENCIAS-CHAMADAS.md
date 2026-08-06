# Conhecimento extraído das referências de chamadas WhatsApp
## Data: 2026-08-05 · Fontes: whatsmeow PR#1201, issue#555, arugaz/whatsmeow call.go, GOWA issue#741

---

## 1. Issue tulir/whatsmeow#555 — "Make a call, reject a call, stream audio on call, is it possible?" (2024)

### DESCOBERTA CRÍTICA (comentário de abaz1997)
> "the server drops the call offer **if the call key is encrypted using pre-keys**. As soon as I responded to a text from the linked device, the session started using DMs and **the call worked as intended**."

**Tradução técnica:** quando a conta nunca trocou mensagens com o destinatário, a call-key é criptografada com mensagem Signal do tipo pre-key (`pkmsg`). O servidor do WhatsApp **descarta o offer em silêncio** nesse caso — exatamente o sintoma do nosso teste (ringing eterno, sem ack, celular mudo). Ao **trocar uma mensagem de texto** entre as contas, a sessão Signal passa a usar encriptação DM (`msg`) e a chamada funciona.

**Ação para o ChatPro/Call Service:** antes da primeira chamada para um contato, garantir vínculo (troca de mensagens). Para o teste: enviar texto do número de teste para o outro e responder, antes de ligar.

### Outros aprendizados da thread
- Manjit2003: "o telefone tocou mas ficou em 'Connecting' dos dois lados" → confirma a separação: **sinalização** (fazer tocar) é a parte fácil; **mídia** (STUN/relay/SRTP/MLow) é o problema difícil — que o WaCalls resolveu.
- arugaz: fork dele tem apenas offer/reject; nunca conectou ao relay (confirmado pelo `call.go` abaixo).
- Referências históricas: `bhavya32/WA-Calls` (PoC antigo, morto); Baileys issue #40 (passos para chamadas no ecossistema JS).

## 2. arugaz/whatsmeow `call.go` (baixado em `auditoria/ref-arugaz-call.go`)

Contém **apenas**:
- `handleCallEvent` — dispatcher de stanzas `<call>` para eventos tipados: `CallOffer`, `CallOfferNotice`, `CallRelayLatency`, `CallAccept`, `CallPreAccept`, `CallTransport`, `CallTerminate`, `CallReject`, `UnknownCallEvent` (com metadados `BasicCallMeta`: from, t, call-creator, call-id, group-jid, caller_pn/caller_lid);
- `RejectCall(ctx, callFrom, callID)` — envia stanza `<call><reject count="0">`.

**Conclusão:** o whatsmeow (e forks) entrega **eventos de chamada + rejeição** de fábrica. Não há oferta com mídia, nem relay, nem codec. É exatamente essa camada de eventos que o WaCalls consome (`events.CallOffer` etc.) — e é o que o WAHA expõe como `call.received/rejected`.

## 3. PR tulir/whatsmeow#1201 — "call: add first-class 1:1 call signaling and media-handoff API"

**Autor:** purpshell (Rajeh Taher) — o mesmo autor do `meowcaller`, de onde o WaCalls vendored o codec MLow. **Estado:** OPEN, criada 2026-07-09, **atualizada 2026-08-04** (ativo). Branch: `rajeh/voip-call-api`.

### O que a PR adiciona ao whatsmeow (control plane; RTP/SRTP/codecs ficam fora, no meowcaller#8)
- APIs de ciclo de vida de chamada 1:1 (saída e entrada);
- criptografia/decriptografia de call-key;
- parsing de relays + **eleição de endpoint direction-aware** (FNA para entrada; não-FNA autenticado para saída);
- eventos tipados: media-ready/media-stop, mute, ack, vídeo;
- **negociação de vídeo inicial + transições de vídeo no meio da chamada**;
- atualização de identidade do dispositivo que atendeu (para rekey de mídia).

### Chamadas de grupo (em desenvolvimento na mesma PR, com corpora de teste derivados de capturas reais)
- `call_group*.go` — estado de chamada de grupo (snapshots ordenados);
- `call_group_invite*.go` — convites singulares, capability de dispositivo, roster;
- `call_group_rekey*.go` — ingestão de chaves de participantes, fanout de rekeys por época;
- `call_link.go` (441 linhas) — links de chamada.

### Alerta de regressão atual (comentário na PR)
Usuário com implementação QR-linked + meowcaller mais recente relata: **áudio de saída é aceito, mas a mídia de entrada chega só num burst inicial de pacotes MLow/SID e para** — relay allocation e consent pings continuam OK. Pergunta se a PR cobre a transição de relay pós-accept necessária hoje. **Implicação:** validar no nosso teste se o áudio **se sustenta** além dos primeiros segundos nos dois sentidos.

### Importância estratégica
Se mergeada, o whatsmeow passa a ter o control plane de chamadas de fábrica — nosso Call Service poderia migrar das entranhas custom (WaCalls `internal/voip/signaling`) para API upstream, reduzindo o custo de manutenção. **Acompanhar essa PR é parte do plano.**

## 4. Issue aldinokemal/go-whatsapp-web-multidevice#741 — pedido de chamadas nativas no GOWA

Pedido de feature (aberto) para ciclo completo de chamadas no GOWA. Cita duas inspirações:
- **WaCalls** (que já auditamos e rodamos);
- **AstraCalls** — `AstraOnlineWeb/AstraCalls`, confirmado: **fork production-ready do WaCalls** com PostgreSQL por sessão, **API de mensagens**, **webhooks**, integração Chatwoot e deploy Docker Swarm. Atualizado 2026-08-04, 49 stars.

**Relevância direta:** o AstraCalls é essencialmente a "Fase 1" do nosso plano já construída por terceiros (hardening + webhooks + Postgres). Candidato forte a **base do nosso Call Service** em vez do WaCalls cru — auditar na Fase 1.

## 5. Síntese: pré-condições para a chamada tocar (estado do nosso teste)

| # | Pré-condição | Status |
|---|---|---|
| 1 | JID canônico (BR sem 9º dígito quando aplicável) | ✅ corrigido no nosso build (`IsOnWhatsApp` antes de chamar) |
| 2 | Sessão Signal DM estabelecida (troca de texto prévia; pkmsg é descartado pelo servidor) | ⬜ depende de ação do usuário no teste |
| 3 | Mídia sustentada pós-accept (possível regressão atual do WhatsApp) | ⬜ validar no teste (áudio por >30s nos dois sentidos) |
