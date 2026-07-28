# Envio de localização no Inbox

Primeiro consumidor de `message.sendContent` — ver
`docs/transporte-interno-conteudo.md` para o contrato.

## Caminho

```text
composer → POST /api/v1/inbox/conversations/:id/location  { latitude, longitude, title? }
  → InboxController.sendLocation
  → InternalInboxService.sendLocation → deliver()
  → comando message.sendContent (content.kind = 'location')
  → WahaProvider.sendContent → WahaHttpClient.sendLocation → POST /api/sendLocation
  → recordOutbound → mesma normalização, automação e realtime de um texto
```

`send` (texto) e `sendLocation` compartilham `deliver()`: muda só o comando que
vai ao worker e o que é gravado. Entrega, persistência, Kanban, SLA e realtime
são exatamente os mesmos de antes.

## Decisões

**`message_type = 'location'`, sem migration.** A coluna é texto livre e **não
tem CHECK** em nenhum dos dois bancos, então o valor já era gravável.
`mediaType()` repassa qualquer `type` que não seja `text`, então basta declarar
o tipo no payload do registro de saída.

**Coordenadas em `payload_json`, não em coluna nova.** O leitor de mensagens já
entrega `payload_json` como `metadata` no contrato `InboxMessage`. As coordenadas
chegam à UI sem contrato novo, sem coluna e sem migration. Uma coluna
`latitude`/`longitude` só se pagaria se houvesse consulta por proximidade, que
não existe.

**`body` recebe o título, não as coordenadas.** O corpo é o texto que a Inbox
mostra na lista; um par de números ali seria ruído. Sem título, o corpo é `null`
— e a prévia da conversa já respondia `Localização` para esse tipo antes desta
mudança.

**Renderização: link, não preview.** Um mapa estático exigiria chave de API e um
terceiro no caminho. A mensagem vira um link `📍 título` (ou `lat, lng` quando não
há título) que abre o mapa em nova aba. É o mínimo que valida o fluxo; o
refinamento visual não é desta etapa.

**Paridade SQLite × Supabase.** As duas implementações de `recordOutbound` chamam
o mesmo `outboundRecord` e a mesma normalização, então o tipo e o payload chegam
iguais nos dois. O teste de persistência roda contra o SQLite real, que é o
provedor onde a forma pode ser verificada sem tocar em produção.

## Um campo que viajava e era descartado

`recordOutbound` devolvia `messageType: 'text'` e `metadata: {}` **fixos**, em
ambos os provedores, independentemente do que havia sido ingerido. A mensagem
gravada no banco ficava correta, mas a que voltava para a API — e daí para o
realtime e para a tela — vinha como texto.

Era o mesmo defeito do `timeoutMs`: o dado atravessa, é aceito e é jogado fora na
saída. O teste que pegou isso é o que compara **a linha do banco e o valor
retornado**; um teste que olhasse só um dos dois teria passado.

## UI

Duas entradas no menu `+` do composer:

- **Localização atual** — `navigator.geolocation.getCurrentPosition`, que o
  navegador libera em `127.0.0.1` sem HTTPS.
- **Informar coordenadas** — `window.prompt` aceitando `lat, lng`.

Ambas são deliberadamente cruas: servem para validar o caminho ponta a ponta. Não
foi tocado `styles.css` nem a lista de conversas.

## Estado das outras variantes

`vcard` e `poll` continuam declaradas no contrato e respondem `NOT_IMPLEMENTED`
com o `kind` nos detalhes. Para enquete, o envio é a parte barata; o voto exige o
que está dimensionado em `docs/waha-capacidades-anexos.md`.
