# Contribuindo com o ChatPro

Este documento descreve o processo que o histórico deste repositório já pratica.
Nada aqui é processo novo: cada regra abaixo é acompanhada do commit ou do
arquivo que a estabeleceu. Onde a prática é recente ou ainda não universal, o
texto diz isso.

As regras de produto e de arquitetura estão no `CLAUDE.md` e não são repetidas
aqui — leia-o antes de qualquer alteração. Este arquivo cobre só o *como*
trabalhar: provar cobertura, fatiar PR, rodar teste, mexer em banco e escrever
documentação.

---

## 1. Prova de cobertura por reversão

É a prática mais distintiva do repositório. A ideia: um teste novo não vale como
cobertura porque existe e passa — vale quando se demonstra que ele **falha sem a
correção**.

### Como se faz

1. Implemente a correção e escreva o teste.
2. Reverta **uma** alteração de produção por vez — não o commit inteiro, cada
   mudança isoladamente.
3. Rode a suíte e anote qual teste quebra e com qual erro.
4. Restaure a alteração e repita para a próxima.
5. Registre o mapa no corpo do commit.

Reverter tudo de uma vez não serve: se duas correções se sobrepõem, um teste
pode quebrar por causa da outra e a cobertura fica superestimada. O cabeçalho
literal diz exatamente isso — *"each production change on its own"*.

### O formato

Última seção do corpo do commit, antes do trailer. Cabeçalho literal, seguido de
uma lista de hífens com duas colunas separadas por `->`, alinhadas por
espaçamento:

```
Coverage proven by reverting each production change on its own:
- positional INSERT restored -> 3 tests fail with the real column-count errors
- bare catch restored        -> 1 test fails, error is an AppError 409 reading
                                "Phone number already exists in this workspace"
```

<sub>— `998a871`, PR #32</sub>

```
Coverage proven by reverting each production change on its own:
- adoption in createContact removed        -> campaign exclusion test fails
- hash predicate in optOutStatus removed   -> never-adopted contact test fails
- adoption in the identity resolver removed-> inbound materialization test fails
- pepper guard replaced by a default       -> fail-explicit test fails
```

<sub>— `95e51bb`, PR #36</sub>

Convenções que os dois exemplos fixam:

- **Uma linha por alteração de produção**, não por arquivo nem por teste. A PR
  #32 mudou um arquivo com duas alterações distintas → duas linhas. A #36 mudou
  quatro pontos → quatro linhas.
- **A coluna 1 nomeia o que foi revertido** em termos do mecanismo
  (`positional INSERT restored`, `pepper guard replaced by a default`), não em
  termos do arquivo.
- **A coluna 2 é o efeito observado**, com contagem quando é mais de um teste
  (`3 tests fail`) e nomeando o teste pelo propósito (`campaign exclusion
  test`), não pelo título literal do `it()`.
- **A mensagem de erro entra verbatim, entre aspas**, quando ela é o ponto — foi
  o erro errado que escondeu o defeito da PR #32 por completo.
- O alinhamento do `->` é por coluna fixa dentro do bloco. Quando o rótulo é
  longo demais, o padding vira zero e a coluna manda sobre a estética.

### Teste-prova e guarda-de-regressão

São coisas diferentes e o corpo do commit as separa e conta:

> Ten tests. Six fail without the fix, including each of the three
> consequences separately; four are regression guards for the two payload
> formats and for the call_log decision still pending.

<sub>— `8db9f49`, PR #34</sub>

- **Teste-prova**: falha sem a correção. É o que conta como cobertura da
  mudança. Quando o defeito tem várias consequências, prove **cada uma
  separadamente** — a #34 provou as três (conversa fantasma, contador de não
  lidas, relógio de SLA) em testes distintos.
- **Guarda-de-regressão**: passa dos dois lados, de propósito. Não prova nada
  sobre esta correção; fixa uma decisão para que uma mudança futura não a
  desfaça em silêncio. Declare que ela é guarda, e do quê.

Um caso recorrente de guarda: fixar um **não-escopo**. Na PR #46, `unknown`
ficou deliberadamente fora do vocabulário técnico e *"a test pins that choice
down"* — o teste existe para que a decisão não seja revertida por engano.

### Duas formas, e quando usar cada uma

O bloco tabular acima aparece quando cada alteração de produção é revertível
isoladamente. Quando o commit mistura prova e guarda, ou o defeito é um só com
várias consequências, o histórico usa **prosa com contagem** (é o caso da #34,
que não tem o bloco). As duas são aceitas; o que não é aceito é afirmar
cobertura sem dizer como ela foi verificada.

Para investigação e documentação, a prova é outra: declare o método e a garantia
de não-escrita.

> Executed on PostgreSQL 16.14 in a throwaway container and on SQLite 3.53.2
> through the repository's real migration runner. The remote database was not
> touched.

<sub>— `79c9a79`, PR #42</sub>

### O que não conta como prova

- "Os testes passam." Passar não distingue teste que trava comportamento de
  teste que só executa código.
- Cobertura de linha. O CI mede e publica o número, e **não impõe limiar** —
  ele existe para acompanhar tendência, não para autorizar merge.
- Um teste escrito depois de ver o código passar, sem nunca ter sido visto
  falhando.

### Onde a anotação vive

No **corpo do commit**, não no arquivo de teste. Os testes não carregam
comentário de reversão hoje, e a convenção é essa. O que o teste carrega é um
título que **afirma comportamento observável e o contrasta com o errado**.

Esse contraste aparece de duas formas, e **as duas são aceitas**. A explícita,
com a conjunção:

```
propagates a database error that is not the phone constraint instead of
calling it a conflict

refuses to produce a hash without a pepper instead of falling back to a weak one
```

E a implícita, que em português usa vírgula-negativa ou
dois-pontos-justificativa:

```
colar formato não suportado explica o motivo, não falha calado

o dragover pede o drop: sem isso o navegador abre o arquivo numa aba

separa as conversas por divisória, não por card
```

> **Contado em 31/07/2026, sobre os 681 títulos dos três workspaces:** a forma
> explícita cobre **47**; a implícita, **187**. Ou seja, a conjunção é minoria
> dura — cerca de 7%. Quem tratar só a primeira como norma transforma ~93% dos
> títulos existentes em violação silenciosa, o que não é a prática deste
> repositório.
>
> **O que vale é o contraste, não a conjunção.** A forma é estilo, e segue o
> idioma do arquivo — que é decidido por arquivo, não por workspace. Ver
> `web/docs/testing.md` §7.3.

> **Estado:** a prática nasceu em 28/07/2026 e o bloco literal aparece em duas
> mudanças (PRs #32 e #36); a forma em prosa, na #34. Ainda não é universal em
> todos os commits. Este documento a torna a expectativa daqui em diante.

---

## 2. Uma PR por etapa lógica

### Fatiamento

Uma PR entrega **uma etapa lógica completa**, não um arquivo nem uma feature
inteira. A cadeia canônica é a do envio de conteúdo, quatro PRs:

| PR | Etapa |
| --- | --- |
| #49 | Contrato — o provider responde `NOT_IMPLEMENTED` com o kind nos detalhes |
| #51 | Primeiro consumidor — localização, com UI mínima para validar o caminho |
| #55 | Refinamento da #51 (empilhada sobre ela) |
| #53 | Segundo consumidor — vCard, *"nenhuma mudança em packages/contracts foi necessária, que era o objetivo do desenho"* |

Tamanho observado: 2 a 13 arquivos, 72–566 linhas para código. PRs de
documentação vão além (a #31 teve 1.532 inserções) e são entregável reconhecido
— pelo menos 8 PRs mergeadas são só documentação.

### Ordem de merge declarada

A ordem é declarada **em prosa, no corpo do commit** — não há palavra-chave de
ferramenta. Quatro formas em uso:

- **Referência ao que já está em main:**
  *"PR #38 had already removed the purple gradient slab, so the list arrives
  here with real separation and a legible badge."* (#47)
- **Posição na cadeia:**
  *"Primeiro consumidor de `message.sendContent`."* (#51) →
  *"Segundo consumidor de `message.sendContent`."* (#53)
- **Promessa da etapa seguinte:**
  *"a execução de localização vem na etapa seguinte."* (#49)
- **Dependência entre migrations:**
  *"M1 blocking, M2 soft delete + chatpro_delete_contact, M3 LGPD purge (needs
  M1+M2)."* (#31)

Quando a PR depende de um estado específico da main, ancore num SHA:
*"Revalidate ... against `origin/main` @ `98a984d`, now that the named INSERT
(998a871) and the opt-out adoption are merged."* (#42)

### PR empilhada

Quando a etapa seguinte não pode esperar o merge da anterior, abra a PR com
`--base` no branch da PR mãe. A mãe leva as duas para main no squash **quando a
filha já foi mergeada na branch da mãe antes**; se a mãe for para main primeiro,
o squash descola a pilha — é a subseção seguinte. Já aconteceu cinco vezes: #55
sobre #51, #36 sobre #32, #25 dentro de #24, e a pilha de dois níveis #62 sobre
#60 com #64 sobre #62.

Duas consequências reais, ambas já registradas em commit:

- O squash da mãe pode carregar mais do que se espera. Declare no corpo:
  *"Rebased onto main: the squash of #55 also carried #47 and #50, which reached
  main on their own. Only the refinement above remains here."*
- A PR filha pode chegar **vazia** em main se seu conteúdo já subiu pela mãe.
  Foi o que houve com a #25, e a #30 documentou o fato: *"4f351e1, cited as PR
  #25, is an empty commit — the one-line tick fix shipped inside adc67c6."*

### O squash descola a pilha

Em 29/07/2026 a #60 foi squash-merged em `main`. O squash não move o commit da
branch: ele **cria um commit novo** com o mesmo conteúdo. `a888f48` entrou em
main; `f314e0e`, o commit original da branch, tem o mesmo `patch-id` e nunca foi
ancestral de main.

Sobre aquela branch havia uma pilha de dois níveis — a #62 com base
`fix/inbox-colar-sem-editor` (branch da #60) e a #64 com base
`feat/inbox-tela-anexo` (branch da #62). Com a base descolada, o merge das duas,
1h22 depois, foi parar nas branches empilhadas e não em main: `5fed4e3` (#62)
tem pai `f314e0e`, e `c76a783` (#64) tem pai `8b48ec0`. Nenhum dos dois é
ancestral de `origin/main`; hoje, com as branches apagadas do origin, nenhum dos
dois é sequer alcançável por ref alguma.

**E o GitHub marcou as duas como merged.** É o que torna o caso perigoso: a
interface não distingue "mergeada em main" de "mergeada na branch que a
originou". Nada falha e nada avisa. Foram 30 minutos até a abertura da #66 —
1h53 contadas do squash da #60.

A recuperação foi a #66: `origin/main` com `8b48ec0` e `b76dd24` aplicados por
cherry-pick e **sem** `f314e0e`. Soltar o commit duplicado é o passo que não se
pode pular — o conteúdo dele já estava em main sob outro SHA, e mantê-lo faz o
cherry-pick conflitar com ele mesmo.

<sub>— `5dbba74`, PR #66</sub>

**Regra: PR que tenha outra empilhada sobre ela merge com `--no-ff`, nunca com
squash.** O merge commit preserva os commits da branch, então a base das filhas
continua válida. PR isolada pode squash normalmente.

Depois de mergear uma pilha, confira que o conteúdo chegou — o rótulo do GitHub
não serve, e **a ancestralidade também não** (próxima subseção). O que serve é
comparar o conteúdo, arquivo por arquivo:

```bash
git fetch origin
git show --pretty='' --name-only <sha-da-filha> | while read -r f; do
  [ "$(git rev-parse "<sha-da-filha>:$f")" = "$(git rev-parse "origin/main:$f")" ] \
    && echo "ok       $f" || echo "NÃO veio $f"
done
```

### Commit em branch de PR já mergeada

A #63 foi squash-merged em 29/07/2026 às 13:14:33 (`-03`; na API do GitHub,
`16:14:33Z`). O commit `2d77edb`, que corrigia uma atribuição errada no
`CLAUDE.md`, é de 13:17:19 — **166 segundos depois**, com pai `59358ea`,
exatamente o `head_sha` que a #63 tinha no instante do merge.

O `git push` funcionou e não avisou nada, porque a branch continua existindo:
`refs/heads/docs/navegador-conferencia-visual` ainda aponta para `2d77edb` no
origin. O commit não é dangling nem está perdido — é a ponta de uma ref viva, e
é por isso mesmo que passa despercebido: ele fica **fora de main** com tudo o
mais parecendo normal.

**Regra:** antes de commitar numa branch já enviada, confira o estado da PR
dela.

```bash
gh pr view <N> --json state
```

A reaplicação virou PR própria, a #69, com o mesmo `patch-id` (`6c286ed`)
aplicado sobre o topo de main.

### Como caçar um commit órfão — e o que não funciona

**`git merge-base --is-ancestor` não serve neste repositório.** Foi o que este
documento recomendava, e está errado: com squash-merge **nenhum** commit de
branch vira ancestral de main, então a checagem acusa quase tudo. Medido em
31/07/2026:

| | |
| --- | --- |
| branches remotas | 78 |
| acusadas de órfãs por `--is-ancestor` | **74** |
| órfãs reais | **2** |

Setenta e dois falsos positivos. Uma checagem que acusa 95% das branches não
informa nada.

O que discrimina são **duas** condições, nesta ordem — data primeiro, porque é
barata, conteúdo depois, porque é a que decide:

```bash
# PASSO 1 — commits empurrados DEPOIS do merge da própria PR
gh pr list --state merged --limit 100 --json number,headRefName,mergedAt \
  --jq '.[] | select(.mergedAt != null) | "\(.number)\t\(.headRefName)\t\(.mergedAt)"' |
while IFS=$'\t' read -r pr branch merged; do
  git rev-parse --verify -q "origin/$branch" >/dev/null 2>&1 || continue
  TZ=UTC git log "origin/$branch" --not origin/main \
      --date=format-local:'%Y-%m-%dT%H:%M:%SZ' --format='%H|%cd|%s' |
  while IFS='|' read -r sha when subject; do
    [[ "$when" > "$merged" ]] && echo "PR #$pr $branch ${sha:0:7} $when > $merged  $subject"
  done
done

# PASSO 2 — para cada candidato, o conteúdo chegou a main?
git show --pretty='' --name-only <sha> | while read -r f; do
  [ "$(git rev-parse "<sha>:$f")" = "$(git rev-parse "origin/main:$f")" ] \
    && echo "ok       $f" || echo "NÃO veio $f"
done
```

O passo 2 é obrigatório: o passo 1 sozinho ainda produz falso positivo quando o
conteúdo chegou por **outra** PR. Foi o caso do `2d77edb` — empurrado 166 s
depois do merge da #63, portanto candidato, mas re-landado pela #69, portanto
não órfão.

> **A armadilha de fuso, que custou duas varreduras vazias.**
> `git log --date=format:` formata no fuso **do commit**, não no `TZ` do
> ambiente. O mesmo commit, impresso das duas formas:
>
> ```text
> --date=format:%Y-%m-%dT%H:%M:%SZ        2026-07-29T13:17:19Z   ← hora local, carimbada como UTC
> --date=format-local:%Y-%m-%dT%H:%M:%SZ  2026-07-29T16:17:19Z   ← correto, com TZ=UTC
> ```
>
> Contra um `mergedAt` de `2026-07-29T16:14:33Z`, a primeira forma faz o commit
> parecer **anterior** ao merge. O sinal da comparação inverte e a varredura
> volta vazia — sem erro, sem aviso. Use `--date=format-local:` **com `TZ=UTC`**,
> ou compare por `%ct`, que é timestamp Unix e não tem fuso.

<sub>— varredura verificada na PR #85, e reproduzida aqui: 3 candidatos por data,
2 órfãos reais confirmados por conteúdo</sub>

### Trabalho paralelo por worktree

O desenvolvimento roda em várias worktrees do mesmo repositório ao mesmo tempo,
então **as PRs são mergeadas fora de ordem numérica** — isso é normal, não
sintoma de problema. Quem deixa um gancho para outro terminal declara isso no
corpo: *"o acionamento fica exposto em `api.sendAttachment(..., voiceNote)` para
o refinamento do terminal 2."* (#57)

Nunca rode `git checkout main` numa worktree: main está checada em outra. Para
começar uma branch:

```bash
git fetch origin && git checkout -b <tipo>/<slug-kebab> origin/main
```

### Branch, commit e merge

- **Branch:** `<tipo>/<slug-kebab>`, com o tipo igual ao do Conventional Commit
  (`feat/`, `fix/`, `docs/`, `chore/`, `perf/`). O slug começa pelo escopo
  quando ele existe (`feat/inbox-send-location`, `fix/sla-freeze-on-status-change`)
  e pode estar em português ou inglês. Uma branch por PR, nunca reutilizada.
- **Commit:** Conventional Commits. Tipos em uso: `feat`, `fix`, `docs`,
  `chore`, `refactor`, `perf`. Escopo é opcional e espelha o assunto, não a
  pasta (`inbox`, `sla`, `dashboard`, `contacts`, `api`, `supabase`, `media`,
  `waha`, `persistence`, `cleanup`...).
- **Idioma:** subject em inglês; corpo na língua da sessão. As duas coexistem no
  histórico.
- **Trailer:** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Merge:** squash-merge, desde a PR #15 — **exceto** PR com outra empilhada
  sobre ela, que vai de `--no-ff` pelo motivo descrito acima. Não faça merge da
  própria PR sem revisão.

### Anatomia do corpo do commit

Parágrafos em prosa de ~80 colunas, sem cabeçalhos de seção. A ordem recorrente:

1. **Defeito ou contexto**, com o mecanismo nomeado em código — arquivo, função,
   coluna. Não *"corrige bug no inbox"*, e sim *"messageFrom read only the root,
   so mediaType fell through to 'text'"*.
2. **Número medido** como âncora, não estimativa: *"~162 ms medidos"*, *"174
   such events had arrived live"*, *"pitch 85px -> 80px"*.
3. **O que mudou** e por que essa forma e não outra.
4. **A prova** (seção 1 deste documento).
5. **O não-escopo deliberado**, com a razão. Exemplos reais:
   *"Crop, text, emoji and blur are out of scope; each is its own work."* (#56);
   *"`in_progress -> waiting_customer` continua sem efeito no SLA de propósito:
   a espera só troca de lado quando sai uma mensagem, senão o seletor viraria
   uma forma de zerar o próprio prazo de primeira resposta sem responder."* (#33)
6. **Residual conhecido** ou próxima etapa.

Em PR de investigação, declare também o que **não** foi determinado. O
marcador é literal: *"está escrito «não identificado»"*.

---

## 3. Rodando os testes

### A regra

Todo comando de teste roda **a partir de `web/`**. O `package.json` da raiz do
repositório é do Electron legado em `build/`: não tem `scripts`, não declara
`workspaces` e não tem lockfile.

```bash
cd web
npm test                          # os 4 workspaces, em cadeia
npm run test -w @chatpro/api      # um só
npm run test:coverage             # com cobertura
```

Também funciona `npx vitest run` **de dentro do diretório do workspace**.

### A armadilha

`npx vitest run` a partir de `web/` **não** é equivalente. Ele encontra todos os
arquivos e roda com o root errado, quebrando 31 deles. O sintoma parece bug de
código; é bug de CWD.

| Onde | O que acontece |
| --- | --- |
| `npm test` na raiz do **repo** | `npm error Missing script: "test"` |
| `npm run test -w @chatpro/api` na raiz do **repo** | `npm error No workspaces found` |
| `npx vitest run` em `web/` ou na raiz | roda tudo, **31 arquivos falham** |
| `npx vitest run --root apps/api` em `web/` | **12 arquivos falham** — o CWD segue `web/` |
| `npx vitest run --root apps/dashboard` em `web/` | **passa** — 26 arquivos, 396 testes |
| `npx vitest` na raiz do **repo** | baixa `vitest@latest` da rede — outra major que a 3.2.7 fixada em `web/` |

As duas causas do run puro:

- **api (12 arquivos):** os testes montam o banco com
  `join(process.cwd(), 'migrations')`. Fora do CWD certo isso vira
  `web/migrations`, que não existe →
  `ENOENT: no such file or directory, scandir`. Pior,
  `eventos-sistema-cleanup-sql.test.ts` lê `join(process.cwd(), '..', '..',
  'docs', ...)` e o caminho **escapa do repositório** inteiro.
  O código de produção é imune — ele resolve por `import.meta.url`; são os
  testes que reintroduzem a dependência de CWD ao passar o caminho explícito.
- **dashboard (19 arquivos):** sem o `vite.config.ts` do workspace, o
  environment cai para `node` e o `setupFiles` não carrega →
  `ReferenceError: document is not defined`.

**Sobre o `--root`: ele não é a armadilha, e a versão anterior deste documento
errava aqui.** A bandeira faz o vitest anunciar `RUN v3.2.7 .../apps/api` e
**achar o config daquele workspace**, mas não muda o `process.cwd()` do
processo — ele continua sendo `web/`. Quem quebra é quem depende do CWD:

- `--root apps/api` falha em **12 arquivos e 69 testes**, todos com a mesma
  mensagem, `ENOENT ... scandir '<...>/web/migrations'`; nenhuma asserção de
  negócio quebra. São os mesmos 12 arquivos da api da lista acima.
- `--root apps/dashboard` **passa** — 26 arquivos, 396 testes, exit 0. Achar o
  `vite.config.ts` resolve o environment e o `setupFiles`, e **nenhum teste do
  dashboard lê caminho relativo ao CWD**.

Ou seja: a regra continua a mesma — rode do diretório do workspace, ou por
`npm run test -w @chatpro/api`, que dá 32 arquivos e 282 testes verdes. Muda só o
motivo. Não é a bandeira que é perigosa; é o teste que lê `process.cwd()`.

Um detalhe da contagem, para não assustar: com `--root apps/api` aparece uma
linha `FAIL` a mais do que os testes falhando. A sobra é
`eventos-sistema-cleanup-sql.test.ts`, que estoura o `ENOENT` no topo do módulo e
falha como *suite*, sem chegar a coletar seus 10 testes — daí o total cair de 282
para 272.

### Lendo a saída

- **`skipped` nunca é intencional.** Não existe nenhum `.skip` ou `.todo` no
  código. Todo teste marcado como skipped é sintoma de suíte abortada num hook —
  quase sempre ambiente ou CWD errado. `Inbox.test.tsx` é o caso clássico:
  9 testes aparecem como skipped quando o `beforeAll` falha.
- **Log de erro não é falha.** As suítes da api imprimem logger estruturado com
  `level: "error"` mesmo passando — são asserções de caminho de erro. Só valem o
  sumário `Test Files ... passed` e o exit code.
- A cadeia usa `&&`, então o primeiro workspace que falhar esconde o estado dos
  seguintes.

### Cobertura

`npm run test:coverage` mede os quatro workspaces. O relatório inclui os
arquivos **sem teste**, então o número é honesto. O CI publica a tabela no
resumo do job e **não impõe limiar**: a decisão foi medir primeiro e exigir
depois.

### Flakes conhecidos

Alguns testes esperam por relógio de parede em vez de fake timers
(`attachment-outbox.service`, `whatsapp-history-sync.service`, `waha-webhook`).
Em máquina carregada os limites podem estourar. Se um desses falhar isolado e
passar na repetição, é flake — não mude o código de produção por causa dele.

---

## 4. Banco de dados e migrations

### A regra

> Nunca crie migration, altere schema, aplique SQL remoto, faça push ou deploy
> sem solicitação explícita.

<sub>— `CLAUDE.md`, Regra crítica nº 2</sub>

> Não crie nem aplique migration sem autorização explícita. Não faça backfill,
> reset, truncate ou SQL remoto por inferência.

<sub>— `web/docs/database-overview.md`</sub>

Vale para as duas na íntegra: nenhuma DDL, nenhum backfill, nenhum reset e
nenhuma escrita no banco remoto sem pedido explícito. Ler é permitido; escrever,
não.

### As três árvores

Não são intercambiáveis:

| Diretório | O quê |
| --- | --- |
| `web/apps/api/migrations` | esquema **SQLite** local |
| `web/supabase/migrations` | esquema **Supabase** remoto |
| `supabase/migrations` (raiz) | histórico — não confundir com o de `web/` |

**Reconstruir o banco do zero não é suportado.** `contacts` está numa árvore e
`conversations` na outra, e 10 das 15 migrations da raiz falham sem a outra.
Aplique sempre no banco que já tem estado.

### SQL ainda não aprovado

Vai para `web/docs/migrations-propostas-<assunto>.sql`, **fora de
`migrations/` de propósito** — como diz o próprio arquivo, *"não é lido pelo
runner de migrations"*, então não há como aplicá-lo por acidente. O cabeçalho é
um marcador em caixa alta:

```sql
-- PROPOSTA — NÃO APLICAR
-- PROPOSTA — NÃO EXECUTADA em produção. Aguarda aprovação.
```

Valide a proposta em banco descartável (PostgreSQL em contêiner, SQLite pelo
runner real do repositório), nunca contra produção. É prática estabelecida
cobrir o SQL proposto com teste automatizado **antes** de ele ser aprovado — foi
o que as PRs #40 e #45 fizeram.

### Quando a aplicação for autorizada

O procedimento canônico está em `web/docs/migrations-m1-m2-aplicacao.md`. O
essencial:

1. **Backup primeiro.** *"Sem backup, não comece."*
2. **Confira o ponto de partida** — um `SELECT` em `information_schema` que deve
   voltar 0 linhas, provando que a migration ainda não foi aplicada.
3. **Aplique**, com o bloco de verificação que acompanha cada passo.
4. **Reinicie a API.** Não pule: a sondagem de capacidade de schema é cacheada
   por cliente, e sem restart o processo antigo continua achando que a migration
   não existe. O sintoma é **silencioso**, não é erro.
5. **Rode as suítes de verificação** (`migrations-m1-m2-verificacao.sql` e
   `.mjs`), que saem com código 0/1.
6. **Rollback** em **ordem inversa** (M2 antes de M1) e igualmente seguido de
   restart. Saiba o que ele não desfaz: `DROP COLUMN` descarta os dados.

### Antes de apagar em massa

Duas regras, escritas depois de um `DELETE` que custou **504 linhas** de
`conversation_kanban_state` em 31/07/2026.

**1. Confirme que a fonte da verdade é a mesma que o código usa em runtime.**

O `DELETE` daquele dia selecionava os cards cuja conversa está numa sessão
WhatsApp que a WAHA não lista, e foi aprovado conferindo
`GET {WAHA_BASE_URL}/api/sessions?all=true` — que devolvia exatamente uma
sessão. A conferência foi feita, no momento certo, e respondeu certo à pergunta
que lhe foi feita.

O problema é que **não era a fonte que o código consulta**. Quem decide se uma
conversa é alcançável é o worker, e ele responde `session.list` com
`{ wahaName, aliases: [...] }`: os `aliases` são nomes de pareamentos anteriores
que ele **ainda roteia** para a sessão no ar. A WAHA não os expõe porque não são
sessões dela — são um mapeamento do worker.

Resultado: 499 dos 504 cards apagados eram de conversas vivas e respondíveis. A
fonte estava **incompleta, não errada** — e é isso que a torna perigosa, porque
uma fonte errada se denuncia e uma incompleta concorda com você.

Na prática, antes de um `DELETE` que dependa de um critério externo:

- pergunte **qual função do código** decide esse critério em produção, e leia
  **de onde ela lê**;
- se a resposta vier de um serviço interno (worker, cache, view), confira por
  ele, não pela API de origem — e diga no documento por qual dos dois conferiu;
- desconfie quando a fonte consultada for mais simples que a decisão. Um
  endpoint que devolve uma lista de nomes não sabe nada sobre roteamento.

**2. Backup exportado do SQL Editor tem de ser SALVO EM ARQUIVO.**

Não serve copiar para a área de transferência. A área de transferência é
sobrescrita pela próxima cópia, não sobrevive a um reinício e não pode ser
conferida depois — e o `DELETE` de 31/07 ficou sem restauração possível
exatamente assim: o `SELECT` foi exportado, copiado, e perdido antes de virar
arquivo.

Salve em disco, confira a contagem de linhas do arquivo **antes** de rodar o
`DELETE`, e só apague depois que ela bater com a do `SELECT`. Guarde o arquivo
até a conferência pós-restauração passar.

### Ao investigar produção

Abra o documento declarando o modo de acesso, como todos os docs recentes fazem:

> **28/07/2026. Somente leitura.** Nenhum código foi alterado, nada foi escrito
> no banco e nenhuma mensagem foi enviada. O acesso ao Supabase foi `GET` via
> PostgREST; o acesso à WAHA foi `GET` em `/api/sessions`.

E registre no commit: `No migration was applied.`

---

## 5. Documentação

`web/docs/` é a **documentação técnica canônica** (`CLAUDE.md`, seção
Arquitetura). É lá que documentação nova vai.

- A raiz `docs/`, `CHATPRO_HANDOFF.md` e `CHATPRO_PLAN.yaml` estão
  desatualizados desde 15/07/2026 e descrevem um estado que não existe mais.
  Não escreva neles.
- Nomes em kebab-case, sem prefixo numérico e sem data. Sufixo por tipo:
  `-overview.md` / `-flow.md` / `-architecture.md` para referência estável,
  `-investigacao.md` / `-audit.md` para investigação, `-aplicacao.md` para
  procedimento, `-propostas-*.sql` para SQL não aplicado,
  `-verificacao.sql|.mjs` para suíte de verificação.
- Conteúdo em português.
- **Documento autocontido.** O `CLAUDE.md` manda ler apenas o documento
  específico do assunto, sem varrer o repositório — então o nome do arquivo tem
  que entregar o assunto, e o texto não pode depender de contexto externo.
- **Honestidade epistêmica.** Onde não houve evidência direta, escreva
  **não identificado**. Nenhuma afirmação inferida sem fonte.
- **Atualize com bloco datado**, em vez de reescrever:
  `> **Estado em 2026-07-28:** a correção descrita na seção 6 foi implementada.
  A limpeza retroativa continua pendente de aprovação.`
- **Revalidação é PR própria** e ancora num SHA: *"Revalidado em 28/07/2026
  contra `origin/main` @ `98a984d`"*.
- **Nunca** exponha segredo em documentação — referencie a variável pelo nome,
  jamais o valor.

PR só de documentação é entregável de primeira classe, com `docs:` ou
`docs(<escopo>):`.

---

## 6. Antes de abrir a PR

A partir de `web/`:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Estes quatro comandos são a validação declarada no `CLAUDE.md`. O CI roda
typecheck e testes em toda PR contra `main`, mas rodá-los antes evita o
ciclo de espera.

Nunca commite: `.env`, `.env.local`, credenciais, sessões, auth state, QR codes,
bancos locais, `.chatpro-data/`, `.waha-sessions/`, `.claude/`, logs ou dados
pessoais. O `.gitignore` cobre esses casos — se algo assim aparecer no
`git status`, é sinal de que o caminho é novo, não de que a regra mudou.

```bash
git push -u origin <branch>
gh pr create --base main
```

Para **atualizar o corpo de uma PR já aberta**, não use `gh pr edit
--body-file`. Com o `gh` instalado aqui (2.45.0) ele consulta `projectCards`
mesmo sem nenhuma flag de projeto e morre em `GraphQL: Projects (classic) is
being deprecated ... (repository.pullRequest.projectCards)`. Ele **retorna erro
e não grava nada** — o corpo fica exatamente como estava, e é fácil seguir em
frente achando que gravou. Já aconteceu nas PRs #23, #26, #28 e #63. É a issue
`cli/cli#11983`, corrigida no gh v2.73.0. O caminho confiável é a REST:

```bash
gh api -X PATCH repos/SALOMBRAS/ProChat/pulls/<N> -F body=@corpo.md
```

Cuidado ao ler os dois comandos: `-F` significa coisas diferentes em cada um. Em
`gh pr edit` é o atalho de `--body-file`; em `gh api` é `--field`, e quem manda
ler do arquivo é o `@`. Depois de qualquer um dos dois, confira o resultado com
`gh pr view <N> --json body`.
