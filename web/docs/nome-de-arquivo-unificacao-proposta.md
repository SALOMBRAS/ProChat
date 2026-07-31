# Unificação da fonte do nome de arquivo — proposta

**31/07/2026. Somente leitura.** Nenhuma migration foi criada ou aplicada, o banco
remoto não foi consultado nem escrito, e nenhum código de produção foi alterado
nesta análise. A medição de `media_filename` nulo em **1.252 de 1.260** documentos
foi feita antes, por PostgREST, e está citada como tal.

**Esta é uma proposta. Nada aqui foi implementado.** A `spec-envio-documento.md`
descreveu o defeito; este documento propõe a saída e pede aprovação para a única
parte que toca dados já gravados.

---

## 1. O defeito, em uma frase

Duas tabelas guardam o nome do mesmo arquivo, três lugares escrevem nele, e a
tela lê de um que ninguém garante que esteja preenchido.

```text
ENVIO                                    EXIBIÇÃO
inbox_outbox_jobs.filename               whatsapp_messages.media_filename
        ▲                                        ▲              ▲
        │                                        │              │
  o que o operador                    o eco do webhook    o job de mídia,
  escolheu, saneado                   (nulo em 99,4%)     que sobrescreve
  uma vez                                                 com outra sanitização
```

Consequência prática: **o contato pode receber o nome certo enquanto o operador
vê "Documento"** — e corrigir um lado não move o outro, porque não há
relação nenhuma entre as duas colunas hoje.

---

## 2. A chave de junção já existe

Esta é a descoberta que torna a unificação barata. As duas tabelas **já podem ser
casadas**, sem coluna nova:

| Tabela | Chave |
| --- | --- |
| `whatsapp_messages` | `PRIMARY KEY (workspace_id, waha_session, external_message_id)` |
| `inbox_outbox_jobs` | `external_message_id`, gravado no despacho com o id devolvido pelo provedor |

<sub>— `002_waha_webhook_store.sql:25` e `010_inbox_outbox_attachments.sql:14`,
nas duas árvores</sub>

O `confirm()` do outbox **já** faz essa junção hoje: ele encontra o job pelo
`externalMessageId` que o webhook de saída trouxe. Só não escreve nada do outro
lado.

---

## 3. Qual fonte é a verdade

**A resposta muda com a direção, e isso não é acordo — é a semântica real.**

| Direção | Fonte da verdade | Por quê |
| --- | --- | --- |
| **Saída** | `inbox_outbox_jobs.filename` | é o nome que o **operador** escolheu. O eco do provedor é um ida-e-volta do nosso próprio dado: só pode ser igual ou pior |
| **Entrada** | o payload do provedor | não existe job de saída; o único que sabe o nome é quem mandou |

**A coluna que a tela lê continua sendo `whatsapp_messages.media_filename`.** Não
proponho trocar o lado da leitura: ela já é lida pelo cartão de mídia, pela prévia
da conversa e pelo `content-disposition` do proxy de download, e mexer nisso
espalharia a mudança por três camadas sem ganho.

O que muda é **quem escreve**:

| Escritor | Hoje | Proposta |
| --- | --- | --- |
| Webhook de entrada | `media.filename ?? filename` | acrescentar `_data.filename` à precedência |
| Webhook de saída (eco) | mesma leitura, quase sempre nula | **passa a receber o nome do job**, casado por `external_message_id` |
| Job de persistência de mídia | **sobrescreve** com `safeFilename()` | **para de escrever nessa coluna** |

### Por que o job de persistência para de escrever

Ele hoje grava na coluna de exibição um nome de **armazenamento** — saneado para
virar chave de objeto. É a segunda função de sanitização do sistema, gêmea da do
envio, em outro arquivo, com fallback derivado do MIME (`image`, `video`, `audio`,
`attachment`). É por isso que a coluna pode ficar **não-nula e ainda assim
genérica**, e é contra isso que o dashboard mantém uma lista de rótulos a
descartar.

**Nada se perde ao parar.** O nome de armazenamento continua existindo: ele é o
último segmento de `media_storage_path`, que é gravado na mesma operação. Não é
preciso coluna nova para preservá-lo.

---

## 4. Exige migration?

**DDL: não.** Nenhuma coluna nova, nenhum tipo alterado, nenhum índice. As três
mudanças da §3 são código:

1. acrescentar `_data.filename` à precedência de `messageFrom()`;
2. remover `media_filename` do `UPDATE` de `persistMedia`;
3. no `confirm()` do outbox, gravar `filename` do job na mensagem correspondente.

O item 3 é o único que precisa de desenho novo: o serviço de outbox hoje não tem
como escrever em `whatsapp_messages`. Precisa de um método estreito no store de
mensagens (algo como `setMediaFilename(workspaceId, externalMessageId, name)`) —
**código, não esquema**.

**DML: sim, e é o que peço para aprovar.** Preencher as 1.252 linhas já gravadas
é `UPDATE` em dado de produção, o que a regra crítica nº 2 do `CLAUDE.md` proíbe
sem pedido explícito. O SQL está escrito, **não aplicado**, em
`web/docs/migrations-propostas-nome-de-arquivo.sql`.

### O que acontece com as linhas já gravadas

Três grupos, e só um precisa de decisão:

| Grupo | Quantas | O que acontece |
| --- | --- | --- |
| Documentos recebidos com `media_filename` nulo | **1.252** | ficam como estão até o backfill ser aprovado. O contorno do dashboard continua exibindo o nome, porque `payload_json._data.filename` está intacto no banco |
| Documentos recebidos já preenchidos | **8** | não são tocados. O backfill tem `WHERE media_filename IS NULL` |
| Mensagens de saída antigas | não identificado | **não podem ser recuperadas**: o job correspondente pode já ter sido varrido, e `inbox_outbox_jobs` não guarda histórico além da linha. O nome só passa a ser gravado nas mensagens novas |

O terceiro grupo é a perda aceita desta proposta, e vale declará-la: **a
unificação é para frente**. Uma mensagem de saída antiga cuja coluna ficou nula
continua nula.

---

## 5. O desacoplamento do caminho de objeto

A `spec-envio-documento.md` recomenda que o nome **deixe de ser** o último
segmento da chave do objeto, passando a `${workspaceId}/${conversationId}/${jobId}`.
A pergunta é o que acontece com o que já está armazenado.

**Resposta: nada.** O desacoplamento é forward-only, sem renomear nenhum objeto:

- `storage_object_path` é gravado **por linha**. Cada job continua apontando para
  o objeto que ele criou, no formato antigo. Nenhuma leitura reconstrói o caminho
  a partir do nome.
- O bucket de envio é **temporário**: o objeto é removido na confirmação, e a
  varredura horária limpa o que passou de 24 h. **Em um dia não resta nenhuma
  chave no formato antigo.**
- O bucket permanente (`chatpro-whatsapp-media`) usa `${workspace}/${checksum}/${filename}`
  e é assunto separado; ali também `media_storage_path` é por linha, então
  desacoplar lá também seria forward-only.

**O que se perde**, e é real ainda que pequeno: quem abrir o bucket pelo painel
deixa de reconhecer os arquivos pelo nome. Passa a depender de casar o `jobId` com
a linha. Para um bucket que se esvazia em 24 h, considero um preço baixo.

**O que se ganha:** some a única justificativa de segurança da sanitização. Sem o
nome na chave, a allowlist `[A-Za-z0-9._-]` deixa de ser necessária, e com ela
some a classe de defeito que apagava alfabeto não-latino. O nome pode ser
guardado como o operador o escreveu.

> **Ordem recomendada.** O desacoplamento **depois** da unificação, não junto.
> Enquanto houver três escritores na coluna de exibição, relaxar a sanitização só
> aumenta a variedade de nomes que o job de persistência vai sobrescrever.

---

## 6. O que peço que você decida

1. **Aprovar o backfill** de `web/docs/migrations-propostas-nome-de-arquivo.sql`,
   ou pedir ajuste no escopo dele (só documentos, ou toda mídia).
2. **Confirmar a fonte da verdade da §3** — em particular que o job de
   persistência de mídia pare de escrever na coluna de exibição.
3. **Decidir o desacoplamento da §5**, que é uma PR própria e posterior.

Nada disso está implementado. A #79 (extensão) e a #81 (`defParamCharset`)
corrigiram os defeitos que não dependiam desta decisão.

---

## Ressalvas

- **A PR do terminal 1 pode se sobrepor ao item 1 da §3.** A `spec-envio-documento.md`
  registrou que há trabalho em andamento para preencher as colunas. Se essa PR já
  acrescentar `_data.filename` à precedência, o item 1 desta proposta some e os
  itens 2 e 3 continuam de pé. Não identificado qual é o estado dela hoje.
- **Onde a WAHA de fato põe o nome** continua não identificado: não há no
  repositório nenhum payload cru de documento recebido, só fixtures escritas pela
  equipe. O backfill é escrito defensivamente, com `COALESCE` sobre as três chaves
  candidatas, justamente porque isso não está resolvido.
- **O total de linhas afetadas não foi verificado por mim.** O número 1.252/1.260
  vem da medição citada. O SQL proposto começa por um `SELECT` de conferência
  exatamente para que esse número seja confirmado antes de qualquer escrita.
