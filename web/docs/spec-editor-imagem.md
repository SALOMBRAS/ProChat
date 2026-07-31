# Editor de imagem antes do envio — especificação portável

Escrito para quem vai implementar o mesmo recurso em outro sistema, sem acesso a
este código. Descreve o que foi construído nas PRs #56 (o editor), #62 (a tela
que o hospeda) e #71 (recorte e giro), por que cada decisão foi tomada, e o que
quebra se for feito sem cuidado.

Onde a decisão foi arbitrária, está escrito que foi arbitrária. Onde há número
medido, a medição está junto.

---

## 1. O que faz

O operador prepara uma foto antes de enviá-la: escolhe a imagem, rabisca por cima
para circular ou apontar alguma coisa, endireita o que saiu deitado, corta o que
não interessa, e manda. Não é edição de imagem — são as três coisas que se faz a
uma foto antes de mostrá-la a alguém, do jeito que o WhatsApp faz.

### Fluxo do ponto de vista do operador

1. Escolhe uma imagem — pela câmera, pelo seletor de arquivos, colando ou
   arrastando. Tanto faz de onde veio.
2. A imagem aparece grande, com uma barra de ferramentas.
3. Clica em **Editar**. O preview dá lugar ao painel: a imagem, um seletor de
   ferramenta (caneta ou recorte), dois botões de giro, e os botões desfazer,
   refazer, descartar e concluir.
4. Na **caneta**, desenha com o mouse, o dedo ou a caneta, escolhendo cor e
   espessura.
5. No **recorte**, arrasta as oito alças da seleção — ou a seleção inteira — e
   pode travar a proporção em 1:1, 4:3 ou 16:9. O tamanho em pixels do que vai
   sair fica à vista o tempo todo.
6. O **giro** de 90° para qualquer lado vale a qualquer momento, e leva o recorte
   junto.
7. **Concluir** fecha o painel e volta ao preview, agora com a edição aplicada.
8. Escreve uma legenda (opcional) e envia.

Desfazer e refazer cobrem os três: um passo é o último traço, o último giro ou o
último recorte, o que tiver sido. Em qualquer ponto ele pode **descartar a
edição** e voltar à imagem como ela entrou, ou fechar tudo sem enviar.

---

## 2. Arquitetura

### A fronteira

```text
       câmera ─┐
seletor de arq ─┼──▶  File  ──▶  [ EDITOR ]  ──▶  File  ──▶  upload existente
    colar/arrastar ─┘
```

O editor recebe um `File` e devolve outro `File`. **Só isso.** Não conhece a
câmera, não conhece o seletor de arquivos, não conhece a área de transferência,
não conhece o endpoint de upload, não sabe o que é uma conversa.

### Por que essa fronteira

Porque é a única coisa que os três caminhos de entrada têm em comum. Câmera
produz um `File` (de `canvas.toBlob`), seletor produz um `File` (de
`input.files`), colagem e arrasto produzem um `File` (de `DataTransfer`). Se o
editor recebesse "a foto tirada" ou "o arquivo escolhido", precisaria de um ramo
por origem, e cada origem nova exigiria mexer nele.

O que isso desacopla, na prática:

- **A origem.** Três caminhos de entrada, zero linhas de código sobre eles no
  editor. Um quarto caminho (digamos, arrastar de outra aba) não pede alteração
  nenhuma.
- **O envio.** A saída entra no mesmo caminho de upload que um arquivo não
  editado. **Nenhum endpoint novo**, nenhum campo novo, nenhuma migration. Do
  ponto de vista do servidor, chegou um arquivo — não há como saber que passou
  pelo editor, e não precisa haver.
- **O teste.** Dá para exercitar o editor inteiro com um `File` sintético, sem
  câmera, sem rede e sem servidor.

### Onde a peça encaixa no fluxo maior

Neste projeto o editor vive dentro de uma tela de composição de anexo, que toma o
lugar da conversa quando há imagem pendente. Essa tela é **conveniência de
apresentação, não requisito**: o editor funciona igual num modal, numa gaveta
lateral, ou embutido num cartão. O que a tela contribui é espaço — um preview de
430 px de largura tornaria a marcação imprecisa.

O contrato do componente é este:

```ts
type ImageEdit = {
  strokes: readonly Stroke[];   // em coordenadas da imagem base — ver §3.7
  rotation: 0 | 90 | 180 | 270;
  crop?: Rect;                  // em coordenadas do quadro GIRADO — ver §3.8
};

type EditorProps = {
  file: File;                                    // sempre o arquivo ORIGINAL
  initialEdit?: ImageEdit;                       // a edição de uma passagem anterior
  onCancel: () => void;                          // fechar sem aplicar
  onConfirm: (edited: File, edit: ImageEdit) => void;
};
```

Devolver a **descrição da edição** junto do arquivo é o que permite reabrir sem
empilhar perda de qualidade — ver §3.5. Repare que `ImageEdit` não guarda um
único pixel: uma lista de pontos, um número e um retângulo. É essa propriedade,
não o tamanho da estrutura, que faz a garantia de recodificação única sobreviver
ao recorte e ao giro.

---

## 3. As decisões e o porquê

### 3.1 Formato de saída: PNG→PNG, JPEG/WebP→JPEG 0.92

**Problema:** reexportar um canvas obriga a escolher um formato, e a escolha
errada ou degrada a imagem ou estoura o limite de upload.

**Regra:**

| Entrada      | Saída                              |
| ------------ | ---------------------------------- |
| `image/png`  | `image/png`, com JPEG de emergência |
| `image/jpeg` | `image/jpeg` qualidade 0.92        |
| `image/webp` | `image/jpeg` qualidade 0.92        |

**PNG continua PNG** porque PNG costuma ser captura de tela, cheia de texto e
bordas duras, onde o JPEG põe franja (*ringing*) em volta de cada letra. Manter
PNG é lossless e o arquivo continua pequeno, porque captura de tela comprime bem.

**JPEG continua JPEG** porque já era JPEG: reexportar em PNG uma foto que já
passou por compressão com perdas aumenta muito o arquivo sem recuperar nada.

**WebP não é preservado**, e essa é a decisão que mais precisa de justificativa.
Dois motivos, ambos concretos:

1. O encoder WebP do canvas não é universal. O Safari só ganhou
   `canvas.toBlob(..., 'image/webp')` na versão 16.4. Antes disso, a
   especificação manda o navegador **cair em PNG silenciosamente** quando não
   sabe produzir o tipo pedido.
2. Esse fallback é o pior caso possível: um PNG gerado a partir de uma **foto**
   (não de captura de tela) facilmente passa dos 15 MB, e o envio é recusado.

Pedir JPEG, que todo navegador sabe produzir, elimina o galho. O preço é perder o
canal alfa de um WebP transparente — raro em foto, e tratado por §3.1.1.

**A qualidade 0.92 não foi derivada de medição.** Foi herdada do código de captura
da câmera que já existia neste projeto, para que uma foto tirada e uma foto
editada saíssem com a mesma compressão. É um valor razoável e convencional;
qualquer coisa entre 0.85 e 0.95 serviria.

#### 3.1.1 O tipo do blob manda, não o tipo pedido

```ts
const blob = await toBlob(canvas, "image/webp", 0.92);
const type = blob.type || "image/webp";   // ← o que vale é este
```

Como a especificação permite o navegador ignorar o formato pedido, **o `File`
final tem de declarar o tipo do blob que voltou**, não o que foi solicitado.
Declarar `image/webp` num blob que na verdade é PNG faz o servidor recusar na
checagem de *magic bytes*, depois do upload inteiro ter subido.

Depois de ler o tipo real, confira contra a allowlist e recuse localmente o que
não estiver nela.

#### 3.1.2 Fundo branco antes de desenhar

JPEG não tem canal alfa. Uma imagem com transparência reexportada em JPEG fica com
a área transparente **preta**, e numa interface escura isso parece um buraco na
foto. O canvas é pintado de branco antes de receber a imagem.

Isso vale também para o caminho PNG→PNG, o que significa que **um PNG transparente
perde a transparência**. É uma escolha, não um efeito colateral: transparente
virando branco é previsível, e transparente virando preto (o que aconteceria no
fallback JPEG) não é. Se o seu caso de uso envolve figurinhas ou logos com alfa,
inverta essa decisão — mas então trate o fallback JPEG separadamente.

### 3.2 EXIF é perdido, e isso é desejável

Reexportar por canvas descarta todos os metadados: EXIF, XMP, ICC.

**Isso é ganho de privacidade, não perda.** O EXIF de uma foto de celular carrega
coordenadas de GPS, modelo e **número de série** do aparelho, e data e hora
exatas. Nada disso deveria seguir para um contato externo. Um editor que
preservasse EXIF estaria vazando localização do operador a cada foto marcada.

**A orientação não se perde**, e esse é o detalhe que engana. Foto de celular
costuma vir gravada de lado, com uma tag EXIF `Orientation` mandando girar. Se
você descartar o EXIF *e* a orientação, a imagem chega torta.

A saída é como a imagem é decodificada:

- **Use `HTMLImageElement`** (`new Image()` + `src`). Desde ~2020 os navegadores
  aplicam a orientação do EXIF ao decodificar (Chrome 81+, Firefox 77+, Safari
  13.1+), e `naturalWidth`/`naturalHeight` já vêm com as dimensões giradas. Quando
  você desenha esse elemento no canvas, a rotação sai **gravada nos pixels**.
- **Não use `createImageBitmap` sem opção.** Ele *não* aplica a orientação por
  padrão; precisa de `{ imageOrientation: 'from-image' }`. Esquecer isso é o jeito
  mais fácil de entregar foto deitada.

### 3.3 Teto de resolução

**Teto: 2560 px no lado maior.** A imagem é reduzida proporcionalmente antes de
entrar no canvas, e o operador é avisado quando isso acontece.

O cálculo que justifica um teto:

- Um canvas guarda **4 bytes por pixel** (RGBA), sem compressão.
- O navegador ainda faz ao menos uma cópia para exportar.
- Uma foto crua de um celular de 108 MP (12000×9000) são 108 milhões de pixels ×
  4 bytes = **432 MB** de *backing store*, mais a cópia da exportação.
- O Safari do iPhone tem um limite documentado em torno de **16,7 milhões de
  pixels** por canvas. Acima disso ele não dá erro: devolve **canvas em branco**,
  que é o modo de falha mais difícil de diagnosticar que existe.

A 2560 px o pior caso (2560×2560) são 6,55 MP ≈ **26 MB** — folgado em qualquer
aparelho.

**O número 2560 em si é uma escolha, não um resultado.** A restrição real é
"fique bem abaixo de 16,7 MP"; qualquer valor entre 2048 e 3500 satisfaria. 2560
foi escolhido porque:

- é uma resolução comum de tela, fácil de raciocinar;
- é confortavelmente maior do que se acredita que o WhatsApp entrega no destino
  (a referência que se costuma citar é ~1600 px no lado maior). **Isso não foi
  medido** — entrou como conforto para a escolha, não como justificativa. Se
  importar para o seu caso, meça.

Se você quiser outro valor, o que precisa ser mantido é o teto, o aviso ao
operador, e o fato de que a redução acontece **antes** de qualquer desenho.

#### O teto sobrevive ao recorte e ao giro — por construção

Recorte e giro mudam o tamanho da saída, então vale conferir se o cálculo acima
continua de pé. Continua, e não por sorte:

- **`fitWithin` é aplicado uma vez, na base.** A imagem entra reduzida e nunca
  mais é reamostrada. Recorte e giro operam sobre a base já cortada.
- **Giro só troca os lados.** `2560×1440` girado é `1440×2560`: o lado maior é o
  mesmo número, a área é a mesma área. Um giro nunca aumenta nada.
- **Recorte só encolhe.** A seleção é presa dentro do quadro (`clampCrop`), então
  `crop.width ≤ frame.width` e `crop.height ≤ frame.height`, sempre.

Compondo os dois: `área(saída) ≤ área(base) ≤ 2560²`, e o lado maior da saída
nunca passa de 2560. **O pior caso continua sendo a imagem sem edição nenhuma.**

Isto é o tipo de invariante que se quebra numa refatoração distraída — bastaria
alguém deixar o recorte crescer para além do quadro, ou reintroduzir uma escala
na matriz. Vale prender num teste que varra as quatro rotações contra vários
recortes e afirme as duas desigualdades.

### 3.4 O tamanho é conferido na saída, não na entrada

**Problema:** o limite de upload vale para o arquivo que sobe, e o arquivo que
sobe é o reexportado — que **não é necessariamente menor** que o original.

Um PNG de captura de tela reexportado como PNG pode crescer. Uma foto JPEG
recomprimida a 0.92 costuma encolher, mas não há garantia. Conferir só a entrada
deixa passar um arquivo que o servidor vai recusar depois do upload inteiro.

O fluxo é: exporte → leia `blob.size` → se passar do limite, tente o próximo
formato do plano → se nenhum couber, recuse com o tamanho medido na mensagem.

É por isso que o plano do PNG tem duas entradas: `[PNG, JPEG 0.92]`. O JPEG é a
saída de emergência para o PNG que estourou — o caso real é PNG de fotografia,
não de captura de tela.

A mensagem de recusa precisa dizer **quanto deu e qual é o limite**. "Falhou"
manda o operador tentar de novo o que vai falhar de novo.

A conferência é do **caminho de exportação**, não da caneta: uma edição que só
girou, ou que só recortou, passa pela mesma checagem, porque também produz um
blob novo. A intuição de que "recortar só encolhe, então não precisa conferir" é
falsa — a saída é um JPEG recomprimido, e recomprimir um pedaço de uma foto não
garante um arquivo menor que o original. Se você tiver um atalho que pule a
checagem quando não houve traço, é bug.

### 3.5 Reeditar parte sempre do original

**Problema:** JPEG é compressão com perdas. Reexportar um JPEG que já foi
reexportado acumula artefato a cada rodada — a chamada perda geracional. Se o
operador abrir o editor três vezes, a foto passou por três compressões.

**Solução:** o editor recebe sempre o arquivo **como foi escolhido**, e a edição
já aplicada volta por `initialEdit`. Ao confirmar, a edição inteira é repintada
sobre o original e exportada **uma vez**.

Quem chama guarda três estados:

```ts
attachmentSource  // o File como entrou. Nunca muda até trocar de anexo.
attachmentEdit    // traços + giro + recorte. A memória da edição.
attachment        // o File que vai ser enviado (o exportado, ou o próprio source)
```

Consequências:

- Abrir o editor pela quinta vez ainda parte do original: **uma** recodificação,
  não cinco.
- A edição anterior reaparece inteira, então reabrir não perde trabalho.
- "Descartar edição" volta à imagem original de verdade, não a um estado
  intermediário já achatado.
- Trocar o anexo tem de limpar a edição junto, senão o desenho de uma foto
  reaparece sobre a próxima.

**Recorte e giro entram nesse mesmo modelo, e não quebram a garantia.** Essa era
a pergunta a responder antes de escrevê-los, e a resposta depende inteiramente de
*não* aplicá-los aos pixels. A tentação óbvia é, ao confirmar um recorte, gerar a
imagem cortada e passar a tratá-la como a nova origem. Isso funciona uma vez e
apodrece na segunda: a próxima abertura reexportaria o recorte já reexportado, e
a foto acumularia uma geração de perda por operação, exatamente o que §3.5 existe
para impedir. Guardando `rotation` e `crop` como descrição, o pipeline continua
sendo *original → aplica tudo → codifica uma vez*, quantas vezes o editor abrir.

O que muda em relação ao editor só de caneta é o custo dessa escolha, que é zero:
um número e um retângulo por edição.

Os traços ficam em coordenadas da imagem base já reduzida — **não** do canvas
visível, que agora depende do giro e do recorte (§3.7). Como a redução é
determinística para o mesmo arquivo, reabrir reconstrói exatamente o mesmo
desenho.

### 3.6 Confirmar sem edição devolve o `File` intocado

Se não houver traço, nem giro, nem recorte, **não exporte**. Devolva o mesmo
objeto `File` que entrou.

Sem isso, abrir o editor e fechar no "Concluir" recodificaria a imagem por nada:
perderia qualidade, perderia o EXIF (que aqui não interessa a ninguém, já que a
foto não foi tocada) e trocaria o nome do arquivo. O operador não fez nenhuma
edição; o arquivo não deve mudar.

A regra vale para os três pelo mesmo motivo, e é por isso que o teste é sobre a
edição inteira, não sobre a lista de traços:

```
intocada(edição) = edição.traços.vazia? e edição.giro == 0 e edição.recorte == nenhum
```

O caso que revela um teste frouxo aqui é girar 360° em quatro cliques: a edição
volta a ser intocada, e o arquivo tem de voltar a ser o original. Se a sua
condição olhar "houve alguma ação" em vez de "o estado final é o original", esse
caso reexporta à toa.

### 3.7 Ordem das operações: o traço é tinta sobre a foto, o recorte é a moldura

**A pergunta:** o operador risca a foto e depois recorta. O traço acompanha a
área recortada, ou fica onde estava na tela?

**A decisão: acompanha.** O traço é aplicado *antes* do recorte, na foto; o
recorte é a moldura por onde se olha para ela. Riscar e depois recortar corta o
que ficou de fora e mantém a marca exatamente sobre o que ela marcava —
exatamente como aconteceria com uma foto de papel e uma tesoura.

A alternativa — traço por cima do recorte, colado às coordenadas da tela — foi
descartada porque separa a marca daquilo que ela marca. O operador circula um
rosto e recorta em volta dele; se o círculo ficasse ancorado na tela, ele
apareceria sobre outro pedaço da imagem. Nenhuma ferramenta de foto faz isso, e
seria surpresa pura.

**Como isso se implementa:** não com uma etapa de transformação, mas escolhendo o
sistema de coordenadas certo uma vez.

```
traços   → coordenadas da IMAGEM BASE   (nunca mudam quando a geometria muda)
geometria → transformação do canvas     (giro + translação do recorte)
repintar  = pinta o fundo do tamanho da SAÍDA
          → aplica a matriz da geometria
          → desenha a imagem em (0,0) da BASE
          → desenha cada traço nas coordenadas da BASE
```

Com isso, "o traço acompanha o recorte" deixa de ser código: é consequência de a
imagem e o traço estarem no mesmo sistema, com a moldura por fora dos dois.
Recortar não transforma nenhum ponto de nenhum traço. Girar também não.

**A contrapartida é o ponteiro.** Se o traço é gravado na base e o operador
desenha sobre o canvas já girado e recortado, o ponto que o ponteiro dá tem de
voltar pela **inversa** da matriz antes de entrar na lista:

```
pontoDoTraço(clienteX, clienteY) =
    inversa(matrizDaGeometria) aplicada a pontoNoCanvas(clienteX, clienteY)
```

Esquecer essa inversa é o erro mais fácil de cometer aqui, e o mais fácil de não
notar: sem giro e sem recorte a matriz é a identidade, e tudo funciona. O bug só
aparece depois da primeira rotação, e aparece como traço no canto errado.

Um detalhe que sai de graça: como a matriz é **rígida** (giro de múltiplo de 90°
mais translação, determinante 1), não há escala em lugar nenhum. Nenhum pixel é
reamostrado, e a espessura do traço não engorda nem afina sozinha.

### 3.8 O recorte vive em coordenadas do quadro girado

O traço fica na base; o recorte, **não**. O recorte é guardado em coordenadas do
quadro que o operador está vendo — a base com os lados trocados, quando o giro é
de um quarto de volta.

O motivo é que é lá que ele arrasta as alças, e é lá que "16:9" quer dizer 16:9.
Um recorte em coordenadas da base teria de ser reinterpretado a cada giro para
saber que proporção ele tem na tela, e a aritmética das alças ficaria ilegível.

O preço é uma regra: **girar tem de levar o recorte junto**, transformando o
retângulo para o quadro novo. Um quarto de volta à direita leva
`(x, y, w, h)` para `(alturaDoQuadro − y − h, x, h, w)`. Sem isso, o operador
enquadra um rosto, gira, e o enquadramento cai no ombro.

Duas convenções que evitam confusão depois:

- **Recortar o quadro inteiro é não recortar.** Normalize a seleção que cobre
  tudo para "sem recorte". Guardá-la como recorte faria uma imagem sem edição
  nenhuma parecer editada, e o §3.6 mandaria reexportar por nada.
- **Pixel inteiro.** `canvas.width` trunca. Um recorte fracionário faria a
  reabertura reconstruir uma imagem de outro tamanho que a exportada.

### 3.9 Um histórico só, para os três

Desfazer com três ferramentas tem duas saídas: uma pilha por ferramenta, ou uma
pilha de estados. **Escolhemos a pilha de estados**, e a razão é o operador, não
o código: ele não pensa em "desfazer o último traço" e "desfazer o último giro"
como filas separadas — ele pensa em "desfazer o que acabei de fazer".

Então cada passo do histórico é uma `ImageEdit` inteira, e desfazer é recuar o
índice:

```ts
{ entries: ImageEdit[]; index: number }
```

Isso seria proibitivo se um passo fosse um `ImageData`. Não é: um passo são três
campos, e cada instantâneo **compartilha os objetos de traço** dos anteriores.
Empilhar cem passos custa cem ponteiros, não cem cópias da foto. É a mesma razão
de §4.5, levada ao caso geral.

Duas consequências que valem prender em teste:

- **"Descartar edição" é um passo do histórico**, não um `reset`. Desfazer logo
  depois traz tudo de volta — o operador que descarta por engano não perde o
  trabalho.
- **Reabrir o editor reconstrói um histórico plausível** a partir da `ImageEdit`
  que voltou: primeiro a geometria, depois um passo por traço. A ordem real da
  passagem anterior não foi guardada, e não precisa ser — qualquer caminho até
  aquela edição termina na mesma imagem. O que importa é que desfazer continue
  descascando o trabalho anterior um passo por vez, em vez de ficar desabilitado
  logo na abertura.

### 3.10 `minmax(0, 1fr)` na célula do preview

Esta é específica de layout CSS, e foi **encontrada na tela, não por teste**.

O container do preview é um item flex que ocupa a altura restante
(`flex: 1 1 auto; min-height: 0`), e a mídia dentro dele usa `max-height: 100%`
para caber.

O bug: com `display: grid; place-items: center` e **sem** trilha explícita, a
linha do grid é dimensionada pelo conteúdo (`auto`). Aí o `max-height: 100%` da
imagem tenta resolver contra uma altura que depende da própria imagem —
circular —, a porcentagem é ignorada, e a imagem renderiza no tamanho natural.
Uma foto alta estoura a área e aparece barra de rolagem.

Medido no navegador antes da correção: **636 px de conteúdo dentro de 587 px de
área**.

A correção é dar tamanho definido à célula:

```css
.preview {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr);     /* ← a correção */
  grid-template-columns: minmax(0, 1fr);  /* ← idem, para o lado */
  place-items: center;
  overflow: hidden;
}
.preview img { max-width: 100%; max-height: 100%; object-fit: contain; }
```

`minmax(0, 1fr)` em vez de `1fr` porque `1fr` sozinho tem mínimo `auto`, que volta
a deixar o conteúdo mandar. O mesmo motivo do `min-height: 0` no item flex.

Um teste de DOM não pega isso: o jsdom não faz layout. O que dá para prender é a
regra CSS em si, o que é frágil mas melhor que nada — e a medição em navegador
real é o que de fato provou o problema.

### 3.11 A moldura de proporção, e por que `object-fit: contain` tem de sair

O editor só de caneta podia dar `max-height` ao canvas e resolver o resto com
`object-fit: contain`. O recorte não pode, e isso obriga a trocar o esquema.

O problema: `object-fit: contain` faz o **conteúdo** caber na caixa, sem mudar a
caixa. Uma foto alta dentro de uma caixa de `width: 100%; max-height: 260px`
desenha uma faixa estreita e centralizada, com vazio dos dois lados **ainda
dentro do elemento**. A alça de recorte, posicionada em porcentagem sobre esse
elemento, pousa no vazio em vez de na imagem.

A correção é dar à caixa a proporção da imagem, e deixar o canvas preenchê-la:

```css
.editor-frame {
  --editor-max: 260px;                 /* o que era o max-height do canvas */
  position: relative;                  /* âncora da camada de recorte */
  width: min(100%, calc(var(--editor-max) * var(--editor-ratio, 1)));
  margin: 0 auto;
  aspect-ratio: var(--editor-ratio, 1);
}
.editor-canvas { display: block; width: 100%; height: 100%; touch-action: none; }
```

`--editor-ratio` é `largura/altura` da **saída** — recorte e giro incluídos — e é
o componente que a escreve no elemento a cada repintura. O `min()` limita pela
largura disponível e, ao mesmo tempo, pela altura: `--editor-max * proporção` é a
largura que corresponde àquela altura máxima.

Com a caixa medindo exatamente a área desenhada, a alça em porcentagem cai sobre
o pixel certo. **E o ponteiro da caneta também** — o que revela que o esquema
antigo já tinha um erro latente: `canvasPoint` divide pelas medidas do elemento,
que com `contain` numa foto alta não eram as medidas da imagem. O traço saía
deslocado, e ninguém tinha notado porque a foto de teste era larga.

Se você mantiver os `max-height` responsivos, mova-os para a variável
(`--editor-max`), não para o canvas: aplicar altura máxima ao canvas de volta
desfaz a proporção da moldura.

---

## 4. O algoritmo do traço

### O problema

Um `pointermove` não é contínuo. O navegador entrega **um evento por quadro**, e
entre dois eventos a mão andou. Movimento devagar dá pontos próximos e ligá-los
com reta engana o olho; movimento rápido dá pontos distantes, e aí a reta
aparece: o traço vira uma sequência de segmentos com quinas visíveis, justamente
onde o gesto foi mais natural.

Duas correções independentes, que se somam.

### 4.1 Suavização: quadráticas pelos meios dos segmentos

A técnica clássica. Em vez de traçar reta de ponto a ponto, para cada ponto
captado use-o como **ponto de controle** de uma curva quadrática cujo destino é o
**meio do segmento seguinte**.

O efeito: a curva passa *por dentro* da quina em vez de virar em bico, e dois
pontos distantes viram um arco contínuo em vez de uma reta longa.

```text
pontos captados:   P0 ──── P1 ──── P2 ──── P3
com retas:         P0 ─────P1─────╱P2╲─────P3      (quinas em P1 e P2)
com quadráticas:   P0 ~~~~ M(P1,P2) ~~~~ M(P2,P3) ~~~ P3
                        controle P1      controle P2
```

Pseudocódigo, sem framework:

```
função traçar(contexto, pontos, cor, espessura):
    se pontos está vazio: retorne

    contexto.estiloDoTraço = cor
    contexto.espessura     = espessura
    contexto.pontaDaLinha  = "redonda"     # arredonda início e fim
    contexto.juntaDaLinha  = "redonda"     # arredonda emendas

    contexto.iniciarCaminho()
    contexto.moverPara(pontos[0].x, pontos[0].y)

    se pontos tem 1 elemento:
        # toque sem arrastar. Sem este segmento de comprimento zero,
        # a ponta redonda não tem o que arredondar e nada é desenhado.
        contexto.linhaAté(pontos[0].x, pontos[0].y)
        contexto.traçar()
        retorne

    para i de 1 até (tamanho(pontos) - 2):
        atual   = pontos[i]
        próximo = pontos[i + 1]
        meioX = (atual.x + próximo.x) / 2
        meioY = (atual.y + próximo.y) / 2
        contexto.curvaQuadráticaAté(atual.x, atual.y, meioX, meioY)
        #                           └── controle ──┘  └── destino ──┘

    último = pontos[último índice]
    contexto.linhaAté(último.x, último.y)
    contexto.traçar()
```

Com N pontos isso produz **N−2 curvas quadráticas** e um `lineTo` final. Se você
vir `lineTo` entre pontos intermediários, a suavização não está acontecendo.

### 4.2 Recuperar os pontos que o navegador engoliu

`getCoalescedEvents()` devolve os pontos intermediários que o navegador capturou
entre dois quadros e agrupou num único `pointermove`. Num gesto rápido são vários
por evento; sem lê-los, esses pontos simplesmente não existem para o desenho.

```
ao receber um pointermove:
    amostras = evento.getCoalescedEvents?.()
    se amostras está vazio ou o método não existe:
        amostras = [evento]                    # navegador sem suporte
    para cada amostra em amostras:
        ponto = converterParaCoordenadasDoCanvas(amostra.clientX, amostra.clientY)
        traçoEmCurso.pontos.adicionar(ponto)
```

As duas correções resolvem coisas diferentes e não se substituem:
`getCoalescedEvents` dá **mais pontos**; a quadrática faz **os pontos que há**
virarem curva. Um traçado rápido sem a primeira ainda seria pobre em dados; sem a
segunda, ainda seria anguloso.

### 4.3 Converter coordenadas

São **duas** conversões em série, e confundi-las é o bug de §3.7.

A primeira é de tela para canvas. O ponteiro dá coordenadas de viewport; o canvas
desenha nas suas próprias. Sem converter, o traço sai deslocado e com espessura
errada em qualquer tela que não esteja em escala 1:1.

```
função pontoNoCanvas(canvas, clienteX, clienteY):
    ret = canvas.retânguloNaTela()
    # Layout ainda não medido devolve zero. Sem esta guarda a divisão por zero
    # faz o ponto virar NaN e o traço inteiro some.
    escalaX = ret.largura ? canvas.largura / ret.largura : 1
    escalaY = ret.altura  ? canvas.altura  / ret.altura  : 1
    retorne { x: (clienteX - ret.esquerda) * escalaX,
              y: (clienteY - ret.topo)     * escalaY }
```

A segunda é de canvas para a imagem base, e existe porque o canvas mostra a
imagem já girada e recortada enquanto o traço é gravado na base (§3.7):

```
função pontoDoTraço(canvas, clienteX, clienteY):
    retorne aplicarMatriz(inversa(matrizDaGeometria(base, geometria)),
                          pontoNoCanvas(canvas, clienteX, clienteY))
```

Sem giro e sem recorte a segunda é a identidade — o que a torna invisível até a
primeira rotação. Escreva o teste que gira e depois desenha.

### 4.4 Espessura proporcional

A espessura é fração do lado maior da imagem, não um número fixo de pixels de
canvas. Com valor fixo, o mesmo nível sai grosso numa imagem de 600 px e vira fio
de cabelo numa foto de 12 MP.

```
espessura(nível, ladoMaior) = max(2, arredondar(ladoMaior * limitar(nível,1,6) / 260))
```

Como a imagem é sempre mostrada na mesma largura, proporcional à imagem quer dizer
**constante para quem olha**.

**Com recorte, `ladoMaior` é o da saída, não o da base.** Recortar pela metade e
continuar medindo na base daria um traço com o dobro da grossura aparente, porque
a mesma quantidade de pixels passa a ocupar o dobro da tela. Medindo no que está
à vista, o operador que se aproximou continua com a mesma caneta — o traço fica
mais fino em pixels da base, que é o que acontece com tinta de verdade quando se
aproxima a lupa. A espessura é congelada no traço no momento em que ele começa,
então recortar depois não mexe no que já foi desenhado.

**O divisor 260 é calibração arbitrária.** Foi escolhido para que o nível 3 desse
cerca de 1,2% do lado maior, o que pareceu certo a olho. Não houve medição da
caneta do WhatsApp nem de nenhuma outra referência — se ficar fino ou grosso
demais no seu caso, mexa no divisor sem cerimônia. A faixa de 1 a 6 níveis também
é arbitrária.

### 4.5 Repintura e histórico

Guarde a edição como **descrição**, não como snapshots de pixels:

```ts
type Ponto  = { x: number; y: number };
type Traço  = { cor: string; espessura: number; pontos: Ponto[] };
type Edição = { traços: Traço[]; giro: 0|90|180|270; recorte?: Retângulo };
```

Repintar é sempre: fundo do tamanho da saída → aplica a geometria → imagem →
cada traço na ordem. Desfazer e refazer são fatias da lista de edições (§3.9).

Guardar `ImageData` por passo custaria, num canvas de 5 MP, **20 MB por nível de
histórico**. A lista de edições custa alguns kilobytes, porque os instantâneos
compartilham os objetos de traço entre si.

Uma armadilha do redimensionamento: girar e recortar mudam o tamanho do canvas, e
**escrever em `canvas.width` ou `canvas.height` zera o contexto** — some o
desenho, e o estado do contexto volta ao padrão. Por isso o redimensionamento tem
de vir imediatamente antes de uma repintura completa, nunca no meio de uma.

A repintura completa a cada `pointermove` é simples e sempre correta. A 2560 px é
um *blit* de ~5 MP, que o navegador faz bem abaixo de um quadro. Se aparecer
engasgo com muitos traços em máquina fraca, o próximo passo é desenhar só o trecho
novo durante o arrasto — mas comece pelo simples.

### 4.6 A geometria como matriz

Giro e recorte cabem numa única matriz afim, o que evita ter dois caminhos de
código e dois conjuntos de erros de sinal. A matriz leva um ponto da **base** ao
ponto correspondente no **canvas de saída**, na ordem `[a, b, c, d, e, f]` de
`setTransform`:

```
recorte = normalizado(geometria.recorte, quadro(base, giro))   # nenhum se cobre tudo
dx = −(recorte?.x ?? 0)
dy = −(recorte?.y ?? 0)

giro   0 → [ 1,  0,  0,  1,  dx,               dy               ]
giro  90 → [ 0,  1, −1,  0,  base.altura + dx,  dy               ]
giro 180 → [−1,  0,  0, −1,  base.largura + dx, base.altura + dy ]
giro 270 → [ 0, −1,  1,  0,  dx,                base.largura + dy]
```

Ler isto de trás para a frente ajuda: a parte `[a b c d]` é a rotação pura, e
`[e f]` é a translação que traz o resultado de volta ao primeiro quadrante — a
imagem girada cai em coordenadas negativas se não for empurrada. O recorte
subtrai a sua origem, o que é o mesmo que mover a câmera para dentro da imagem.

Três propriedades a conferir num teste, porque cada uma é um bug clássico:

- **Determinante 1.** `a·d − b·c = 1` nos quatro casos. Se der outra coisa, entrou
  escala onde não devia, e a imagem vai ser reamostrada.
- **Ida e volta.** Girar 90° quatro vezes devolve a identidade. É onde se pega o
  giro negativo mal normalizado (`−90 % 360` é `−90`, não `270`).
- **Cantos no lugar.** Aplicar a matriz aos quatro cantos da base tem de dar
  exatamente os quatro cantos da saída, em alguma ordem.

Um cuidado bobo que economiza uma hora: `−0`. Sem recorte, `−(0)` é `−0`, que o
canvas trata igual a `0` mas que faz qualquer comparação estrutural de teste
falhar de um jeito ilegível (`-0 !== 0` em `toEqual`). Some zero (`−x + 0`) e o
problema some.

---

## 5. Implementação de referência

Código real, em React + TypeScript. **Leia a seção §5.3 antes de copiar**: parte
disto é específica deste projeto.

### 5.1 A lógica pura — portável inteira

```ts
export type Point    = { x: number; y: number };
export type Stroke   = { color: string; width: number; points: Point[] };
export type Size     = { width: number; height: number };
export type Rect     = { x: number; y: number; width: number; height: number };
export type Rotation = 0 | 90 | 180 | 270;

/** §3.7/§3.8 — o traço na base, o recorte no quadro girado. */
export type Geometry  = { rotation: Rotation; crop?: Rect };
export type ImageEdit = { strokes: readonly Stroke[]; rotation: Rotation; crop?: Rect };
export const PRISTINE_EDIT: ImageEdit = { strokes: [], rotation: 0 };

/** Espelho da allowlist do servidor. Reexportar para fora dela devolve 415. */
export const EDITABLE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const IMAGE_UPLOAD_LIMIT = 15 * 1024 * 1024;
export const EDITOR_MAX_DIMENSION = 2560;   // ver §3.3 — o número é escolha
export const ANNOTATION_BACKDROP = "#fff";  // ver §3.1.2
export const JPEG_QUALITY = 0.92;           // herdado, não medido

export const isEditableImage = (mime?: string | null): boolean =>
  (EDITABLE_IMAGE_TYPES as readonly string[]).includes(mime ?? "");

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** §4.4 — proporcional ao lado maior. Divisor 260 é calibração a olho. */
export const penWidth = (level: number, longestSide: number): number =>
  Math.max(2, Math.round((Math.max(longestSide, 1) * clamp(level, 1, 6)) / 260));

/** §3.3 — reduz até caber no teto. `reduced` alimenta o aviso ao operador. */
export const fitWithin = (
  width: number, height: number, cap = EDITOR_MAX_DIMENSION,
): Size & { reduced: boolean } => {
  const src = { width: Math.max(1, Math.round(width || 0)), height: Math.max(1, Math.round(height || 0)) };
  const longest = Math.max(src.width, src.height);
  if (longest <= cap) return { ...src, reduced: false };
  const ratio = cap / longest;
  return {
    width:  Math.max(1, Math.round(src.width  * ratio)),
    height: Math.max(1, Math.round(src.height * ratio)),
    reduced: true,
  };
};

/* ---------- §3.8 e §4.6: geometria ---------- */

/** O quadro que o operador vê: a base com os lados trocados no quarto de volta. */
export const frameSize = (base: Size, rotation: Rotation): Size =>
  rotation === 90 || rotation === 270
    ? { width: base.height, height: base.width }
    : { width: base.width,  height: base.height };

export const fullRect = (frame: Size): Rect =>
  ({ x: 0, y: 0, width: frame.width, height: frame.height });

/** Prende dentro do quadro e arredonda: `canvas.width` trunca (§3.8). */
export const clampCrop = (crop: Rect, frame: Size): Rect => {
  const width  = clamp(Math.round(crop.width  || 0), 1, Math.max(1, Math.round(frame.width)));
  const height = clamp(Math.round(crop.height || 0), 1, Math.max(1, Math.round(frame.height)));
  return {
    x: clamp(Math.round(crop.x || 0), 0, frame.width  - width),
    y: clamp(Math.round(crop.y || 0), 0, frame.height - height),
    width, height,
  };
};

/** §3.8 — recortar o quadro inteiro é NÃO recortar. */
export const normalizeCrop = (crop: Rect | undefined, frame: Size): Rect | undefined => {
  if (!crop) return undefined;
  const rect = clampCrop(crop, frame);
  return rect.x === 0 && rect.y === 0
      && rect.width === frame.width && rect.height === frame.height ? undefined : rect;
};

/** §3.3 — recorte só encolhe, giro só troca os lados: o teto continua valendo. */
export const outputSize = (base: Size, geometry: Geometry): Size => {
  const frame = frameSize(base, geometry.rotation);
  const crop  = normalizeCrop(geometry.crop, frame);
  return crop ? { width: crop.width, height: crop.height } : frame;
};

export type Matrix = readonly [number, number, number, number, number, number];

export const applyMatrix = (m: Matrix, p: Point): Point =>
  ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

export const invertMatrix = (m: Matrix): Matrix => {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!det) return [1, 0, 0, 1, 0, 0];   // giro é rígido; a guarda só evita NaN
  return [d/det, -b/det, -c/det, a/det, (c*f - d*e)/det, (b*e - a*f)/det];
};

/** §4.6 — base → canvas. Só giro e translação: determinante 1, sem reamostrar. */
export const geometryMatrix = (base: Size, geometry: Geometry): Matrix => {
  const crop = normalizeCrop(geometry.crop, frameSize(base, geometry.rotation));
  const dx = -(crop?.x ?? 0) + 0;        // o `+ 0` mata o −0, ver §4.6
  const dy = -(crop?.y ?? 0) + 0;
  if (geometry.rotation ===  90) return [0,  1, -1,  0, base.height + dx, dy];
  if (geometry.rotation === 180) return [-1, 0,  0, -1, base.width  + dx, base.height + dy];
  if (geometry.rotation === 270) return [0, -1,  1,  0, dx,               base.width  + dy];
  return [1, 0, 0, 1, dx, dy];
};

/** §3.7 — canvas → base. É o que faz o traço cair onde o operador tocou. */
export const toBasePoint = (point: Point, base: Size, geometry: Geometry): Point =>
  applyMatrix(invertMatrix(geometryMatrix(base, geometry)), point);

export const turnRotation = (rotation: Rotation, quarter: 1 | -1): Rotation =>
  ((((rotation + quarter * 90) % 360) + 360) % 360) as Rotation;   // −90 % 360 é −90

/** §3.8 — leva o recorte para o quadro que o giro acabou de criar. */
export const turnRect = (rect: Rect, frame: Size, quarter: 1 | -1): Rect =>
  quarter === 1
    ? { x: frame.height - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width }
    : { x: rect.y, y: frame.width - rect.x - rect.width, width: rect.height, height: rect.width };

/** O maior retângulo da proporção pedida que cabe no atual, no mesmo centro:
 *  escolher "1:1" sempre encolhe, nunca pula de volta para a imagem inteira. */
export const fitAspect = (rect: Rect, aspect: number): Rect => {
  const width  = Math.min(rect.width, rect.height * aspect);
  const height = width / aspect;
  return {
    x: rect.x + (rect.width  - width)  / 2,
    y: rect.y + (rect.height - height) / 2,
    width, height,
  };
};

/** §3.6 — sem traço, sem giro e sem recorte não há o que reexportar. */
export const isPristineEdit = (edit: ImageEdit): boolean =>
  !edit.strokes.length && edit.rotation === 0 && !edit.crop;

/** §4.3 — viewport → coordenadas do canvas, com guarda contra layout não medido. */
export const canvasPoint = (canvas: HTMLCanvasElement, clientX: number, clientY: number): Point => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width  ? canvas.width  / rect.width  : 1;
  const scaleY = rect.height ? canvas.height / rect.height : 1;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
};

/** §4.2 — os pontos que o navegador agrupou num só evento. */
export const pointerSamples = (
  event: { clientX: number; clientY: number; nativeEvent?: unknown },
): { clientX: number; clientY: number }[] => {
  const native = event.nativeEvent as
    { getCoalescedEvents?: () => { clientX: number; clientY: number }[] } | undefined;
  const coalesced = native?.getCoalescedEvents?.();
  return coalesced?.length ? coalesced : [{ clientX: event.clientX, clientY: event.clientY }];
};

/** §4.1 — quadráticas pelos meios dos segmentos. */
export const tracePath = (context: CanvasRenderingContext2D, stroke: Stroke): void => {
  const points = stroke.points;
  if (!points.length) return;
  context.strokeStyle = stroke.color;
  context.lineWidth   = stroke.width;
  context.lineCap     = "round";
  context.lineJoin    = "round";
  context.beginPath();
  const first = points[0];
  context.moveTo(first.x, first.y);
  if (points.length === 1) {
    // Toque sem arrastar: sem este segmento de comprimento zero o lineCap
    // redondo não tem o que arredondar e o ponto não marca nada.
    context.lineTo(first.x, first.y);
    context.stroke();
    return;
  }
  for (let i = 1; i < points.length - 1; i += 1) {
    const cur = points[i], next = points[i + 1];
    context.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2);
  }
  const last = points[points.length - 1];
  context.lineTo(last.x, last.y);
  context.stroke();
};

/** §3.7 e §4.5 — repintura completa: fundo da SAÍDA, geometria, imagem e traços
 *  nas coordenadas da BASE. É esta ordem que responde "o traço acompanha o
 *  recorte?": acompanha, porque o traço é tinta sobre a foto e o recorte é a
 *  moldura por onde se olha para ela. */
export const renderAnnotation = (
  context: CanvasRenderingContext2D,
  image: CanvasImageSource | undefined,
  strokes: readonly Stroke[],
  base: Size,
  geometry: Geometry = { rotation: 0 },
): void => {
  const output = outputSize(base, geometry);
  context.save();
  // O fundo é pintado ANTES da geometria entrar: ele cobre a saída, não a base.
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = ANNOTATION_BACKDROP;
  context.fillRect(0, 0, output.width, output.height);
  const m = geometryMatrix(base, geometry);
  context.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  if (image) context.drawImage(image, 0, 0, base.width, base.height);
  for (const stroke of strokes) tracePath(context, stroke);
  context.restore();
};

/* ---------- O arrasto do recorte ---------- */

/** Lado mínimo, em pixels do quadro. Um recorte de 2 px exporta uma imagem que o
 *  operador não consegue mais reabrir para consertar. */
export const MIN_CROP_SIDE = 24;
export const CROP_ASPECTS: readonly { label: string; value?: number }[] = [
  { label: "Livre" }, { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 }, { label: "16:9", value: 16 / 9 },
];
export type CropHandle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const lockAspect = (
  rect: Rect, west: boolean, east: boolean, north: boolean, south: boolean,
  frame: Size, aspect: number, min: number,
): Rect => {
  // A borda oposta à alça é a âncora: ela não se mexe, e o retângulo cresce a
  // partir dela até onde o quadro permite.
  const anchorX = west  ? rect.x + rect.width  : rect.x;
  const anchorY = north ? rect.y + rect.height : rect.y;
  const roomX = west || east   ? (west  ? anchorX : frame.width  - anchorX) : frame.width;
  const roomY = north || south ? (north ? anchorY : frame.height - anchorY) : frame.height;
  const place = (width: number, height: number): Rect => ({
    x: west || east   ? (west  ? anchorX - width  : anchorX)
                      : clamp(rect.x + rect.width  / 2 - width  / 2, 0, frame.width  - width),
    y: north || south ? (north ? anchorY - height : anchorY)
                      : clamp(rect.y + rect.height / 2 - height / 2, 0, frame.height - height),
    width, height,
  });
  // Quina cresce pelo eixo que o ponteiro puxou mais — travar sempre na largura
  // faria o arrasto vertical de uma quina parecer que não responde. Alça de borda
  // é dirigida pelo lado que ela move, e o outro segue a proporção.
  const wanted = west || east
    ? (north || south ? Math.max(rect.width, rect.height * aspect) : rect.width)
    : rect.height * aspect;
  const widest     = Math.min(roomX, roomY * aspect);
  const narrowest  = Math.min(Math.max(min, min * aspect), widest);
  const width      = Math.max(Math.min(wanted, widest), narrowest);
  return place(width, width / aspect);
};

/** Puro de propósito: a alça só converte o ponteiro em coordenada do quadro e
 *  chama isto, então a aritmética inteira cabe num teste sem layout. */
export const dragCrop = (
  start: { rect: Rect; point: Point; handle: CropHandle },
  point: Point, frame: Size, aspect?: number,
): Rect => {
  const min = Math.min(MIN_CROP_SIDE, frame.width, frame.height);
  if (start.handle === "move") return {
    x: clamp(start.rect.x + (point.x - start.point.x), 0, frame.width  - start.rect.width),
    y: clamp(start.rect.y + (point.y - start.point.y), 0, frame.height - start.rect.height),
    width: start.rect.width, height: start.rect.height,
  };
  const west  = start.handle.includes("w"), east  = start.handle.includes("e");
  const north = start.handle.includes("n"), south = start.handle.includes("s");
  let left = start.rect.x,  top    = start.rect.y;
  let right = left + start.rect.width, bottom = top + start.rect.height;
  if (west)  left   = clamp(point.x, 0,         right - min);
  if (east)  right  = clamp(point.x, left + min, frame.width);
  if (north) top    = clamp(point.y, 0,         bottom - min);
  if (south) bottom = clamp(point.y, top + min,  frame.height);
  const rect = { x: left, y: top, width: right - left, height: bottom - top };
  return aspect ? lockAspect(rect, west, east, north, south, frame, aspect, min) : rect;
};

/** §3.1 — formato de saída, em ordem de tentativa. */
export const exportPlan = (sourceType: string): { type: string; quality?: number }[] =>
  sourceType === "image/png"
    ? [{ type: "image/png" }, { type: "image/jpeg", quality: JPEG_QUALITY }]
    : [{ type: "image/jpeg", quality: JPEG_QUALITY }];

const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
};
export const annotatedName = (name: string, mime: string): string => {
  const base = name.replace(/\.[^./\\]+$/, "").trim() || "imagem";
  return `${base.slice(0, 120)}-editada.${EXTENSION[mime] ?? "jpg"}`;
};

export type ExportOutcome =
  | { ok: true;  file: File }
  | { ok: false; reason: "size" | "format" | "empty"; size: number };

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => {
    try { canvas.toBlob(resolve, type, quality); } catch { resolve(null); }
  });

/** §3.1.1 e §3.4 — o tipo do blob manda; o tamanho é conferido na saída. */
export const exportAnnotated = async (canvas: HTMLCanvasElement, source: File): Promise<ExportOutcome> => {
  let last: ExportOutcome = { ok: false, reason: "empty", size: 0 };
  for (const attempt of exportPlan(source.type)) {
    const blob = await toBlob(canvas, attempt.type, attempt.quality);
    if (!blob || !blob.size) continue;
    const type = blob.type || attempt.type;               // ← §3.1.1
    if (!isEditableImage(type)) { last = { ok: false, reason: "format", size: blob.size }; continue; }
    if (blob.size > IMAGE_UPLOAD_LIMIT) { last = { ok: false, reason: "size", size: blob.size }; continue; }
    return { ok: true, file: new File([blob], annotatedName(source.name, type), { type }) };
  }
  return last;
};
```

### 5.2 O componente — portável na lógica, específico no markup

```tsx
type Mode = "pen" | "crop";

/** §3.9 — no modo recorte o canvas mostra o quadro INTEIRO: a seleção é uma
 *  moldura por cima, não um corte já aplicado. Só ao concluir — ou ao voltar
 *  para a caneta — o recorte entra na imagem. */
const geometryOf = (edit: ImageEdit, mode: Mode): Geometry =>
  mode === "crop" ? { rotation: edit.rotation }
                  : { rotation: edit.rotation, crop: edit.crop };

/** §3.9 — reconstrói um histórico plausível a partir da edição que voltou:
 *  primeiro a geometria, depois um passo por traço. */
const seedHistory = (edit: ImageEdit): ImageEdit[] => {
  const geometry: ImageEdit = { strokes: [], rotation: edit.rotation, crop: edit.crop };
  const entries: ImageEdit[] = [PRISTINE_EDIT];
  if (edit.rotation !== 0 || edit.crop) entries.push(geometry);
  for (let i = 1; i <= edit.strokes.length; i += 1)
    entries.push({ ...geometry, strokes: edit.strokes.slice(0, i) });
  return entries;
};

export function ImageAnnotator({ file, initialEdit = PRISTINE_EDIT, onCancel, onConfirm }: {
  file: File;                      // §3.5 — SEMPRE o original
  initialEdit?: ImageEdit;
  onCancel: () => void;
  onConfirm: (edited: File, edit: ImageEdit) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef  = useRef<CanvasImageSource>();
  /** A imagem já reduzida ao teto de §3.3. Recorte e giro trabalham sobre ela,
   *  nunca sobre os pixels crus: o teto é aplicado uma vez só. */
  const baseRef   = useRef<Size>({ width: 0, height: 0 });
  const liveRef   = useRef<{ pointerId: number; stroke: Stroke }>();
  // Os manipuladores de ponteiro leem a edição durante o arrasto, quando o
  // estado do React ainda não repassou: a referência é a edição corrente.
  const seed      = useRef(seedHistory(initialEdit));
  const editRef   = useRef<ImageEdit>(seed.current[seed.current.length - 1]);
  const modeRef   = useRef<Mode>("pen");
  const liveCropRef = useRef<Rect>();

  // §3.9 — um histórico só, para os três.
  const [history, setHistory] = useState(() =>
    ({ entries: seed.current, index: seed.current.length - 1 }));
  const [base,  setBase]  = useState<Size>({ width: 0, height: 0 });
  const [mode,  setMode]  = useState<Mode>("pen");
  const [aspect, setAspect] = useState<number>();
  const [liveCrop, setLiveCrop] = useState<Rect>();
  const [drag,  setDrag]  = useState<{ handle: CropHandle; pointerId: number; rect: Rect; point: Point }>();
  const [color, setColor] = useState(PEN_COLORS[0].value);
  const [level, setLevel] = useState(3);
  const [ready, setReady] = useState(false);
  const [busy,  setBusy]  = useState(false);

  const edit   = history.entries[history.index];
  const frame  = frameSize(base, edit.rotation);
  /** O que o operador vê: o arrasto em curso, o recorte já aplicado, ou o quadro
   *  inteiro quando ainda não recortou. */
  const selection = liveCrop ?? edit.crop ?? fullRect(frame);
  const output = outputSize(base, geometryOf(edit, mode));

  const paint = useCallback((next: ImageEdit, forMode: Mode, live?: Stroke) => {
    const canvas = canvasRef.current, size = baseRef.current;
    if (!canvas || !size.width || !size.height) return;
    const geometry = geometryOf(next, forMode);
    const fitted = outputSize(size, geometry);
    // §4.5 — mexer em width/height zera o contexto: a repintura vem logo atrás.
    if (canvas.width  !== fitted.width)  canvas.width  = fitted.width;
    if (canvas.height !== fitted.height) canvas.height = fitted.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    renderAnnotation(context, imageRef.current,
      live ? [...next.strokes, live] : next.strokes, size, geometry);
  }, []);
  const commit = useCallback((next: ImageEdit) => {
    editRef.current = next;
    setHistory((cur) => ({
      entries: [...cur.entries.slice(0, cur.index + 1), next], index: cur.index + 1,
    }));
  }, []);
  const commitCrop = useCallback((rect: Rect) => {
    const bounds = frameSize(baseRef.current, editRef.current.rotation);
    commit({ ...editRef.current, crop: normalizeCrop(rect, bounds) });   // §3.8
  }, [commit]);

  // §3.2 — HTMLImageElement aplica a orientação do EXIF ao decodificar.
  useEffect(() => {
    let cancelled = false;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const fitted = fitWithin(image.naturalWidth || image.width, image.naturalHeight || image.height);
      imageRef.current = image;
      baseRef.current = { width: fitted.width, height: fitted.height };
      setBase({ width: fitted.width, height: fitted.height });
      setReady(true);   // + o aviso de redução, quando `fitted.reduced`
    };
    image.src = url;
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
      imageRef.current = undefined;
      // Zerar devolve o backing store: numa foto grande são dezenas de MB.
      const canvas = canvasRef.current;
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    };
  }, [file]);

  // Desfazer, refazer, descartar, girar e recortar mudam a edição inteira:
  // repintar do zero é o que faz o resultado aparecer na tela junto.
  useEffect(() => { paint(edit, mode); }, [base, edit, mode, paint]);

  // O arrasto da alça corre na JANELA, não na alça: o ponteiro sai dos 15 px dela
  // no primeiro milímetro, e `setPointerCapture` é conforto que nem todo
  // navegador concede.
  useEffect(() => {
    if (!drag) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = frameSize(baseRef.current, editRef.current.rotation);
    const move = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      const rect = dragCrop(drag, canvasPoint(canvas, event.clientX, event.clientY), bounds, aspect);
      liveCropRef.current = rect; setLiveCrop(rect);
    };
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      const rect = liveCropRef.current;
      setDrag(undefined); liveCropRef.current = undefined; setLiveCrop(undefined);
      if (rect) commitCrop(rect);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => { /* remover os três */ };
  }, [drag, aspect, commitCrop]);

  /** §3.7 — ponteiro → ponto de traço, nas coordenadas da BASE. */
  const strokePoint = (canvas: HTMLCanvasElement, clientX: number, clientY: number): Point =>
    toBasePoint(canvasPoint(canvas, clientX, clientY), baseRef.current,
                geometryOf(editRef.current, "pen"));

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    // button > 0 é botão do meio/direito; toque e caneta chegam com 0.
    if (!canvas || !ready || busy || event.button > 0 || modeRef.current !== "pen") return;
    event.preventDefault();
    capturePointer(canvas, event.pointerId, true);
    // §4.4 — a espessura é medida no que está À VISTA, não na base.
    const fitted = outputSize(baseRef.current, geometryOf(editRef.current, "pen"));
    const longest = Math.max(fitted.width, fitted.height);
    liveRef.current = {
      pointerId: event.pointerId,
      stroke: { color, width: penWidth(level, longest),
                points: [strokePoint(canvas, event.clientX, event.clientY)] },
    };
    paint(editRef.current, "pen", liveRef.current.stroke);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current, canvas = canvasRef.current;
    if (!live || !canvas || live.pointerId !== event.pointerId) return;
    event.preventDefault();
    for (const s of pointerSamples(event))                       // §4.2
      live.stroke.points.push(strokePoint(canvas, s.clientX, s.clientY));
    paint(editRef.current, "pen", live.stroke);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current;
    if (!live || live.pointerId !== event.pointerId) return;
    liveRef.current = undefined;
    if (canvasRef.current) capturePointer(canvasRef.current, event.pointerId, false);
    // Traço novo apaga o refazer: manter a pilha traria de volta um traço que
    // já não pertence ao desenho atual.
    commit({ ...editRef.current, strokes: [...editRef.current.strokes, live.stroke] });
  };

  /** §3.8 — girar não toca na lista de traços; o recorte, esse, tem de acompanhar. */
  const turn = (quarter: 1 | -1) => {
    const current = editRef.current;
    const before = frameSize(baseRef.current, current.rotation);
    const rotation = turnRotation(current.rotation, quarter);
    const crop = current.crop
      ? normalizeCrop(turnRect(current.crop, before, quarter), frameSize(baseRef.current, rotation))
      : undefined;
    setAspect(undefined);
    commit({ ...current, rotation, crop });
  };

  const step = (delta: number) => {                    // §3.9 — desfazer/refazer
    const index = history.index + delta;
    const next = history.entries[index];
    if (!next || busy) return;
    editRef.current = next;
    setHistory({ entries: history.entries, index });
  };
  /** §3.9 — descartar é um PASSO do histórico, não um reset: desfazer traz tudo
   *  de volta, inclusive o que já viera de uma passagem anterior. */
  const discard = () => commit(PRISTINE_EDIT);

  const confirm = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !ready || busy) return;
    const current = editRef.current;
    // §3.6 — sem traço, sem giro e sem recorte não há o que reexportar.
    if (isPristineEdit(current)) { onConfirm(file, current); return; }
    // Concluir com o recorte ainda em edição tem de exportar o RESULTADO, não o
    // quadro inteiro que a seleção estava mostrando por cima.
    setMode("pen"); modeRef.current = "pen";
    paint(current, "pen");
    setBusy(true);
    try {
      const outcome = await exportAnnotated(canvas, file);       // §3.4
      if (!outcome.ok) { /* mostrar o motivo e o tamanho medido */ return; }
      onConfirm(outcome.file, current);
    } finally { setBusy(false); }
  };

  return (/* moldura + canvas + camada de recorte + ferramentas + ações */);
}

/** Segurar o ponteiro mantém o traço vivo quando a mão sai da área. É opcional
 *  de propósito: o navegador recusa a captura quando o ponteiro já não está
 *  ativo, e perder a captura é menos grave que derrubar o traço. */
const capturePointer = (canvas: HTMLCanvasElement, pointerId: number, hold: boolean) => {
  try {
    if (hold) canvas.setPointerCapture?.(pointerId);
    else canvas.releasePointerCapture?.(pointerId);
  } catch { /* captura é conforto, não requisito */ }
};
```

CSS mínimo. Nada aqui é cosmético — cada propriedade abaixo conserta um bug:

```css
/* §3.11 — a moldura mede a área desenhada, e é a âncora da camada de recorte. */
.editor-frame {
  --editor-max: 260px;                 /* ajuste ao seu espaço */
  position: relative;
  width: min(100%, calc(var(--editor-max) * var(--editor-ratio, 1)));
  margin: 0 auto;
  aspect-ratio: var(--editor-ratio, 1);
}
.editor-canvas {
  display: block; width: 100%; height: 100%;
  touch-action: none;     /* SEM ISTO o dedo rola a página em vez de desenhar */
  cursor: crosshair;
}

/* A camada recorta a sombra que escurece o lado de fora da seleção. */
.editor-crop { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.editor-crop-box {
  position: absolute;                  /* left/top/width/height em % da moldura */
  box-shadow: 0 0 0 9999px #000000b8;  /* escurece tudo o que ficou de fora */
  cursor: move; pointer-events: auto; touch-action: none;
}
/* As alças ficam POR DENTRO da seleção: metade para fora seria cortada pelo
   `overflow` da camada justamente nos cantos, que é onde mais se recorta. */
.editor-crop-handle { position: absolute; width: 15px; height: 15px; touch-action: none; }
.editor-crop-handle.is-nw { top: 0; left: 0; }
.editor-crop-handle.is-n  { top: 0; left: 50%; transform: translateX(-50%); }
/* … e assim por diante para ne, e, se, s, sw, w */
```

O `box-shadow` de 9999 px em vez de quatro divs de máscara não é truque: é uma
propriedade só, acompanha a caixa de graça, e não intercepta ponteiro.

### 5.3 O que é específico deste projeto

Não copie sem trocar:

| Item | Por que é específico |
| --- | --- |
| **Paleta de cores** | Seis cores escolhidas por já existirem no tema deste sistema, para o editor não inventar cor nova. As cores em si são arbitrárias; o que vale manter é que cubram foto clara e escura. |
| **Limite de 15 MB** | É a política do servidor **deste** projeto para imagem. Troque pelo do seu. |
| **Allowlist `jpeg/png/webp`** | Idem: é o que o servidor daqui aceita, com checagem de *magic bytes*. |
| **Nome `-editada`** | Convenção local. |
| **Textos em português** | Óbvio, mas está em toda parte no código. |
| **Estrutura do composer** | Onde o editor é montado, quem guarda `attachmentSource` e `attachmentEdit`, como o anexo pendente é exibido. Nada disso é do editor. |
| **Níveis 1–6 e divisor 260** | Calibração a olho, §4.4. |
| **Teto de 2560 px** | O teto é obrigatório; **o valor** é escolha, §3.3. |
| **Proporções 1:1, 4:3, 16:9** | São as que fazem sentido para foto de conversa. Um sistema de anúncios quereria 9:16 e 4:5; a lista é dado, não código. |
| **Lado mínimo de 24 px** | O mínimo é obrigatório (§3.8); o número é escolha. Vale o suficiente para a alça continuar arrastável. |
| **Alça de 15 px** | Tamanho de alvo de toque. Se o seu editor for só de desktop, dá para encolher; abaixo de ~10 px o dedo não acerta. |

Portável sem alteração: `fitWithin`, `canvasPoint`, `pointerSamples`,
`tracePath`, `renderAnnotation`, `exportPlan`, `exportAnnotated`, toda a
geometria (`frameSize`, `clampCrop`, `normalizeCrop`, `outputSize`,
`geometryMatrix`, `invertMatrix`, `toBasePoint`, `turnRotation`, `turnRect`,
`fitAspect`, `dragCrop`), o modelo de histórico, e as decisões de §3.

---

## 6. O que não está incluído

Caneta, recorte e giro. Cada item abaixo ficou de fora por ser trabalho próprio,
não por descuido — e cada um exige mais do que parece.

**Texto.** Exige entrada de texto posicionada sobre o canvas, escolha de fonte e
corpo, medição para não vazar da imagem, e edição de um texto já colocado
(portanto, texto vira um objeto com posição e conteúdo, não um traço). Acessibilidade
de um campo flutuante sobre canvas é trabalho por si só.

**Formas** (seta, retângulo, círculo). Estrutura parecida com a da caneta — dois
pontos em vez de N —, mas cada forma tem seu desenho e suas alças de ajuste. A
seta em particular precisa de cabeça proporcional à espessura.

**Mosaico / desfoque.** O mais caro dos seis. Exige ler os pixels da região
(`getImageData`), processar e escrever de volta — e isso é destrutivo, então não
cabe no modelo de histórico por lista de traços de §4.5: ou você guarda a região
original de cada aplicação, ou reprocessa tudo a cada repintura. Também é onde
mais importa acertar: um desfoque fraco demais não esconde o dado que o operador
quis esconder.

**Emoji e figurinha.** Exige um seletor, carregar a imagem do emoji, e
posicionamento com arrastar/redimensionar — de novo, objetos, não traços.

O padrão comum a todos: **a caneta é a única ferramenta cujo estado cabe numa
lista imutável de pontos**. Qualquer coisa com posição ajustável depois de criada
pede um modelo de objetos selecionáveis, e é essa mudança de modelo, não o
desenho, que é o trabalho.

---

## 7. Armadilhas

Em ordem aproximada de quanto tempo custam quando aparecem.

**Canvas em branco no iPhone.** Passar do limite de área do Safari não dá erro:
devolve canvas em branco. Sem o teto de resolução (§3.3) você descobre isso na mão
de um usuário, não no seu aparelho de teste. **Nenhum teste automatizado pega
isso** — o jsdom não tem limite de canvas.

**Foto deitada.** Descartar o EXIF sem deixar a orientação ser aplicada na
decodificação entrega foto girada. Acontece com `createImageBitmap` sem
`imageOrientation: 'from-image'`. Só aparece com foto de celular de verdade; um
PNG sintético de teste nunca reproduz.

**WebP virando PNG gigante em silêncio.** Pedir `image/webp` num Safari antigo
devolve PNG, e um PNG de foto passa dos 15 MB. Se você confiar no tipo pedido em
vez do tipo do blob (§3.1.1), ainda declara o mime errado e leva 400 na checagem de
*magic bytes* depois de subir o arquivo inteiro.

**Traço em NaN.** `getBoundingClientRect()` devolve tudo zero quando o layout ainda
não foi medido — e sempre, no jsdom. Sem a guarda de §4.3, a escala vira divisão
por zero, os pontos viram `NaN`, e o traço simplesmente não aparece, sem erro no
console.

**O dedo rola a página em vez de desenhar.** Falta de `touch-action: none` no
canvas. Em desktop com mouse nada acontece de errado, então passa despercebido até
alguém abrir no celular.

**Imagem estourando a área com barra de rolagem.** O caso de §3.10. Encontrado na
tela, invisível para teste de DOM.

**Traço no canto errado depois de girar.** O clássico de §3.7: gravar o ponto do
ponteiro sem passar pela inversa da geometria. Sem giro e sem recorte a matriz é
a identidade, então tudo funciona no teste que você escreveu primeiro. O bug só
aparece na primeira rotação, e a essa altura você já não suspeita das
coordenadas.

**Alça pousando fora da imagem.** `object-fit: contain` faz o conteúdo caber na
caixa sem mudar a caixa: numa foto alta sobra vazio dentro do elemento, e a alça
posicionada em porcentagem cai nele. É o caso de §3.11 — e o mesmo vazio já
deslocava o traço da caneta antes de existir recorte.

**Recorte de um pixel e meio.** `canvas.width` trunca. Guardar recorte
fracionário faz a reabertura reconstruir uma imagem de tamanho diferente da que
foi exportada, e o operador vê a foto "andar" um pixel a cada rodada. Arredonde
ao gravar, não ao desenhar.

**Recortar tudo virando um recorte.** Arrastar a alça de volta à borda produz um
retângulo idêntico ao quadro. Se isso for guardado como recorte, uma imagem
intocada deixa de ser intocada e o §3.6 recodifica por nada. Normalize.

**O canvas em branco depois de girar.** Escrever em `canvas.width` ou
`canvas.height` zera o contexto (§4.5). Redimensionar no meio de uma repintura
apaga o que já tinha sido desenhado, e o modo de falha é uma imagem
intermitentemente vazia — depende de qual repintura ganhou a corrida.

**A alça que foge do ponteiro.** Uma alça de 15 px perde o ponteiro no primeiro
milímetro de arrasto. Escutar `pointermove` na própria alça faz o arrasto morrer
quase imediatamente. Escute na janela — e não conte com `setPointerCapture`, que
o navegador pode recusar (a armadilha logo acima) e que o jsdom nem implementa,
o que também torna o arrasto intestável.

**Giro negativo mal normalizado.** `-90 % 360` é `-90` em JavaScript, não `270`.
Sem o `((x % 360) + 360) % 360`, girar à esquerda a partir de zero produz um
estado que nenhum ramo da matriz reconhece, e a imagem volta a ficar reta.

**O recorte largado noutro pedaço da foto.** Girar sem transformar o retângulo do
recorte (§3.8) é indolor no código e péssimo na tela: o operador enquadra um
rosto, gira para endireitar, e o enquadramento cai no ombro.

**Perda geracional silenciosa.** Reeditar a partir do resultado anterior degrada a
imagem um pouco a cada vez. Ninguém percebe na segunda rodada; percebe-se na
quinta, e aí já não há como saber de onde veio. A regra de §3.5 previne por
construção.

**Memória do histórico.** Guardar `ImageData` por passo parece a solução óbvia e
custa ~20 MB por nível num canvas de 5 MP. Dez passos de desfazer e o aparelho
começa a engasgar.

**`setPointerCapture` lançando exceção.** O navegador recusa a captura quando o
`pointerId` já não está ativo, e a exceção derruba o manipulador inteiro — perdendo
o traço. Envolva em `try`/`catch`: a captura é conforto, não requisito.

**Toque sem arrastar não marca nada.** Um traço de um ponto só, sem o segmento de
comprimento zero de §4.1, não desenha — o `lineCap` redondo não tem o que
arredondar. O operador toca a tela, não vê nada, e conclui que a ferramenta está
quebrada.

**Edição sobrevivendo à troca de anexo.** Se quem chama não limpar
`attachmentEdit` ao trocar o arquivo, o desenho — e agora também o giro e o
recorte — de uma foto reaparece sobre a próxima. É estado de fora do editor,
então nenhum teste do editor pega.

**Refazer ressuscitando traço morto.** Desenhar depois de desfazer tem de limpar a
pilha de refazer. Sem isso, o refazer traz de volta um traço que não pertence mais
ao desenho.

**Backing store não liberado.** Um canvas de 2560 px desmontado sem zerar
`width`/`height` deixa dezenas de MB esperando o coletor. Em uso prolongado —
várias fotos editadas em sequência — soma.

---

## Referências no código deste projeto

Para quem tiver acesso a este repositório:

- `web/apps/dashboard/src/ui/imageAnnotation.ts` — a lógica pura de §5.1
- `web/apps/dashboard/src/ui/ImageAnnotator.tsx` — o componente de §5.2
- `web/apps/dashboard/src/ui/imageAnnotation.test.ts` — testes da aritmética
- `web/apps/dashboard/src/ui/InboxImageEditor.test.tsx` — caminho completo, do
  arquivo que entra ao `File` que sai
- PR #56 (o editor), PR #62 (a tela de composição que o hospeda) e PR #71
  (recorte e giro)
