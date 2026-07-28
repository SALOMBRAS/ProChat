# Chamadas de voz (WaCalls) — avaliação feita, projeto adiado

**Decidido em 28/07/2026. Status: adiado, sem data.**

Foi feita uma avaliação de viabilidade de construir um serviço próprio de chamadas
de voz WhatsApp sobre o núcleo VoIP do
[WaCalls](https://github.com/JotaDev66/WaCalls) (Go + whatsmeow + pion, MIT).
**O projeto está adiado.** Nada foi integrado ao ChatPro e nenhum número foi
pareado.

Este documento existe para que a avaliação não se perca e para registrar um alerta
operacional que **vale mesmo sem o projeto**.

## Onde está a avaliação

Fora deste repositório, em `spike-wacalls/` (irmão do worktree, não versionado):

| Arquivo | Conteúdo |
|---|---|
| `RELATORIO.md` | medições: build, testes, cobertura, conectividade, superfície da API |
| `DESENHO-SERVICO.md` | desenho do serviço: rotas, DDL SQLite + Supabase, docker-compose, caminho do áudio, componente a componente |
| `RISCO-BANIMENTO.md` | risco de banimento, com fontes primárias |
| `probe/`, `probe-version/` | dois probes Go descartáveis (ver abaixo) |

## Recomendação, se for retomado

**Aprovar apenas a Etapa 0 como portão — 0,5 semana-pessoa.** Parear um número
**descartável** no WaCalls upstream, sem fork, e provar uma chamada 1:1 de 60
segundos com áudio nos dois sentidos. Se o áudio atravessar, aprovar as ~12
semanas-pessoa restantes. Se não, o projeto termina por meia semana-pessoa em vez
de por doze.

O motivo do portão: a issue [#38](https://github.com/JotaDev66/WaCalls/issues/38)
(chamadas 1:1 morrendo em ~20–22s) continua **aberta**. A correção na branch
`develop` é plausível pelo código, mas é **malha aberta** — `sendRegistration`
dispara Binding Requests e o caminho de mídia descarta toda resposta STUN
(`if transport.IsStunPacket(data) { return }`), sem match de transaction ID nem
tratamento de erro. A função tem 0% de cobertura. Nada disso foi validado com
chamada real.

Outras conclusões que sobrevivem ao adiamento:

- A base a usar seria `develop`, não `main`. O `main` está congelado no `v1.0.0`,
  que é exatamente o commit que a issue #38 reporta como bugado.
- Autenticação, webhook HMAC, Docker, rate limit e OpenAPI já existem no upstream.
  A lacuna real para o ChatPro é **multi-tenancy** — não existe `workspaceId` em
  lugar nenhum do schema deles.
- O codec MLow é Go puro vendorizado; `CGO_ENABLED=0` produz binário estático sem
  dependências. Não há DLL nem cgo obrigatório.

---

## Alerta operacional — vale mesmo sem o WaCalls

**O WhatsApp permite 1 aparelho principal + 4 dispositivos vinculados. Vincular um
quinto derruba o mais antigo, sem aviso.**

O WAHA **já consome 1 desses 4 slots** hoje, e é ele que entrega as mensagens de
produção.

O restante é consumido facilmente e por acidente:

| Slot | Ocupante típico |
|---|---|
| 1 | **WAHA (ChatPro)** — produção |
| 2 | WhatsApp Web no navegador de alguém da equipe |
| 3 | WhatsApp Desktop |
| 4 | qualquer teste, integração ou app de terceiro |

Quando alguém vincula o quinto, o WhatsApp desconecta o vínculo **mais antigo**.
Se o mais antigo for o WAHA, o ChatPro para de receber mensagens — sem erro de
aplicação, sem alerta, apenas silêncio. Recuperar exige reparear e, dependendo do
caso, ressincronizar histórico.

**Regras práticas:**

1. Trate os 4 slots como **recurso escasso e monitorado**. O slot do WAHA não é
   negociável.
2. Antes de vincular qualquer coisa nova ao número de produção, confira
   **Aparelhos conectados** no app e desvincule o que estiver sobrando.
3. Nunca faça teste ou experimento de integração no número de produção. Qualquer
   avaliação de biblioteca vai em número descartável.
4. Se o WaCalls for retomado, ele consome **mais um slot** — o whatsmeow pareia
   como dispositivo próprio e **não** compartilha credencial com o WAHA. Isso
   deixaria 2 slots livres, na melhor hipótese.

E o ponto que fecha o assunto: **banimento é por número, não por dispositivo.**
Rodar um cliente experimental "só para chamadas" no mesmo número não isola risco
nenhum — injeta o risco daquele cliente no número que carrega as conversas de
produção.

---

## Um resultado da avaliação que já foi aproveitado

A investigação produziu, como subproduto, o diagnóstico do erro de pareamento do
Baileys: o servidor responde `Client outdated (405)` para a versão de protocolo
que a biblioteca embute. **Não é banimento do número e não é bloqueio de IP.**
Provado com o mesmo cliente, na mesma máquina e no mesmo IP, mudando apenas a
versão anunciada.

Isso é problema de manutenção de versão, independe do WaCalls, e continua valendo
com o projeto adiado.

## Referências

- [`crm-roadmap.md`](./crm-roadmap.md) — onde chamadas de voz aparecem no roadmap
- [`call-log-na-inbox.md`](./call-log-na-inbox.md) — chamadas perdidas hoje já
  chegam à Inbox pela WAHA; um serviço próprio de chamadas duplicaria esse fato e
  precisaria reconciliar os dois modelos
- [`whatsapp-flow.md`](./whatsapp-flow.md) — o ciclo atual de WhatsApp
