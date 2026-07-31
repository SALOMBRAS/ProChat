# Caminho de anexo — pendências para decisão

**31/07/2026. Somente leitura.** Achados registrados durante a escrita da
`spec-envio-documento.md`. Nenhum deles foi corrigido: estão aqui porque a
correção exige uma decisão que não é minha. O banco remoto não foi consultado.

Cada item traz o que foi verificado, o que **não** foi, e as saídas possíveis.

---

## 1. O bucket recusa ZIP que a aplicação aceita

### O que foi verificado

A `policy` da aplicação aceita seis tipos para documento, incluindo duas grafias
de ZIP:

```ts
document: { mimes: ['application/pdf', 'application/zip', 'application/x-zip-compressed',
                    'text/plain', '…wordprocessingml.document', '…spreadsheetml.sheet'],
            max: 25 * 1024 * 1024 },
```

<sub>— `web/apps/api/src/services/attachment-outbox.service.ts:19`</sub>

O `allowed_mime_types` do bucket tem **treze** tipos e **nenhuma** das duas
grafias de ZIP:

```text
image/jpeg, image/png, image/webp,
audio/ogg, audio/mpeg, audio/mp4, audio/webm,
video/mp4, video/webm,
application/pdf, text/plain,
…wordprocessingml.document, …spreadsheetml.sheet
```

<sub>— `web/supabase/migrations/011_inbox_outbox_attachments.sql:29`</sub>

### O que acontece com um `.zip`

Ele **passa nas três validações** da API — allowlist, tamanho e *magic bytes*
(`PK`) —, a linha do job é criada, e só então o upload falha. Todo erro do
Storage vira 503 opaco:

```ts
if (error) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Temporary attachment storage is unavailable');
```

e o job cai em `failed` com `Temporary upload failed`. **O operador recebe um erro
de indisponibilidade para um arquivo que o sistema disse aceitar.**

### Por que nenhum teste pega

O teste do outbox usa um armazenamento em memória (`MemoryStorage`), que aceita
qualquer coisa. Nenhum teste do repositório confronta a `policy` da aplicação com
o `allowed_mime_types` do bucket. **É a classe de defeito que só aparece contra o
armazenamento real.**

### O que NÃO foi verificado

Se o bucket **em produção** corresponde ao da migration. A migration usa
`ON CONFLICT DO UPDATE`, então deveria — mas só se ela foi aplicada. O repositório
tem registro de migrations ausentes no remoto
(`kanban-sla-remote-reconciliation.md`). **Não identificado.**

Também não testei que o Supabase Storage de fato recusa em runtime: a conclusão é
do `allowed_mime_types` declarado, não de uma tentativa.

### Saídas possíveis

| Saída | O que envolve | Observação |
| --- | --- | --- |
| **Acrescentar ZIP ao bucket** | migration alterando `allowed_mime_types` | precisa de autorização; é DDL sobre `storage.buckets` |
| **Remover ZIP da aplicação** | uma linha em `policy` | operador passa a receber 415 com a mensagem certa, em vez de 503 |
| **Derivar uma lista da outra** | a lista da aplicação vira a fonte e a migration a consome | elimina a classe inteira, mas é a mais cara |

Seja qual for, vale um teste que compare as duas listas e falhe quando
divergirem. Ele não precisa do Storage real: as duas fontes estão no repositório.

---

## 2. A documentação promete três tentativas que não existem

### O que foi verificado

```text
6. Simular indisponibilidade do WAHA e conferir no máximo três tentativas e erro
   sem dados sensíveis.
```

<sub>— `web/docs/inbox-attachment-sending.md:20`</sub>

**Não há retry algum no caminho de anexo.** O `claim` exige `status = 'pending'`
e nada devolve a linha para `pending`; falha é terminal. O próprio repositório
tem um teste que fixa isso, com o título dizendo o contrário da documentação:

```text
does not retry an attachment after an uncertain worker failure
```

<sub>— `web/apps/api/test/attachment-outbox.service.test.ts`</sub>

A ausência de retry é **decisão deliberada e correta**: reenviar um anexo sem
saber se o provedor aceitou o primeiro duplicaria a mensagem para o contato. O
comentário no código diz isso com todas as letras.

> Registro da minha própria imprecisão: a `spec-envio-documento.md` cita este
> item na **linha 16**. A linha correta é a **20**. O conteúdo citado está certo.

### O problema

A linha está num **roteiro de verificação** — instruções para alguém conferir em
homologação. Quem seguir o roteiro vai procurar um comportamento inexistente e
concluir que o sistema está quebrado, ou pior, vai "consertar" adicionando o
retry que foi deliberadamente deixado de fora.

### Saídas possíveis

| Saída | Observação |
| --- | --- |
| **Corrigir a linha** para dizer que a falha é terminal e por quê | é uma linha; a informação já existe no código e no teste |
| **Bloco datado** sobre o item, na convenção de `web/docs/` | preserva o histórico de que a promessa existiu |
| **Implementar o retry** | contraria a decisão registrada no código e o teste que a fixa. **Não recomendo** |

Deixei a linha como está porque corrigi-la nesta rodada seria decidir por você
qual das três saídas vale — e a terceira muda comportamento.

---

## Referências

- `web/docs/spec-envio-documento.md` — de onde os dois achados vieram
- `web/docs/nome-de-arquivo-unificacao-proposta.md` — o defeito estrutural, que é
  assunto separado
