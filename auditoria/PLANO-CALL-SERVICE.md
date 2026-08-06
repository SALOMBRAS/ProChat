# Plano de Implementação — Call Service (Chamadas WhatsApp reais)
## ChatPro + reuso em sistemas futuros · baseado na auditoria WaCalls/whatsapp-web.js

**Data:** 2026-08-05
**Status:** proposta de desenho. Nenhuma linha de código implementada ainda.
**Premissa validada na auditoria:** chamadas de voz 1:1 reais do WhatsApp são possíveis hoje via pilha whatsmeow + relays SRTP/SCTP + codec MLow (projeto WaCalls, MIT). WAHA não suporta nem suportará isso via configuração; o engine GOWS é fechado e o Baileys não tem pilha de mídia.

---

## 1. Decisão arquitetural central

**Não integrar chamadas dentro do ChatPro.** Criar um **microserviço autônomo ("Call Service")** — fork endurecido do WaCalls — consumido por qualquer sistema via HTTP + webhooks.

Motivos:
1. **Reuso**: o segundo sistema vira apenas cliente HTTP da mesma API;
2. **Isolamento de risco**: a pilha VoIP (engenharia reversa, sensível a updates do WhatsApp) não contamina mensageria/CRM/inbox;
3. **Sem fork de terceiros**: WAHA segue intacto; o Call Service é 100% nosso sobre código MIT auditado;
4. **Stack correta**: a pilha de mídia existe em Go; portar para Node seria inviável em custo/risco;
5. **Padrão já conhecido**: webhooks HMAC no mesmo modelo do webhook WAHA que o ChatPro já processa.

## 2. Desenho alvo

```
┌─────────────┐   ┌──────────────┐
│  ChatPro    │   │ Outro sistema │
└──────┬──────┘   └──────┬───────┘
       │  HTTP + Webhook HMAC (mesma API)
       └──────┬──────────┘
        ┌─────▼──────────────────┐
        │  CALL SERVICE (Go)     │
        │  POST /sessions        │  cria conta + QR pairing
        │  POST /sessions/{id}/calls            inicia chamada
        │  POST /calls/{id}/accept|reject       entrada
        │  DELETE /calls/{id}                   encerra
        │  POST /calls/{id}/webrtc              SDP do softphone
        │  GET  /calls/history                  histórico
        │  Webhooks: call.ringing / accepted /  │
        │            rejected / ended / recorded│
        └─────┬──────────────────┘
              │ whatsmeow (sinalização <call>)
              │ relays WhatsApp (STUN + SCTP/DC + SRTP + MLow)
        ┌─────▼─────┐
        │ WhatsApp  │  ligação real 1:1 de voz, saída e entrada
        └───────────┘
```

- **Sessões**: 1 sessão de chamadas por conta WhatsApp, pareada como aparelho conectado adicional (ou chip dedicado). Reconciliação com a sessão WAHA pelo JID/LID.
- **Áudio do operador**: navegador ⇄ Call Service via WebRTC Data Channel com PCM 16 kHz (bridge já existente no WaCalls); no futuro, injeção de áudio pré-gravado = alimentar o canal com arquivo.
- **Gravação**: o PCM das duas direções já atravessa o servidor — implementar o parâmetro `record` (exposto mas não implementado no WaCalls) desviando PCM para WAV/Opus e enviando ao storage (Supabase).
- **Escala**: multi-sessão e multi-chamada concorrente por conta já existem no WaCalls (`-max-calls-per-session`, default 8). Modelo SaaS: 1 container multi-tenant com quota por workspace.

## 3. Fases

### Fase 0 — Prova de conceito (critério de corte)
- Subir o WaCalls original; parear número de teste descartável;
- Ligações reais de saída e entrada; medir: tempo de estabelecimento, qualidade/latência de áudio, estabilidade ao longo de 1–2 semanas de uso diário;
- **Critério de corte**: se não houver estabilidade aceitável, parar aqui e reavaliar (custo incorrido: quase zero).

### Fase 1 — WaCalls → Call Service (hardening)
- API key + conceito de workspace/tenant em todas as rotas;
- Webhooks HMAC (além do SSE atual): `call.ringing`, `call.accepted`, `call.rejected`, `call.ended`, `call.recorded`;
- Dockerfile + compose; reconexão robusta de sessão; logs estruturados; métricas (chamadas ativas, duração, falhas por etapa do protocolo);
- Implementar gravação (`record`) e histórico persistente;
- Testes: manter e ampliar a suíte existente (protocolo já é coberto).

### Fase 2 — Integração ChatPro
- Worker: `CallProvider` implementando a porta de provider existente (terceiro adapter, ao lado de WAHA e Baileys);
- Contratos: `CallCommand` (`startCall/acceptCall/rejectCall/endCall`) + eventos `call.*` no barramento atual;
- Banco: `call_logs` (contato, conversa, direção, duração, resultado, gravação) + gatilhos CRM/Kanban (chamada perdida → card; chamada atendida → registro na timeline);
- API: rotas `/calls/*` espelhando o contrato do Call Service;
- Frontend: softphone no inbox reaproveitando o cliente React do WaCalls (React 19 + TS + Tailwind + shadcn — mesma stack): Dialer, IncomingCallModal, AudioWorklets de captura/playback;
- Reconciliador de identidade: vincular sessão de chamadas à conta (JID/LID).

### Fase 3 — Segundo sistema
- Apenas consumir a API do Call Service. Sem desenvolvimento adicional de chamada.

## 4. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Quebra por update do WhatsApp | Serviço isolado; suíte de testes de protocolo; comunidade whatsmeow ativa; patch sem tocar ChatPro |
| Bloqueio de número | Uso para atendimento (contatos existentes); evitar prospecção fria em volume; telemetria de saúde da sessão; chip dedicado opcional |
| Sem vídeo/grupo | Fora de escopo (não existe no código); roadmap futuro separado |
| Sessão extra por conta | WhatsApp permite múltiplos aparelhos conectados; reconciliação via JID/LID |
| Operação Go na stack | 1 binário self-contained (sem cgo/DLL); Docker; runbook |

## 5. Responsabilidades

- **Eu (agente)**: serviço Go endurecido, adapters do worker, contratos, rotas de API, softphone React, testes, documentação;
- **Você**: número(s) de teste, validação das ligações reais (Fase 0), decisão de go/no-go por fase, infraestrutura de deploy.

## 6. Referências

- Auditoria completa: `auditoria/RELATORIO-AUDITORIA-CHAMADAS-WHATSAPP.md`
- Código base: `auditoria/WaCalls` (MIT) — signaling/transport/media/MLow + cliente React
- Eventos de chamada via WAHA (passo paralelo de baixo custo): `call.received/accepted/rejected` + `POST /api/{session}/calls/reject`
