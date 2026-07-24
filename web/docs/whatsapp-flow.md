# Fluxo WhatsApp e identidade

```text
WhatsApp
  -> WAHA (ou provider Baileys)
  -> POST /api/v1/webhooks/waha
  -> normalização de identificadores
  -> resolução de contato/aliases
  -> persistência de conversa e mensagem
  -> eventos realtime
  -> Inbox e painel operacional
```

O webhook é tratado por `WahaWebhookController` e pelos stores em
`waha-webhook.service.ts`. A normalização de conversa usa `chatId` como
autoridade; participantes, `from`, `to` e `remoteJid` não podem criar uma
conversa errada. Mensagens de grupo e eventos técnicos possuem regras próprias.

`contact-identity-resolver.service.ts` preserva aliases em
`contact_identifiers`, resolve LID para telefone quando há evidência e mantém
pendências quando ainda não existe telefone seguro. Todo vínculo é por
workspace.

Não altere esta sequência sem testes de identidade, webhook, persistência e
realtime. Não exponha identificadores de transporte na UI. A apresentação deve
preferir nome WhatsApp, nome ChatPro, telefone normalizado e fallback seguro.

Mídia recebida pode passar pela persistência/proxy de mídia. Anexos enviados
usam outbox idempotente; confirmação de provider não deve ser simulada.
