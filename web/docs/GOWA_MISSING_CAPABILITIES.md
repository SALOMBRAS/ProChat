# GOWA — capacidades ausentes para o ChatPro

Levantado contra `aldinokemal/go-whatsapp-web-multidevice` (README, docs de
webhook e `docs/openapi.yaml`), cruzado com o que o ChatPro consome hoje.

**Critério de entrada:** só entra o que **não existe**. Contrato diferente não é
ausência — `/send/message` com `phone`/`message` em vez de `session`/`chatId`/`text`
é adaptação, e está feita. Cada item abaixo foi verificado no spec, não inferido.

Itens marcados **⚠ confirmar em runtime** são os que a documentação não decide.
Não devem virar endpoint novo antes de um teste contra um device real.

---

## 0. Schemas reais — resolvidos pelo código-fonte

O `openapi.yaml` referencia os response models sem defini-los. Os nomes de campo
abaixo vêm do fonte, commit **`be8155c5`** (08/08/2026, "chore: update whatsmeow
to latest"), e são a base de qualquer mapeamento futuro.

| Endpoint | Envelope | Campos | Origem |
|---|---|---|---|
| `GET /chats` | `{data[], pagination{limit,offset,total}}` | `ChatInfo`: `jid`, `name`, `last_message_time`, `ephemeral_expiration`, `created_at`, `updated_at`, `archived` | `domains/chat/chat.go` |
| `GET /chat/:jid/messages` | `{data[], pagination, chat_info}` | `MessageInfo`: `id`, `chat_jid`, `sender_jid`, `sender_display_name`, `content`, `timestamp`, `is_from_me`, `media_type`, `reactions?`, `call_metadata?`, `filename`, `url`, `file_length`, `created_at`, `updated_at` | `domains/chat/chat.go` |
| `GET /user/my/contacts` | `{data[]}` | **só** `jid` e `name` | `domains/user/account.go` |
| `GET /user/avatar` | objeto | `url`, `id`, `type` | `domains/user/account.go` |
| `GET /user/check` | objeto | `is_on_whatsapp` | `domains/user/account.go` |
| `GET /group/participants` | objeto | `group_id`, `name`, `participants[]` | `domains/group/group.go` |
| — participante | | `jid`, `phone_number`, `lid?`, `display_name?`, `is_admin`, `is_super_admin` | `domains/group/group.go` |

Dois pontos que mudam decisões:

- **`GroupParticipant` traz `phone_number` e `lid` separados.** É exatamente a
  evidência confiável que o sistema de identidade precisa para registrar alias
  sem nunca derivar telefone de dígitos de LID.
- **`MyListContactsResponse` só tem `jid` e `name`** — sem telefone, sem avatar,
  sem push name. A sincronização de contatos pelo GOWA é bem mais pobre que a da
  WAHA, e o avatar exige uma chamada por contato a `/user/avatar`.

## 1. ~~Envio para grupo~~ — **RESOLVIDO, não era ausência**

Verificado no fonte, não no OpenAPI. `utils.ParseJID` aceita qualquer JID com
`@`; `utils.ValidateJidWithLogin` — o validador que todo handler `/send/*`
chama — só chega à checagem de conta para `@s.whatsapp.net`; e
`utils.IsOnWhatsapp` encerra com *"For non-user JIDs (groups, newsletters), skip
validation"* devolvendo `true`. Um `@g.us` passa intacto.
(`pkg/utils/whatsapp.go`, commit `be8155c5`.)

**Implementado no ChatPro**, com envio do JID inteiro para grupo e LID, e dígitos
para `@c.us`. Status: `IMPLEMENTED_NOT_RUNTIME_VALIDATED`.

Fica como lição de método: ausência de exemplo no OpenAPI não é prova de
incapacidade — foi preciso ler o fonte para descobrir que o bloqueador que eu
havia classificado como o mais grave não existia.

## 1b. Envio para grupo — histórico da investigação

- **Funcionalidade:** mandar mensagem numa conversa de grupo.
- **Por que o ChatPro precisa:** a Inbox tem conversas de grupo em produção (29
  grupos, mensagens de grupo persistidas). Um atendente que não pode responder
  num grupo perde a conversa inteira, não um recurso acessório.
- **WAHA equivalente:** todos os `/api/send*` aceitam `chatId` com `@g.us`.
- **GOWA:** o campo `phone` dos `/send/*` é documentado como *"Phone number with
  country code"* e **todos os exemplos do spec são `@s.whatsapp.net`**. Nenhum
  exemplo ou descrição menciona `@g.us`. Os endpoints de grupo existem, mas são
  de administração (`/group/info`, `/group/participants`, …) — nenhum envia
  mensagem.
- **Protocolo:** whatsmeow envia por `types.JID`; um JID de grupo é um destino
  válido na camada de baixo. A ausência é da API HTTP, não do protocolo.
- **Proposta:** aceitar JID de grupo no `phone` dos `/send/*` já existentes, em
  vez de criar endpoint novo.
  - **Método/rota:** sem mudança — `POST /send/message`, `/send/image`, etc.
  - **Request:** `phone` passa a aceitar `<id>@g.us`.
  - **Response:** `SendResponse` inalterado.
  - **Eventos:** nenhum novo.
- **Dificuldade:** baixa (provavelmente só validação de entrada).
- **Risco:** baixo no código; **alto no produto** enquanto não existir.
- ⚠ **confirmar em runtime — NÃO TESTADO.** Não há instância GOWA neste
  ambiente (só o container `chatpro-waha`; a porta 3000 é a API do ChatPro).
  Ausência de exemplo no OpenAPI **não é prova de incapacidade**: é bem
  possível que o `phone` já aceite `@g.us` e não haja trabalho nenhum a fazer.

  **Comando exato para decidir**, com um GOWA no ar e um grupo de teste:

  ```bash
  curl -sS -X POST "$GOWA_BASE_URL/send/message" -H 'content-type: application/json' -H "X-Device-Id: $GOWA_DEVICE_ID" -d '{"phone":"120363XXXXXXXXXXXX@g.us","message":"teste chatpro"}'
  ```

  - **200 + `message_id`** → a capacidade existe. Remover este item, tirar o
    `directPhone` do caminho de grupo em `gowa-provider.ts` e adicionar teste.
  - **4xx** → capacidade ausente de fato. Guardar o corpo do erro aqui e seguir
    para a proposta acima.

## 2. Título em mensagem de localização

- **Funcionalidade:** rótulo junto das coordenadas.
- **Por que o ChatPro precisa:** `sendLocation` aceita `title` opcional e a
  Inbox o exibe.
- **WAHA equivalente:** `POST /api/sendLocation` com `title`.
- **GOWA:** `POST /send/location` recebe apenas `phone`, `latitude`,
  `longitude`, `is_forwarded`, `duration`. Não há campo de título.
- **Protocolo:** `LocationMessage` do WhatsApp tem `name` e `address`; a
  capacidade existe abaixo da API.
- **Proposta:** adicionar `name` (e opcionalmente `address`) ao request.
  - **Método/rota:** `POST /send/location`.
  - **Request:** `+ name: string (opcional)`.
  - **Response:** inalterada.
- **Dificuldade:** baixa.
- **Risco:** baixo.
- **Estado no ChatPro:** o `GowaProvider` **recusa** localização com título
  (`NOT_IMPLEMENTED`) em vez de descartá-lo. Perda silenciosa seria pior.

## 3. Cartão de contato com mais de um contato

- **Funcionalidade:** um vCard com N contatos numa única mensagem.
- **Por que o ChatPro precisa:** `sendVcard` recebe um array e persiste **uma**
  linha de saída. Com um contato por mensagem, N cartões viram N mensagens e a
  persistência passa a descrever só parte do que foi enviado.
- **WAHA equivalente:** `POST /api/sendContactVcard` com `contacts[]`.
- **GOWA:** `POST /send/contact` recebe `contact_name` e `contact_phone` —
  escalares. Um contato por chamada.
- **Protocolo:** `ContactsArrayMessage` existe no WhatsApp.
- **Proposta:** aceitar array.
  - **Request:** `contacts: [{ name, phone }]`, mantendo os campos atuais para
    compatibilidade.
- **Dificuldade:** baixa.
- **Risco:** baixo.
- **Estado no ChatPro:** recusa `contacts.length !== 1` com `NOT_IMPLEMENTED`.

## 4. Enumeração histórica de LID

- **Funcionalidade:** paginar o mapa LID ↔ telefone de toda a conta.
- **Por que o ChatPro precisa:** `lidsPage` alimenta a reconciliação de aliases
  e a cura de contatos históricos.
- **WAHA equivalente:** `GET /api/{session}/lids`.
- **GOWA:** não existe endpoint de listagem de LID.
- **Proposta:** **não criar ainda.** O webhook do GOWA entrega `from_lid` em
  cada evento, ao lado de `from` — que é justamente o que a WAHA *não* dá e o
  que obrigou a existir uma varredura em lote. Se a cobertura por evento for
  suficiente, o endpoint é desnecessário.
- **Dificuldade:** média, se vier a ser preciso.
- **Risco:** médio — decidir cedo demais custa um endpoint que não se usa.
- ⚠ **confirmar em runtime:** medir a cobertura de `from_lid` em tráfego real
  antes de propor qualquer coisa. Só o LID **histórico**, de conversa que não
  recebe mensagem nova, justificaria a varredura.

## 5. Chamadas — iniciar, atender, transportar áudio

- **Funcionalidade:** chamada outbound, aceitar chamada inbound, mídia de voz.
- **Por que o ChatPro precisa:** não precisa hoje. Ligações estão em "em
  evolução" no `product-state.md` e o adiamento está registrado em
  `wacalls-avaliacao-adiada.md`.
- **WAHA equivalente:** **também não existe.** Não é regressão da migração.
- **GOWA:** só `POST /call/reject` e o evento `call.offer`.
- **Proposta:** nenhuma neste ciclo. Registrar e reavaliar quando ligações
  entrarem no roadmap.
- **Dificuldade:** alta (mídia em tempo real, fora do modelo HTTP atual).
- **Risco:** baixo enquanto não for produto.

---

## Não são ausências — ficam registradas para não voltarem à lista

| Item | Por que não entra |
|---|---|
| `message.ack` sem persistência | Existe no GOWA; falta o ChatPro persistir. Trabalho nosso. |
| Mídia como `path` local | Existe `url` e `GET /message/:id/download`. Contrato diferente, não ausência. |
| `call_log` como mensagem | O GOWA emite `call.offer`. É adaptação de normalizador, não endpoint faltante. |
| `/api/sessions` → `/devices` | Renomeação. Já adaptado. |
| Editar, apagar, encaminhar, responder, sticker, enquete, presença | O GOWA **tem** e a WAHA não era usada para isso. Ganho, não lacuna. |
| Administração de grupo | O GOWA tem 19 endpoints; o ChatPro não usava nenhum. Ganho. |

## Forma de `/group/info` e `/group/participants`

⚠ **confirmar em runtime.** Os endpoints existem, mas o `openapi.yaml` descreve
as respostas apenas como `GroupInfoResponse` e `GroupParticipantsResponse`, sem
os nomes de campo. O `GowaProvider` **não declara** a capability `groups` por
isso: declarar sem conhecer a forma seria exatamente o tipo de suposição que a
regra crítica 7 do `CLAUDE.md` proíbe. O client já tem os métodos; falta um
retorno real para mapear.
