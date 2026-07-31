# Reprocessar os eventos descartados pelo webhook

Procedimento para recuperar mensagens que a WAHA entregou, o webhook recebeu e
descartou. Escrito em 31/07/2026, depois que a #73 corrigiu a causa dos
descartes de grupo. **A rotina não foi executada contra produção.**

## 1. O que se recupera, e o que não

O descarte não apagou nada: o evento bruto foi gravado em
`waha_webhook_events` antes da normalização, com o payload inteiro. O que não
aconteceu foi a materialização em `whatsapp_messages` e `conversations`.

Medido na base: 10.372 eventos descartados por `missing_chat_id`, 9.686 deles de
grupo. Por tipo: 4.888 `chat`, 4.831 `image`, 272 `video`, 214 `sticker`, 113
`ptt`.

**Texto e metadados voltam inteiros.** Corpo, autor, horário, tipo, nome de
arquivo, mime, tamanho e duração estão todos no payload guardado.

**Arquivo de mídia não volta.** A WAHA apaga o arquivo 180 segundos depois de
criá-lo, e as URLs guardadas não resolvem mais — dez amostras, de 10,6 dias a
2 h 48 de idade, todas 404. A mensagem entra como registro sem arquivo, com
`mediaPersistenceStatus = 'unavailable'`.

## 2. Como a rotina acha o que reprocessar

Não existe coluna dizendo "este evento foi recusado" — o descarte não deixa
rastro. A pergunta possível é pela ausência: evento de tipo `message` ou
`message.any` sem linha correspondente em `whatsapp_messages`, casando por
`externalEventId`. É uma anti-junção.

No SQLite ela é um `NOT EXISTS` em SQL. No Supabase o PostgREST não faz
anti-junção, então são duas chamadas por página: os eventos, e depois quais
daqueles ids já têm mensagem. Essa segunda consulta vai **em lotes de 100 ids**,
porque o filtro `in` é serializado na URL e o servidor corta em ~16 KB de
header: medido contra a base real, 600 ids deram 19.916 caracteres e a
requisição falhou.

A anti-junção também devolve eventos descartados por outros motivos — tipos
técnicos como `e2e_notification` e `notification_template`. A rotina tenta,
a normalização recusa de novo, e eles entram na contagem como `skipped`. É o
comportamento correto: quem decide o que é mensagem continua sendo o webhook.

## 3. Por que é seguro rodar

Três propriedades, e nenhuma foi inventada para esta rotina:

1. **Escrita idempotente.** A mensagem entra por `INSERT OR IGNORE` no SQLite e
   tolerando `23505` no Supabase; a conversa é upsert. Rodar duas vezes não
   duplica — e a segunda passada nem encontra o evento, porque a anti-junção já
   não o devolve.
2. **A conversa não é rebaixada.** `upsertConversation` só move `lastMessage`,
   `lastMessageAt` e `unreadCount` quando a mensagem que chega é mais nova que a
   que está lá. Um evento de dez dias atrás não sobrescreve o presente da
   conversa nem ressuscita contador de não lidas.
3. **Sem efeito colateral.** `reprocess` não dispara automação de Kanban nem
   relógio de SLA. Mover card por mensagem antiga e contar espera de dez dias
   como atraso de agora seriam os dois jeitos mais rápidos de estragar o estado
   atual para recuperar o histórico.

O caminho reusa a normalização e a persistência da ingestão: `ingest` e
`reprocess` chamam o mesmo `persistEvent`, que difere em dois interruptores —
gravar ou não o evento bruto, disparar ou não os efeitos. Não há segunda
implementação para divergir.

## 4. Como acionar

**Script, não endpoint.** O reparo é de uma vez só e percorre dezenas de
milhares de eventos, o que não cabe no ciclo de uma requisição HTTP e não tem
aqui nenhuma infraestrutura de job assíncrono para apoiá-lo — o outbox existente
é para envio. Ninguém precisa acioná-lo pelo dashboard, então expor um gravador
em massa na superfície de rede só acrescentaria risco. E ele precisa ser rodado
deliberadamente, por quem tem acesso ao banco, lendo a saída. Se um dia virar
endpoint, tem de ser `POST`: a rotina grava, e este repositório já tem o caso de
uma rota `GET` que grava sem querer, descrito em
`rotas-get-que-escrevem-investigacao.md`.

A partir de `web/apps/api`:

```bash
# 1. Contar sem gravar nada. Agrupa os pendentes por tipo.
npx tsx src/scripts/reprocess-discarded-events.ts --dry-run

# 2. Passada curta, para conferir o resultado antes de soltar o resto.
npx tsx src/scripts/reprocess-discarded-events.ts --max 200

# 3. Continuar de onde parou.
npx tsx src/scripts/reprocess-discarded-events.ts --after <externalEventId>

# 4. Tudo.
npx tsx src/scripts/reprocess-discarded-events.ts
```

Opções: `--workspace` (padrão: `WAHA_WEBHOOK_WORKSPACE_ID`), `--batch` (padrão
200, teto 500), `--max`, `--after`, `--dry-run`.

O provedor sai da configuração da API — `DATABASE_PROVIDER`, e
`CHATPRO_DATABASE_PATH` quando for SQLite.

## 5. Progresso e retomada

Cada lote emite uma linha `Discarded event reprocessing batch` com
`scanned`, `recovered`, `skipped`, `failed`, `mediaUnavailable` e `after`. Ao
final, `Discarded event reprocessing summary` traz o mesmo consolidado mais
`batches` e `done`.

`done: false` significa que o `--max` cortou a passada; a linha seguinte diz o
`--after` para retomar. Como a escrita é idempotente e a anti-junção não devolve
o que já foi recuperado, retomar do lugar errado — ou não passar `--after`
nenhum — é seguro: custa varredura, não duplicação.

Uma falha em um evento é contada, registrada com o id, e a varredura segue.
Dez mil eventos vindos de um provedor externo têm cauda, e parar no primeiro
esquisito faria o reparo depender de o histórico inteiro ser bem-comportado.

## 6. O que foi validado, e o que não

- **SQLite, ponta a ponta.** Base local semeada com as cinco formas reais
  (`chat`, `image`, `video`, `sticker`, `ptt`): dry-run, passada parcial com
  `--max 2`, retomada por `--after`, e terceira execução sem trabalho. Resultado
  final: uma conversa de grupo, cinco mensagens, quatro com mídia indisponível,
  o texto intocado, e os cinco eventos brutos ainda lá — nenhum reinserido.
- **Supabase, só a leitura.** `listDiscardedEvents` foi executado contra a base
  real em modo leitura, e foi ele que revelou o estouro de header do filtro
  `in`. `reprocess` **não** foi executado contra produção.
- **Espelho PostgreSQL: não feito.** Exercitar o caminho Supabase de escrita
  exigiria subir PostgREST além do Postgres, o que não foi montado. A paridade
  entre os provedores está garantida por construção — os dois passam pelo mesmo
  `persistEvent` — e por tipo, não por execução.

## 7. Antes de rodar em produção

- Rodar `--dry-run` primeiro e conferir o total contra os 10.372 medidos. Uma
  divergência grande é sinal de que a anti-junção está pegando mais do que se
  espera.
- Rodar com `--max` pequeno e olhar a Inbox: o grupo recuperado tem de aparecer
  com as mensagens na ordem certa e o autor correto, e a mídia tem de aparecer
  como indisponível, não como quebrada.
- **Não foi determinado** quanto tempo a passada inteira leva contra o Supabase.
  A medição de latência que existe é de leitura de configuração — ~155 ms por
  chamada —, e cada evento custa mais de uma chamada. Estimar sem medir seria
  chute; a passada com `--max` dá o número real antes de soltar o resto.
