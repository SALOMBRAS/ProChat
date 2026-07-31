# Convenções de teste

**31/07/2026.** Consolida o que as PRs já praticam. Nada aqui é convenção nova:
cada regra vem acompanhada do incidente que a criou, com o número da PR e a
medição. Onde as práticas divergiram entre PRs, **as duas estão registradas como
aceitas** — o documento descreve o repositório, não um ideal.

O `CONTRIBUTING.md` cobre a prova de cobertura por reversão (§1) e a mecânica de
rodar os testes (§3). Este arquivo não repete: ele trata do que aquele documento
não alcança, que é a **interação entre o ciclo de vida do React e a ferramenta de
teste**.

---

## 1. Três flakes em três dias

Entre 29 e 31/07/2026, três testes distintos foram corrigidos por serem
intermitentes. Nenhum deles era azar:

| PR | O que disputava | Com o quê |
| --- | --- | --- |
| **#68** | relógio de parede | o scheduler do event loop |
| **#72** | um clique | a descarga de um efeito passivo |
| **#84** | a restauração de mocks | o `cleanup` do testing-library |

O padrão comum: **código que roda depois do momento em que o teste acha que a
ação terminou.** Um efeito passivo, um tique de intervalo, um hook de limpeza.
Todos os três foram corrigidos removendo a nondeterminância na origem, não
esperando por ela.

Vale registrar o que **não** eram, porque foi o primeiro palpite em todos:
não eram vazamento entre arquivos. Cada arquivo roda em processo próprio
(`pool: 'forks'` e `isolate: true` são o padrão do Vitest e ninguém os altera
aqui), e nos três casos o arquivo **passava sozinho** e só falhava sob a suíte
completa.

---

## 2. Relógio de parede — PR #68

### O incidente

`request-deadline.test.ts` falhava cerca de 1 vez em 5. A causa é aritmética:

```ts
function reserve(budgetMs: number) { return Math.min(500, Math.floor(budgetMs / 10)); }
storage.run({ expiresAt: Date.now() + Math.max(1, budgetMs - reserve(budgetMs)) }, run)
```

`reserve(1)` é `min(500, floor(1/10))` = **0**. Então `withRequestDeadline(1, …)`
grava o prazo em `Date.now() + 1`, e a asserção lê `expiresAt - Date.now()`
depois de um salto async. **Bastava o event loop gastar 1 ms** entre gravar e ler
para o resultado ser `0`, contra um `> 0`.

### A escolha

```ts
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });
```

**Congela só o relógio.** O relógio real nunca foi parte da intenção: o que esses
testes afirmam é a conta `orçamento − reserva`, não quanto tempo o processo levou
até a asserção.

### As duas alternativas, e por que foram recusadas

**Aumentar o orçamento** tiraria o flake e **apagaria o caso coberto**. 1 ms é
justamente onde `reserve` devolve 0 e o `Math.max(1, …)` impede o prazo de nascer
vencido. Com o relógio congelado esse caso continua exercitado, agora
deterministicamente.

**Congelar os temporizadores junto** seria pior. Os `setTimeout` do arquivo
exercitam isolamento entre contextos async — um comando não gastar o orçamento do
outro, o trabalho destacado não herdar prazo. Isso não depende de tempo passar de
verdade, e torná-los falsos obrigaria a avançá-los à mão em **dois testes sem
defeito nenhum**.

### A regra

> **Congele o mínimo.** `toFake` existe para isso. Falsear o relógio inteiro
> quando só `Date` atrapalha transforma testes saudáveis em testes que precisam
> de manutenção.

### Ganho de cobertura que veio junto

A passagem de tempo acontecia por acidente entre uma linha e outra e **nenhuma
asserção a media**. Com o relógio sob controle, ganhou teste próprio — o
orçamento cai de 9.500 para 9.100 depois de 400 ms e fica negativo depois de
estourado. Um flake corrigido costuma revelar um comportamento que ninguém
estava afirmando.

<sub>— `web/apps/worker/test/request-deadline.test.ts`, PR #68</sub>

---

## 3. Ordem de descarga de efeito — PR #72

### O incidente

`App.test.tsx > "Inbox contact creation"` falhava ~1 em 20 execuções da suíte
completa, e **nunca isolado**.

```ts
useEffect(() => { setCreatingContact(false); setContactError(""); }, [selected?.id]);
```

O efeito existia para descartar um formulário meio preenchido quando o operador
troca de conversa, o que está certo. Mas `selected?.id` **também** transiciona de
`undefined` para um id quando a *primeira* conversa abre — e nessa transição não
há nada a limpar, enquanto o `setCreatingContact(false)` continua correndo
**depois da pintura do painel**. O teste clica em "Criar contato" no instante em
que o botão aparece, que é exatamente essa janela.

A ordem foi instrumentada e impressa:

| execução que falhou | execução que passou |
| --- | --- |
| `FLAKE click` | `FLAKE reset-effect id= conversation-a` |
| `FLAKE reset-effect id= conversation-a` ← desfaz o clique | `FLAKE click` |

### Não era defeito só de teste

**Um operador que abra a Inbox por deep link e clique em "Criar contato" no
instante em que o painel aparece vê o formulário fechar sozinho.** O seletor de
fila tinha a mesma corrida: a escolha voltava para "Sem fila definida".

Esse é o desfecho mais valioso de investigar um flake até o mecanismo. Um teste
intermitente costuma ser a única testemunha de uma corrida que o usuário também
perde, com menos frequência e sem ninguém para relatar.

### A correção

Os resets saíram dos efeitos e entraram na própria troca de conversa, dentro de
`openConversation` — **na mesma atualização** que troca `selected`. Deixa de
existir janela pós-pintura em que um clique possa cair, qualquer que seja a ordem
que o React escolha.

### A ressalva de método, que é o ponto principal desta seção

> **A prova por reversão NÃO prova esta correção.** Restaurar o efeito antigo *e*
> remover os resets novos deixa os 30 testes do arquivo verdes: as duas versões
> são **behavioralmente idênticas** e diferem só em *quando* o reset chega.
> Nenhum teste de DOM captura ordem de descarga de efeito.

Consequência prática, e a PR #72 declara isso no corpo: os testes novos são
**guardas de regressão, não testes-prova**. Eles pinam o comportamento que o
reset precisa manter, para que uma "simplificação" futura que o apague falhe alto
em vez de deixar um rascunho velho vazar para a próxima conversa.

**A prova da correção é a medição** — §6.

A alteração de produção em si tem cobertura por reversão, e ela foi registrada
normalmente:

```
- contact form reset removed from the switch -> 2 tests fail: the half-typed draft survives into
                                                the next conversation, and is still open on the
                                                way back
- visual queue reset removed from the switch -> 1 test fails: the queue picked on one conversation
                                                labels the next one
```

### O achado da varredura

A segunda ocorrência (`setVisualQueue`) **não aparecia nas 20 execuções porque o
seletor de fila não tinha teste nenhum**. A ausência de falha media a cobertura,
não a saúde. Vale como regra de leitura: um flake que some ao adicionar teste
noutro lugar não foi corrigido — foi escondido.

<sub>— `web/apps/dashboard/src/ui/Inbox.tsx`, PR #72</sub>

---

## 4. Ordem de hooks — PR #84

### O incidente

`InboxSyncProgress.test.tsx`, que chegou com a #76, falhava cerca de 3 em 20
execuções da suíte completa e nunca isolado. Dois testes diferentes do arquivo se
revezavam falhando, sempre com:

```text
TypeError: Cannot read properties of undefined (reading 'then')
    at Inbox.tsx:525
    ... commitHookEffectListMount ← commitPassiveMountEffects ← flushPassiveEffects
```

Isto é o polling da Inbox chamando `api.syncStatus!(session).then(...)` num mock
cuja implementação sumiu. O número da linha é o do relato original; a mesma
chamada está hoje em `Inbox.tsx:539`, porque o arquivo andou desde então — vale
como lembrete de que linha em pilha de erro envelhece e o trecho de código não.

### A causa: hooks correm em ordem inversa do registro

```ts
// src/test/setup.ts — registrado PRIMEIRO, pelo setupFiles
afterEach(cleanup);

// InboxSyncProgress.test.tsx — registrado DEPOIS
afterEach(() => vi.restoreAllMocks());
```

O Vitest usa `sequence.hooks: 'stack'` por padrão: **o último `afterEach`
registrado roda primeiro**. Então o do arquivo de teste rodava **antes** do
`cleanup` do setup — e nessa janela o componente ainda está montado, com o
intervalo de 2 s do polling armado. Qualquer tique que caísse ali recebia
`undefined` e lançava.

A #84 não confiou na documentação: sondou direto. Um teste descartável que
consulta o DOM a partir de um `afterEach` de arquivo **ainda encontra o nó
renderizado**, o que prova que o componente segue montado naquele ponto.

### A correção: remover, porque não havia o que restaurar

Todo mock do arquivo é um `vi.fn()` criado por teste, e não há nenhum
`vi.spyOn`. **`restoreAllMocks` não tinha trabalho a fazer e só fazia mal.** Foi
removido, com um comentário explicando por que a ausência é deliberada — para
não ser "restaurado" numa arrumação futura.

### A regra

> **`vi.restoreAllMocks()` só serve para desfazer `vi.spyOn`.** Um arquivo cujos
> mocks são `vi.fn()` locais não precisa dele. E, se o componente arma
> temporizador, chamá-lo no `afterEach` do arquivo é ativamente perigoso: ele
> roda com o componente ainda montado.

Quando a restauração for mesmo necessária num arquivo que arma temporizador, a
saída é desmontar antes — `cleanup()` explícito no início do próprio `afterEach`,
antes de restaurar.

### Réplica independente

Esta medição foi refeita por acaso, numa árvore anterior ao merge da #84:
**6 falhas em 35 execuções (~17%)**, sempre no mesmo arquivo, sempre com o mesmo
erro e a mesma pilha. A #84 mediu **3 em 20 (15%)**. Duas medições independentes
do mesmo defeito, a poucos pontos uma da outra — é o que dá confiança de que a
taxa é real e não artefato de uma sessão.

Diagnóstico confirmado por inversão: rodando os mesmos ciclos com
`--sequence.hooks=list`, que faz o `cleanup` desmontar **antes** de restaurar os
mocks, foram **0 falhas em 10**. É bandeira de CLI, serve como diagnóstico e
**não** como correção — a correção é o arquivo não pedir restauração de que não
precisa.

<sub>— `web/apps/dashboard/src/ui/InboxSyncProgress.test.tsx`, PR #84</sub>

---

## 5. Armadilhas de bancada

### 5.1 O endereço do jsdom persiste entre os testes do arquivo

Abrir uma conversa escreve o deep link no endereço:

```ts
history.pushState({ conversationId: conversation.id }, "", inboxUrlForConversation(conversation.id));
```

E a montagem seguinte lê esse mesmo endereço no estado inicial:

```ts
const [requestedConversationId, setRequestedConversationId] = useState(() => conversationIdFromLocation());
```

O jsdom **não desfaz `pushState` entre testes**. Medido em `InboxAudio.test.tsx`:
o primeiro teste começa em `http://localhost:3000/`, e os quatro seguintes já
começam em `/inbox?conversationId=1111…`.

**A mordida é pior do que parece.** Um teste-sonda mostrou que o endereço herdado
**abre a conversa sozinho, sem nenhum clique**. Ou seja, do segundo teste em
diante o `fireEvent.click(...conversation-item)` é redundante: quebre o handler
de clique da lista e **só o primeiro teste de cada arquivo falha**. Quem ler "1
teste falhou" conclui que é caso de borda, quando o caminho está morto para
todos.

**O precedente correto**, e o único em `beforeEach`:

```ts
beforeEach(() => { history.replaceState({}, "", "/dashboard"); });
```

<sub>— `AppShell.test.tsx:43`</sub>

`App.test.tsx` faz o equivalente em `afterEach`, e essa linha é a única coisa que
impede outro teste do arquivo de tentar resolver `conversation-a` por deep link —
apagá-la achando que é ruído quebra testes que não a mencionam. **As duas formas
são aceitas.** Nove dos arquivos de teste do dashboard não limpam nada.

> **Regra:** todo arquivo que abre conversa deve limpar o endereço num hook. Se o
> seu teste depende da ordem dos `it()`, é este o motivo.

### 5.2 Código adiado lendo ref já sobrescrita

**Nota de honestidade:** a forma literal — um atualizador funcional
`setX(prev => …)` desreferenciando uma ref — **não existe** no repositório hoje.
Procurei e não achei. O que existe é a irmã, com o mesmo mecanismo: **uma
continuação assíncrona lendo uma ref que já mudou**, porque ela corre depois de a
requisição ter ido e voltado.

O repositório resolve isso com guarda de identidade, não com esperança:

```ts
/** Lido de dentro do `catch`, que corre depois de a requisição ter ido e voltado
 *  — a essa altura o `syncJob` daquela renderização já pode estar velho. */
const syncingRef = useRef(false);
…
if (activeConversationId.current === conversationId)
  setMessagesError(messageLoadFailure(nextError, syncingRef.current));
```

<sub>— `Inbox.tsx:359-361` e `:493-494`</sub>

> **Regra:** qualquer coisa que rode depois de um `await` — continuação de
> promessa, atualizador funcional, callback de temporizador — precisa **provar
> que ainda é relevante** antes de escrever estado. Comparar o id capturado no
> começo com o id corrente é o padrão daqui.

### 5.3 O dump de DOM vem truncado em 7000 caracteres

O `@testing-library/dom` trunca em 7000 por padrão. Medido: uma Inbox montada com
20 mensagens tem `document.body.outerHTML` de **11.961** caracteres, e a mensagem
de erro de um `getByText` que falha sai cortada em **7.274**. Com o limite alto,
sai inteira, com **43.429**:

```bash
DEBUG_PRINT_LIMIT=100000 npx vitest run src/ui/InboxMessageCards.test.tsx
```

O sintoma é traiçoeiro: o elemento que você procura costuma estar **depois** do
corte, então a mensagem "não encontrei" vem acompanhada de um HTML onde ele
realmente não aparece. `DEBUG_PRINT_LIMIT`, `prettyDOM` e `screen.debug` não
aparecem em lugar nenhum do repositório — é ferramenta de bancada, não de código
versionado.

### 5.4 CWD, e uma correção ao que eu mesmo escrevi

O `CONTRIBUTING.md` §3 registra a armadilha e diz que `npx vitest run --root
apps/api` falha porque `--root` não muda o `process.cwd()`. **Isso está certo
para a api e não generaliza.** Medido hoje, de `web/`:

| Comando | Resultado |
| --- | --- |
| `npx vitest run` | **31 arquivos falham** (`document is not defined`: sem config na raiz, o environment cai para `node`) |
| `npx vitest run --root apps/api` | **12 arquivos falham**, todos `ENOENT … scandir '…/web/migrations'` |
| `npx vitest run --root apps/dashboard` | **passa**: 26 arquivos, 396 testes, exit 0 |

O `--root` funciona no dashboard porque ele faz o Vitest **achar o
`apps/dashboard/vite.config.ts`** (jsdom + `setupFiles`) e **nenhum teste do
dashboard lê caminho relativo ao cwd**. Na api, doze arquivos montam o banco com
`join(process.cwd(), 'migrations')` — é essa dependência, não a bandeira, que
quebra.

> **A regra continua a mesma** — rode do diretório do workspace, ou por
> `npm run test -w @chatpro/api`. Muda só o motivo: o `--root` não é perigoso por
> si, é perigoso onde o teste lê `process.cwd()`.

Os números do `CONTRIBUTING.md` (26 e 10) estão **defasados**: hoje são 31 e 12,
porque as suítes cresceram. A causa descrita continua exata.

---

## 6. O método de prova

### 6.1 Quantas execuções

Um flake não se prova corrigido rodando "algumas vezes". O número sai da conta:
se a taxa de falha medida é **p**, então **N** execuções limpas acontecem por
acaso com probabilidade **(1−p)^N**.

| taxa medida | 5 execuções | 20 execuções | 60 execuções |
| --- | --- | --- | --- |
| 5 % | 77 % | 36 % | 4,6 % |
| 6 % | 73 % | **29 %** | **2,4 %** |
| 15 % | 44 % | **3,9 %** | 0,01 % |
| 17 % | 39 % | 2,4 % | 0,004 % |

É por isso que a **#72 rodou 60 e não 20**: contra a taxa de ~6% que ela mediu,
vinte execuções limpas sairiam por acaso em ~29% das vezes — não provariam nada.
Sessenta derrubam para ~2,4%. Já a **#84**, contra 15%, teve vinte execuções como
argumento suficiente (~4%).

> **A regra:** meça a taxa primeiro, depois escolha N. Vinte execuções é um
> default razoável para taxas de 15% ou mais; abaixo de 10% é preciso mais.

E a ressalva que as três PRs fazem, com razão: **o argumento forte não é
estatístico.** É que o mecanismo foi observado e removido. A contagem serve para
não confundir "removi a causa" com "não vi acontecer".

Custo real, cronometrado, para calibrar o pedido: dashboard **~6,5 s** por
execução (5× = 32,5 s), api **~9,4 s** (5× = 47,3 s), worker **~2,6 s**
(5× = 13,1 s). Vinte execuções do dashboard custam cerca de dois minutos. É
barato — não há razão para economizar aqui.

> **Cuidado ao citar tempo:** o relatório do Vitest imprime `tests 28.57s` para
> uma suíte que termina em ~6 s de relógio. Aquele número é a **soma de CPU dos
> forks paralelos**, não a espera real.

### 6.2 Meça o "antes" na main limpa

Todas as três PRs mediram os dois lados **do mesmo jeito**:

| PR | antes | depois |
| --- | --- | --- |
| #68 | 1 falha em 20 (arquivo isolado, `origin/main`) | 0 em 20 (suíte completa do worker) |
| #72 | 1 em 20 (`origin/main` @ f9cf90d); 3 em 52 durante a caça | 0 em 60 |
| #84 | 3 em 20 (`origin/main` @ c9b376a) | 0 em 20 |

Sem o "antes" não há denominador, e sem denominador a tabela da §6.1 não pode ser
usada. Medir só o depois responde "não vi falhar", que é exatamente o que se
queria evitar.

A #68 mediu o depois numa condição **mais severa** que o antes — suíte completa
do worker em vez do arquivo isolado, portanto mais disputa de scheduler. Quando
os lados não são simétricos, declare qual é o mais severo.

### 6.3 Teste-prova e guarda-de-regressão

A distinção é do `CONTRIBUTING.md` §1 e vale repetir aqui porque **flake é o caso
em que ela mais aperta**:

- **Teste-prova** falha sem a correção. É o que conta como cobertura da mudança.
- **Guarda-de-regressão** passa dos dois lados, de propósito. Não prova nada
  sobre esta correção; fixa uma decisão para que uma mudança futura não a desfaça
  em silêncio. **Declare que é guarda, e do quê.**

Correções de ordem — §3 e §4 — produzem **guardas**, quase por definição: as duas
versões do código são behavioralmente idênticas e diferem só em *quando*. Um
teste de DOM não observa "quando". Quem escrever esse teste e chamá-lo de prova
está superestimando a cobertura.

Nesses casos a prova é a medição da §6.1, e o corpo do commit deve dizer isso com
todas as letras. A #72 e a #84 dizem.

---

## 7. Convenções que emergiram

Levantadas nos 62 arquivos de teste e 734 testes dos três workspaces. Onde
divergem, **as duas formas estão registradas como aceitas** — não há linter,
formatter nem `.editorconfig` no repositório, então nada reformata e a mistura é
permanente.

### 7.1 Sem exceção

**`describe` é sempre plano.** Zero aninhamento em 117 blocos, em 62 arquivos, em
todos os workspaces. É a única convenção do repositório com 100% de adesão.

### 7.2 Idioma: decidido por arquivo

| Workspace | Contagem |
| --- | --- |
| worker | 83 EN / 0 PT |
| api | 230 EN / 43 PT |
| dashboard | ~316 PT / 62 EN |

A fronteira quase sempre coincide com o arquivo inteiro. **Siga o idioma do
arquivo que você está editando**, não o do workspace. Só um arquivo mistura os
dois de verdade (`conversation-identity.test.ts`) e ali não há regra local a
seguir.

Aspas seguem o idioma: api e worker usam simples, o dashboard novo usa duplas.

### 7.3 A forma do título

O `CONTRIBUTING.md` §1 cita o padrão *"X em vez de Y"*. Ele existe e é **minoria
dura: 47 de 681 títulos (~7%)**.

```
propagates a database error that is not the phone constraint instead of calling it a conflict
rejects an intent that is not a boolean instead of coercing it
keeps the form the operator just opened, instead of closing it a paint later
```

A forma majoritária afirma o mesmo contraste **sem a conjunção** — 187 de 681
títulos —, e em português usa vírgula-negativa ou dois-pontos-justificativa:

```
colar formato não suportado explica o motivo, não falha calado
o dragover pede o drop: sem isso o navegador abre o arquivo numa aba
separa as conversas por divisória, não por card
```

> **As duas são aceitas.** O que vale é o título **afirmar comportamento
> observável e contrastá-lo com o errado**; a conjunção é estilo. Documentar só a
> forma inglesa deixaria ~93% dos títulos existentes como violação silenciosa.

### 7.4 Montagem de componente

Quatro padrões vivos, todos aceitos:

- **`render()` direto** no corpo do teste — o mais comum.
- **Helper local** que monta e navega até o estado de partida
  (`abrirConversa()` em `InboxAttachmentStage.test.tsx:58`).
- **Montagem única em `beforeAll`** congelando o `innerHTML` como fixture.
- **`render` com API injetada** por factory local (`api()`), que é como a família
  Inbox monta.

Nenhum arquivo usa `createRoot`/`react-dom` direto — sempre `render` do
`@testing-library/react`. **Não há helper compartilhado**: `src/test/` só tem
`setup.ts`, e nenhum teste importa fixture de outro.

### 7.5 Mocks

Cinco formas convivem: `as unknown as` (117×), `as never` (53×), classe fake
(17×), `vi.mock` + `vi.hoisted` (só no dashboard) e substituição direta de
protótipo ou global.

Sobre `restoreAllMocks`/`clearAllMocks`/`resetAllMocks` — leia a §4 antes de
adicionar um.

### 7.6 Espera assíncrona

A interação mais importante para este documento:

> **Quando `vi.useFakeTimers()` está ligado, ninguém usa `findBy*` nem
> `waitFor`.** Usa-se `await act(async () => { await Promise.resolve(); })`.

Faz sentido: `waitFor` faz *polling* com temporizador, e com o temporizador falso
ele não avança sozinho. Misturar os dois produz um teste que trava até o timeout
— e o sintoma parece lentidão, não erro de configuração.

Sem temporizador falso, `findBy*` e `waitFor` são a forma normal.

### 7.7 Onde mora o config

Três formas, todas passando:

| Workspace | Config |
| --- | --- |
| dashboard | bloco `test` dentro de `vite.config.ts` |
| api | arquivo dedicado `vitest.config.ts`, com `include` declarado |
| worker e contracts | **nenhum config** — rodam nos defaults |

Onde moram os testes também diverge: a api mantém tudo em `apps/api/test/`; o
dashboard mantém ao lado do fonte, em `src/ui/*.test.tsx`. **As duas convivem.**

### 7.8 Um risco latente, registrado e não corrigido

`api/client.test.ts:9` liga `vi.useFakeTimers()` e chama `vi.useRealTimers()`
como **última expressão do teste**. Se qualquer asserção antes dele lançar, os
temporizadores falsos vazam para o resto do arquivo e todo teste seguinte que
dependa de tempo real trava até o timeout.

O padrão seguro está no mesmo repositório:

```ts
afterEach(() => { vi.useRealTimers(); });
```

<sub>— `SlaOperationalDashboard.test.tsx:113-114`</sub>

Os dois passam hoje. Registrado como preferência, não como defeito.

---

## Referências

- `CONTRIBUTING.md` §1 (prova por reversão) e §3 (rodar os testes, CWD)
- `web/apps/worker/test/request-deadline.test.ts` — §2, PR #68
- `web/apps/dashboard/src/ui/Inbox.tsx` — §3, PR #72
- `web/apps/dashboard/src/ui/InboxSyncProgress.test.tsx` — §4, PR #84
- `web/apps/dashboard/src/test/setup.ts` — o `afterEach(cleanup)` da §4
- `web/apps/dashboard/src/ui/AppShell.test.tsx:43` — o precedente da §5.1
