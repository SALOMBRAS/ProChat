# Opção C: subir o ChatPro em rede fechada

Procedimento e artefatos da opção C do `deploy-avaliacao.md`: um host, tudo em
`docker compose`, **sem exposição pública**. Escrito em 03/08/2026.

**Nada foi implantado.** Os arquivos foram escritos e validados localmente com
`docker compose config`; nenhuma imagem foi construída e nenhum serviço subiu.

---

## 1. O Baileys continua bloqueado — o container fica

Testado hoje, em worker isolado (porta 3199, `CHATPRO_DATA_DIR` numa cópia
descartável, sem tocar a pilha em execução):

```
"errorCode": "BAILEYS_405", "reason": "Connection Failure", "phase": "connect"
  at WebSocketClient … @itsukichan/baileys/lib/Socket/socket.js:813
```

O `405` é `PAIRING_REJECTED_REASON` em `whatsapp-session-manager.ts:21`. Ele
aparece no `session.connect`, antes de qualquer QR — não é falha de leitura de
código, é recusa do outro lado.

**Consequência:** `WHATSAPP_PROVIDER=waha` é o alvo, o container entra no
desenho, e o volume da sessão WhatsApp é requisito, não detalhe. Se um dia o
Baileys voltar, o container sai e um dos dois volumes some junto.

---

## 2. Artefatos

| arquivo | o que é |
|---|---|
| `deploy/docker-compose.prod.yml` | os quatro serviços, rede interna, volumes nomeados |
| `deploy/Dockerfile.api` | build TS + processo persistente |
| `deploy/Dockerfile.worker` | idem, com `/data` para o estado de sessão |
| `deploy/Dockerfile.dashboard` | build Vite + nginx servindo estático |
| `deploy/nginx.conf` | serve o dashboard e encaminha `/api` e `/ws` |
| `deploy/.env.prod.example` | modelo das variáveis; o real fica fora do git |

### O que o compose resolve, conferido

```
WHATSAPP_HOOK_URL:    http://api:3000/api/v1/webhooks/waha
WORKER_TRANSPORT_URL: http://worker:3101/internal/transport
WAHA_BASE_URL:        http://waha:3000
volumes:              worker-data → /data      waha-sessions → /app/.sessions
publicado no host:    127.0.0.1:8080 → dashboard   (e mais nada)
```

**Só o dashboard é publicado**, e por padrão apenas em `127.0.0.1`. API, worker e
WAHA ficam em `expose`, alcançáveis só de dentro da rede do compose.

---

## 3. As decisões que o desenho toma

**O webhook vai pela rede interna.** `host.docker.internal` era do arranjo local.
Aqui é `http://api:3000/...` — não sai do host e continua assinado por HMAC. Se
a URL apontar errado, a ingestão morre **em silêncio**: a WAHA só registra a
falha do lado dela.

**Os dois estados de sessão viram volumes nomeados.** `waha-sessions` guarda a
credencial WhatsApp; perdê-la custa um QR novo. `worker-data` guarda
`waha-sessions.json`, a **única fonte dos `aliases`** — perdê-la repete em
silêncio o incidente de 31/07, em que 499 conversas vivas foram tratadas como
mortas.

**`WHATSAPP_FILES_LIFETIME` sobe para 3600.** O padrão da WAHA é 180 s, e foi ele
que apagou a mídia dos eventos descartados. Uma hora dá folga para a persistência
tentar de novo. É configurável no `.env.prod`.

**O nginx desliga `proxy_buffering` em `/api/`** porque a mídia é transmitida em
stream a partir da WAHA, e mantém `proxy_read_timeout 3600s` em `/ws` porque o
realtime fica ocioso entre eventos — com o padrão de 60 s a conexão cairia a cada
minuto de silêncio.

**`client_max_body_size 50m`** casa com o teto do multer na API. Menor recusaria
antes, com erro do nginx em vez do erro tratado da aplicação.

---

## 4. CORS

`app.ts` deixou de ter a lista literal. Agora vem de `CORS_ALLOWED_ORIGINS`,
separada por vírgula, com **o padrão de desenvolvimento preservado**:
`http://127.0.0.1:5173,http://localhost:5173`. Quem não configura nada continua
com o Vite funcionando como antes.

O padrão vive em `defaultCorsAllowedOrigins`, exportado de `config.ts`, e é usado
tanto por `loadConfig` quanto pelo fallback de `createApp` — para que o padrão de
quem não configura e o de quem monta a config à mão sejam o mesmo.

Com o nginx encaminhando `/api` e `/ws`, o navegador vê **uma origem só**, e o
CORS deixa de ser o caminho crítico. A variável continua existindo para o caso de
o dashboard ser servido de outro domínio.

---

## 5. Segredos: o mínimo viável, sem dependência nova

**Proposta: arquivo de ambiente com permissão restrita, lido pelo compose.**

```bash
cp deploy/.env.prod.example deploy/.env.prod
$EDITOR deploy/.env.prod
chmod 600 deploy/.env.prod
```

`deploy/.env.prod` foi acrescentado ao `.gitignore` (`web/.gitignore:17`) e
**nunca deve ser versionado**. O `.example` é o modelo, com as chaves vazias.

Por que isto e não um cofre:

- **Não traz dependência nova.** Vault, SOPS ou secret manager de nuvem são
  melhores e são outra peça para operar, com outro modo de falha. Para um host
  único, o ganho não paga o custo agora.
- **Docker secrets não ajuda aqui.** Sem Swarm, `secrets:` no compose vira
  bind mount de arquivo — a mesma proteção do `.env` com mais cerimônia, e ainda
  exigiria a aplicação ler de arquivo em vez de `process.env`.
- **O compose já lê `env_file`**, então não há código a mudar.

Regras que acompanham:

1. **Permissão `600`, dono do usuário que roda o compose.** O arquivo tem as
   quatro chaves que dão acesso total: `SUPABASE_SERVICE_ROLE_KEY`,
   `WAHA_API_KEY`, `WAHA_WEBHOOK_HMAC_KEY`, `MEDIA_PROXY_TOKEN_SECRET`.
   **`env_file` só para `api` e `worker`.** A WAHA é imagem de terceiro rodando
   Chromium e recebe as duas chaves dela por interpolação, nome por nome — o
   arquivo inteiro nunca entra naquele contêiner. Corrigido em 03/08/2026 depois
   de `docker inspect` mostrar `SUPABASE_SERVICE_ROLE_KEY` lá dentro; ver
   `vazamento-de-credenciais.md`.
2. **Fora de qualquer backup automático que saia do host** sem cifra.
3. **Rotação:** trocar `SUPABASE_SERVICE_ROLE_KEY` exige reiniciar `api` e
   `worker`. Trocar `MEDIA_PROXY_TOKEN_SECRET` invalida os links de mídia em
   trânsito — aceitável, mas convém saber antes.
4. **Quando houver mais de um host**, isto deixa de servir: aí a escolha passa a
   ser secret manager de verdade, e é hora de reavaliar.

**Não identificado:** se a WAHA aceita rotação de `WAHA_API_KEY` sem derrubar a
sessão.

---

## 6. Como subir (quando decidir)

```bash
cd web
cp deploy/.env.prod.example deploy/.env.prod && chmod 600 deploy/.env.prod
$EDITOR deploy/.env.prod

# 1. Conferir a resolução, sem construir nada:
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod config

# 2. Construir e subir:
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d --build

# 3. Parear a sessão: abra o dashboard em http://127.0.0.1:8080 e leia o QR.
```

### Conferência depois de subir

| o quê | como | esperado |
|---|---|---|
| API viva | `docker compose … ps` | `api` com healthcheck `healthy` |
| Webhook chega | enviar mensagem para o número e ver o log da `api` | `WAHA webhook accepted` |
| Realtime | abrir a Inbox e ver conversa atualizar sozinha | sem recarregar a página |
| Mídia | abrir uma imagem recebida | carrega |
| **Sessão sobrevive** | `docker compose … restart waha` | **não pede QR de novo** |

O último é o que mais importa e é o mais fácil de esquecer.

---

> **Estado em 03/08/2026:** a pilha foi construída e subiu localmente, em rede
> fechada. O que segue é o resultado, e substitui a expectativa das seções
> anteriores onde elas divergirem.
>
> ### O que quebrou no primeiro `up --build`, e como ficou
>
> | defeito | correção |
> |---|---|
> | **Sem `.dockerignore`** — contexto de 297 MB, e o `COPY . .` sobrescreveria o `npm ci` da imagem com `node_modules` do host (`better-sqlite3` compilado para outra plataforma) | `.dockerignore` criado |
> | **O `dist` não existe onde o `CMD` procurava.** `outDir: "dist"` está no `tsconfig.base.json`, então resolve para `web/dist`; o emitido é `dist/apps/api/src/server.js` | ver abaixo |
> | **`@chatpro/contracts` declara `"exports": "./src/index.ts"`** — TypeScript, que o `node` não executa. Compilar sem mudar esse contrato produz um `dist` que não resolve o pacote | as imagens passam a rodar por `tsx`, como o desenvolvimento |
> | **Typecheck dentro da imagem falhava**: `tsconfig` inclui `test/**`, e os testes da API importam do worker | gate removido da imagem — ele é do CI |
> | **`EACCES: mkdir /data`** — faltava volume para o SQLite da API | volume `api-data` acrescentado |
> | **Worker ciclava em `provider_creation`** por subir antes da WAHA | `depends_on: waha healthy` |
>
> ### O achado que mudou o desenho
>
> `InternalTransportServerOptions` tipa o host como o **literal `'127.0.0.1'`**, e
> `main.ts` o passa fixo. É proposital: o transporte interno do worker não tem
> autenticação. Mas entre contêineres a API não o alcançava —
> `Internal worker is unavailable`.
>
> A saída **não** foi permitir bind em `0.0.0.0`, que exporia uma API sem
> autenticação à rede do compose. O worker passou a compartilhar o namespace de
> rede da API (`network_mode: "service:api"`): `127.0.0.1:3101` é o mesmo dos
> dois, e ninguém mais o enxerga. Consequência declarada: o worker não tem nome
> DNS próprio nem `expose` — quem precisa dele é só a API, pelo loopback.
>
> ### Conferido
>
> | conferência | resultado |
> |---|---|
> | Dashboard em `127.0.0.1:8080` | **OK** — 200, `<title>ChatPro</title>` |
> | API pelo proxy do nginx | **OK** — `/api/v1/inbox/conversations` → 200 |
> | CORS | **OK** — origem configurada 200; origem estranha **403** |
> | Webhook pela rede interna | **OK** — POST assinado de dentro do contêiner da WAHA para `http://api:3000` → **202**, conversa criada, `messageInserted: true` |
> | Realtime pelo `/ws` | **OK** — `system.connected`, `conversation.sla.updated`, `message.received`, `conversation.updated` |
> | Nada além do loopback | **OK** — só `127.0.0.1:8080` publicado |
>
> ### Persistência dos volumes: provado sem pareamento
>
> Sentinela escrita em cada volume e um controle fora deles; `down` seguido de
> `up`, que **destrói e recria os contêineres**:
>
> | caminho | depois de recriar |
> |---|---|
> | `waha-sessions:/app/.sessions/PROVA.txt` | **sobreviveu** |
> | `worker-data:/data/PROVA.txt` | **sobreviveu** |
> | `/app/PROVA-LOCAL.txt` (fora de volume) | **perdido**, como esperado |
>
> Isso prova que o volume sobrevive à recriação do contêiner — que é o mecanismo
> em que a sessão se apoia. **Não prova** que a sessão WEBJS restaura a partir do
> volume: isso depende do formato interno da WAHA e só o pareamento real
> responde. As sentinelas foram removidas.
>
> ### Pendente, e por quê
>
> Três conferências **não foram executadas**: webhook com mensagem real, mídia, e
> `restart waha` sem pedir QR. Todas exigem sessão pareada, e **parear o número
> de produção com o compose foi recusado** — com razão:
>
> - são **4 slots** de dispositivo vinculado, o WAHA de produção usa um, e o
>   quinto vínculo derruba o mais antigo sem aviso;
> - **duas sessões no mesmo número** foi o que criou o problema dos aliases que
>   tratou 499 conversas vivas como mortas (ver
>   `sessao-inativa-validacao-investigacao.md`);
> - o compose usa SQLite próprio, mas o WhatsApp não sabe disso: as duas sessões
>   competiriam pelo mesmo número real.
>
> Ficam para **um número descartável** ou para o dia do deploy de verdade. Uma
> sessão chegou a ser criada e o QR gerado durante o teste; ambos foram
> encerrados e apagados sem escanear, então **nenhum slot foi consumido** —
> `GET /api/sessions` responde `[]` na API e na WAHA.
>
> ### Diferença em relação à pilha de desenvolvimento
>
> Só uma, e é a favor do compose: a pilha de desenvolvimento publica a API em
> `*:3000` — **todas as interfaces** —, enquanto o compose não publica nada além
> do dashboard em `127.0.0.1`. Nas rotas exercitadas, o comportamento é o mesmo.

## 7. O que este documento não resolve

- **Autenticação.** Continua não existindo: `x-workspace-id` vem cru do header
  (`middleware/context.ts:12`). É por isso que o padrão publica o dashboard só em
  `127.0.0.1`. **Não exponha a um IP público antes de resolver isso** — ver
  seção 4.3 do `deploy-avaliacao.md`.
- **Backup dos volumes.** Nenhuma rotina foi escrita. O Supabase guarda o
  essencial; os volumes guardam sessão e o mapa de aliases, e este último não se
  recria com QR.
- **TLS.** Em rede fechada por loopback não é necessário. Passa a ser no momento
  em que o dashboard sair do `127.0.0.1`.
- **Nada foi construído nem executado.** `docker compose config` valida sintaxe e
  resolução de variáveis, não que as imagens compilam. O primeiro `--build` é que
  vai dizer.
