# Vazamento de credenciais por mensagem de WhatsApp — apuração e rotação

**03/08/2026.** Achado durante a investigação de um card do Kanban que exibia
variáveis de ambiente como se fosse mensagem. Não era falha de renderização: **é
conteúdo real de mensagem enviada pelo número da operação**.

**Nenhum valor de chave aparece neste documento.** Nada foi rotacionado, revogado
ou apagado por quem o escreveu.

---

## 1. O que vazou

Três mensagens **`outbound`** — saíram do WhatsApp da operação — contêm um
`.env.local` inteiro colado como texto.

| quando | destino | tipo | linhas |
|---|---|---|---|
| 2026-07-17 04:28 | `120363044166256490@g.us` | **grupo** | 24 |
| 2026-07-27 15:47 | `120363044166256490@g.us` | **grupo** | 24 |
| 2026-08-02 18:48 | `558591401345@c.us` | individual | 21 |

**Duas das três foram para um grupo**, então todo participante recebeu e a
mensagem está no aparelho de cada um. Para localizá-las:

```sql
select external_message_id, chat_id, direction, occurred_at
from whatsapp_messages where body ilike '%DATABASE_PROVIDER%';
```

As três carregam o mesmo conjunto de 16 variáveis, com **valores idênticos entre
si**. É o mesmo arquivo reenviado três vezes ao longo de duas semanas.

### As três chaves, comparadas com o ambiente de hoje

Comparação por `sha256`, sem imprimir valor nenhum:

| variável | vazou | é a que está em uso hoje? |
|---|---|---|
| `WAHA_API_KEY` | sim, 32 chars | **SIM — idêntica** |
| `WAHA_WEBHOOK_HMAC_KEY` | sim, 96 chars | **SIM — idêntica** |
| `SUPABASE_SERVICE_ROLE_KEY` | sim, 41 chars, formato `sb_secret_…` | **valor diferente** do atual — ver §2 |
| `SUPABASE_URL` | sim | idêntica (confirma que é este projeto) |
| `MEDIA_PROXY_TOKEN_SECRET` | **não** | a variável nem existia no arquivo vazado |

O `.env.local` vazado é um retrato antigo: tem 16 variáveis, e as três que
existem hoje e não estão lá (`MEDIA_PROXY_TOKEN_SECRET`, `WHATSAPP_OWN_NUMBERS`,
`API_HOST`) foram acrescentadas depois.

## 2. A chave do Supabase é o problema maior, e o status dela não foi verificado

O valor vazado de `SUPABASE_SERVICE_ROLE_KEY` **não é** o que está em uso hoje —
mas isso **não** quer dizer que esteja morto.

- O que está em `.env.local` hoje é a chave **legada**, um JWT de 219 caracteres
  (`eyJ…`).
- O que vazou é do formato **novo** de chave secreta do Supabase, `sb_secret_…`,
  de 41 caracteres.

Os dois formatos **coexistem** no mesmo projeto: adotar um não revoga o outro.
Uma `sb_secret_` tem o mesmo poder de uma service role — **leitura e escrita em
todas as tabelas, ignorando RLS**. É a mais perigosa das três, e a única que dá
acesso ao banco.

### Resolvido em 03/08/2026

Se essa chave ainda autenticava não chegou a ser verificado por aqui — a
tentativa (autenticar no PostgREST com o valor vazado) foi bloqueada pela
política da sessão, e não foi contornada. A pergunta perdeu o objeto: **o dono do
projeto revogou as duas chaves `sb_secret_` no painel do Supabase** — a vazada e
outra criada depois. A aplicação usa o JWT legado e seguiu respondendo 200.

Fica o registro de que os dois formatos coexistem, porque é o que tornou o achado
fácil de perder: a comparação com o `.env.local` em uso dizia "valor diferente",
e a leitura apressada disso é "chave antiga, já rotacionada".

## 3. O que cada chave permite

- **`SUPABASE_SERVICE_ROLE_KEY` (`sb_secret_`)** — banco inteiro, leitura e
  escrita, sem RLS. Todas as conversas, mensagens, contatos e mídia. Alcançável
  pela internet: o PostgREST do Supabase é público por definição, e a chave é a
  única barreira. **Nenhuma rede segura isto.**
- **`WAHA_API_KEY`** — credencial da API da WAHA. Lista sessões, lê chats e
  **envia mensagem pelo WhatsApp da operação**. Hoje a WAHA escuta em
  `127.0.0.1:3002` e não está publicada, então o alcance de rede é o freio — mas
  é o único. Conferido hoje: sem a chave, `/api/sessions` responde **401**; com
  chave errada, **401**; `/health` responde 200 sem chave, por
  `WHATSAPP_API_KEY_EXCLUDE_PATH: health`. A chave **é exigida de fato**.
- **`WAHA_WEBHOOK_HMAC_KEY`** — autentica o webhook. Com ela dá para **forjar
  eventos**: criar conversas, inserir mensagens que nunca existiram, mover cards
  por automação. Também depende de alcançar a API.

## 4. Rotação

Rotacionar é o que resolve. Apagar as mensagens não: elas já estão no aparelho de
quem recebeu, e o WhatsApp não desfaz isso de forma confiável.

### Ordem

1. ~~Revogar a `sb_secret_` no painel do Supabase.~~ **Feito em 03/08/2026** (§2).
2. **Trocar as duas chaves da WAHA** (abaixo). Pendente — as duas continuam
   vazadas e válidas.
3. Opcional, depois: migrar a aplicação para o formato novo de chave e aposentar
   o JWT legado. Isso é mudança de configuração com reinício, não emergência.

### Quem consome as chaves da WAHA

| arquivo | usa |
|---|---|
| `apps/api/src/config.ts:61` | as duas |
| `apps/worker/src/config.ts:54` | `WAHA_API_KEY` |
| `docker-compose.waha.yml:25` | `WAHA_WEBHOOK_HMAC_KEY` → `WHATSAPP_HOOK_HMAC_KEY` |
| `deploy/docker-compose.prod.yml:75` | idem |
| `scripts/waha-runtime.mjs:6` | `WAHA_API_KEY` (exige ≥ 32 caracteres) |
| `scripts/audit-conversation-integrity.ts:14` | `WAHA_API_KEY` |

A imagem da WAHA lê o nome `WAHA_API_KEY` diretamente — o compose declara
`WHATSAPP_API_KEY_EXCLUDE_PATH` mas nunca `WHATSAPP_API_KEY`, o que parece uma
falha e não é. Confirmado por `docker inspect chatpro-waha` e pelo 401 acima.
Até 03/08/2026 essa chave chegava ao contêiner pelo `env_file`, junto com o
arquivo inteiro; agora é linha declarada (§5).

### Procedimento

```bash
cd web

# 1. Gerar valores novos (não os imprima em canal nenhum).
openssl rand -hex 16    # WAHA_API_KEY          → 32 chars, o mínimo que o runtime exige
openssl rand -hex 48    # WAHA_WEBHOOK_HMAC_KEY → 96 chars, o mesmo tamanho de hoje

# 2. Trocar as duas linhas em .env.local.
$EDITOR .env.local

# 3. Recriar o contêiner da WAHA para ele reler o ambiente.
#    `docker compose restart` NÃO relê a configuração — tem de ser `up -d`.
#    O `--env-file` é obrigatório fora do `npm run dev:waha`; ver §5.
docker compose --env-file .env.local -f docker-compose.waha.yml up -d

# 4. Reiniciar API e worker.

# 5. Conferir a API da WAHA (a chave nova responde 200, a antiga 401).
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/api/sessions -H "X-Api-Key: …"
```

O passo 3 é o que mais gente erra. Sem `up -d`, a WAHA fica com a chave velha e o
webhook passa a falhar na verificação de HMAC — **em silêncio**, porque a recusa é
registrada do lado dela.

### O que conferir depois

| o quê | esperado |
|---|---|
| Sessão do WhatsApp | **não pede QR** — `./.waha-sessions` é bind mount de diretório do host (`docker-compose.waha.yml:27`) e sobrevive à recriação |
| Webhook | mande uma mensagem de teste e veja `WAHA webhook accepted` no log da API |
| Envio | responda pela Inbox e confirme entrega |

**Não identificado:** se a WAHA invalida a sessão ao trocar a `WAHA_API_KEY`. A
credencial da sessão vive em `.sessions` e a chave é só da API HTTP, então a
expectativa é que sobreviva — mas não foi testado. É por isso que a conferência
da sessão vem primeiro na tabela.

### Momento

A troca interrompe a ingestão pelo tempo de a WAHA subir de novo — dezenas de
segundos. **Enquanto a sincronização de histórico estiver correndo, não faça**:
uma recriação no meio já derrubou a corrida antes (`scripts/waha-runtime.mjs:8`).

## 5. Corrigido: o contêiner da WAHA recebia segredos que não usa

Os dois composes declaravam `env_file` com o arquivo de ambiente **inteiro**.
Conferido por `docker inspect chatpro-waha` antes da correção: o contêiner tinha
`SUPABASE_SERVICE_ROLE_KEY`, `MEDIA_PROXY_TOKEN_SECRET` e `SUPABASE_URL` no
ambiente — **e não usa nenhum dos três**. A WAHA é imagem de terceiro rodando
Chromium; dar a ela a chave-mestra do banco não tem contrapartida nenhuma.

O `env_file` saiu do serviço `waha` nos dois arquivos, e as duas chaves que ela
de fato usa passaram a ser declaradas nome por nome. Medido por
`docker compose config`, que resolve o `env_file` e mostra o ambiente efetivo:

| | antes | depois |
|---|---|---|
| desenvolvimento | 29 variáveis | **11** |
| produção | 28 variáveis | **12** |

`api` e `worker` **mantêm** o `env_file` — são os donos legítimos daqueles
segredos.

### O que muda para quem sobe o sistema

As duas chaves entram por **interpolação do compose**, não por dentro do
contêiner: `${VAR}` é resolvido pelo próprio compose a partir do ambiente de
quem o invoca. Isso não pede dividir o `.env.local` em dois arquivos.

- **`npm run dev:waha` (e `dev:waha:keep`) não muda em nada.** O script já roda
  com `node --env-file=.env.local`, e o `spawn` do `docker` herda o ambiente.
- **`docker compose` na mão, a partir de `web/`, passa a exigir `--env-file`:**

  ```bash
  docker compose --env-file .env.local -f docker-compose.waha.yml up -d
  ```

  Sem ele, `${WAHA_API_KEY}` não resolve. Antes isso passaria batido, porque o
  `env_file` entregava a chave por outro caminho.
- **Produção não muda:** a invocação documentada já passa
  `--env-file deploy/.env.prod`.

E as duas usam `${VAR:?mensagem}`, que **falha alto** quando a variável não está
definida. É o ganho que veio de brinde: antes, uma `WAHA_API_KEY` vazia no
arquivo de ambiente subia uma WAHA **sem exigir chave nenhuma** na API dela, sem
um aviso sequer. Agora o compose se recusa a subir.

## 6. O que fica em aberto

- **As duas chaves da WAHA continuam vazadas e válidas.** A troca espera a
  sincronização de histórico terminar, pelo procedimento da §4.
- **Nada foi apagado**, nem no banco nem no WhatsApp. Apagar do banco é escrita
  em produção e não remove das conversas de quem recebeu; o valor está na
  rotação, não em esconder a mensagem.
- **Se a `sb_secret_` chegou a ser usada por terceiro não foi verificado.** O
  painel do Supabase mostra data de último uso por chave; a consulta não foi
  feita antes da revogação.
- A varredura procurou por `body ilike '%DATABASE_PROVIDER%'`, que acha o
  despejo de um `.env`. **Não** acharia um segredo enviado sozinho, sem o nome da
  variável junto. Uma varredura por formato (`sb_secret_`, `eyJ…`, hexadecimal
  longo) é trabalho à parte e não foi feita.

## 7. Como isto não se repete

O corpo das duas primeiras mensagens tem três linhas de texto antes da primeira
atribuição; a terceira começa direto no `DATABASE_PROVIDER=`. É o retrato de
alguém colando um arquivo de configuração para pedir ajuda.

A defesa que cabe no produto é modesta, e fica **registrada como candidata, não
como decisão**: avisar no momento do **envio** quando a mensagem contiver padrão
de segredo — `sb_secret_`, `eyJ` seguido de JWT, ou `KEY`/`SECRET`/`TOKEN`/
`PASSWORD` seguidos de `=` e um valor longo. Não impede nada, mas troca um engano
silencioso por um aviso na hora.
