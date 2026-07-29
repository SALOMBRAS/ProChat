# Envio de cartão de contato (vCard) no Inbox

Segundo consumidor de `message.sendContent`, na variante `vcard` já declarada
pelo contrato. Ver `docs/transporte-interno-conteudo.md` e
`docs/inbox-localizacao.md`.

## Caminho

```text
composer → POST /api/v1/inbox/conversations/:id/vcard  { contactIds: [uuid] }
  → InboxController.sendVcard → InboxContactService.cards (resolve na base, escopo do workspace)
  → InternalInboxService.sendVcard → deliver()
  → message.sendContent (content.kind = 'vcard')
  → WahaProvider.sendContent → WahaHttpClient.sendContactVcard → POST /api/sendContactVcard
```

O cliente manda **ids**, não campos: quem resolve o contato é o servidor, contra a
base e dentro do workspace. Assim a UI não consegue inventar um cartão.

## Decisões

### Campos: nome e telefone obrigatórios, empresa opcional, e-mail de fora

O contato estruturado da WAHA tem exatamente quatro campos — `fullName`,
`organization`, `phoneNumber`, `whatsappId`. **Não há campo de e-mail.**

| coluna em `contacts` | vai para |
| --- | --- |
| `displayName` | `fullName` (obrigatório) |
| `phoneNumber` | `phoneNumber` (obrigatório) |
| `company` | `organization` (omitido quando vazio) |
| `email` | **não é enviado** |

Nome e telefone são obrigatórios porque um cartão sem qualquer um dos dois chega
como entrada vazia do outro lado; o pedido é recusado com 422 antes de sair.

O e-mail poderia ser contrabandeado montando à mão uma string vCard com `EMAIL:`.
A documentação da WAHA mostra a forma `{ vcard: "…" }` como alternativa, mas
**não demonstra** o tratamento de `EMAIL` — seria depender de comportamento não
verificado. Um campo silenciosamente descartado ou deformado é pior que uma
ausência declarada, então o e-mail fica de fora e isso está fixado por teste. A
variante `{ vcard }` continua no contrato para quando houver evidência.

### Vários contatos por mensagem: sim

A documentação confirma que `contacts` aceita mais de um item, e permite misturar
as duas formas no mesmo array. O contrato já aceitava 1..20 e a rota expõe isso;
o `body` vira `"Ada Lovelace e mais 2"` quando há mais de um.

### Armazenamento: `message_type = 'contact'` — e aqui divergimos de propósito

A localização gravou `'location'`, igual ao `kind` do contrato. O cartão **não**
grava `'vcard'`: grava `'contact'`.

`vcard` é o nome do endpoint da WAHA; `contact` é a palavra que este código já
falava — `messagePreview` respondia `Contato` para `'contact'` antes de qualquer
coisa disto existir. Gravar `'vcard'` criaria um segundo vocabulário para a mesma
ideia e deixaria a prévia da conversa caindo no ramo genérico. O contrato mantém
`kind: 'vcard'` porque é o vocabulário do provedor.

O resto segue a localização: `message_type` é texto livre sem CHECK nos dois
bancos, o corpo guarda o resumo legível e os contatos vão em `payload_json`, que o
leitor já entrega como `metadata`. **Sem migration, sem coluna e sem contrato
novo.**

### Renderização

**Enviado:** lista com nome, empresa quando houver e o telefone como link `tel:`,
montada a partir de `metadata.contacts` — que é exatamente o que este código
gravou.

**Recebido: não identificado.** Não existe nenhuma mensagem de contato na base
(a distribuição de `message_type` tem apenas text, document, image, audio e
video), então a forma que a WAHA entrega num cartão recebido não pôde ser
verificada. O renderizador é defensivo: sem `metadata.contacts`, mostra o corpo
ou `Contato`. Inventar o parse de um payload não observado seria adivinhação.

### Paridade SQLite × Supabase

Igual à localização: as duas implementações de `recordOutbound` compartilham
`outboundRecord` e a mesma normalização, então tipo e payload chegam idênticos. O
teste roda contra o SQLite real.

## O defeito da localização, verificado aqui também

`recordOutbound` devolvia `messageType` e `metadata` fixos, e a correção veio na
PR de localização. O teste de cartão repete a verificação **das duas metades** —
a linha do banco **e** o valor retornado — porque é a assimetria entre elas que
escondeu o problema da primeira vez.

## UI

Uma entrada `Contato` no menu `+`: pede um termo, busca com
`domain.contacts({ search })` — que já filtra no banco — e envia. Com mais de um
resultado, pede o número da linha. Cru de propósito; refinamento visual não é
desta etapa. Não foi tocado `styles.css` nem a lista de conversas.

## Estado

`location` e `vcard` implementadas. `poll` segue declarada e respondendo
`NOT_IMPLEMENTED` com o `kind` nos detalhes — o envio é barato, o voto é o que
está dimensionado em `docs/waha-capacidades-anexos.md`.
