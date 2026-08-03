# Editor de imagem antes do envio — especificação portável

Escrito para quem vai implementar o mesmo recurso em outro sistema, sem acesso a
este código. Descreve o que foi construído nas PRs #56 (o editor), #62 (a tela
que o hospeda), #71 (recorte e giro) e #104 (texto), por que cada decisão foi
tomada, e o que quebra se for feito sem cuidado.

Onde a decisão foi arbitrária, está escrito que foi arbitrária. Onde há número
medido, a medição está junto.

---

## 1. O que faz

O operador prepara uma foto antes de enviá-la: escolhe a imagem, rabisca por cima
para circular ou apontar alguma coisa, escreve uma palavra sobre ela, endireita o
que saiu deitado, corta o que não interessa, e manda. Não é edição de imagem —
são as quatro coisas que se faz a uma foto antes de mostrá-la a alguém, do jeito
que o WhatsApp faz.

### Fluxo do ponto de vista do operador

1. Escolhe uma imagem — pela câmera, pelo seletor de arquivos, colando ou
   arrastando. Tanto faz de onde veio.
2. A imagem aparece grande, com uma barra de ferramentas.
3. Clica em **Editar**. O preview dá lugar ao painel: a imagem, um seletor de
   ferramenta (caneta, texto ou recorte), dois botões de giro, e os botões
   desfazer, refazer, descartar e concluir.
4. Na **caneta**, desenha com o mouse, o dedo ou a caneta, escolhendo cor e
   espessura.
5. No **texto**, toca a imagem onde quer escrever e digita. A frase aparece na
   foto enquanto ele digita. Pode arrastá-la para outro lugar, mudar a cor e o
   tamanho, tocar numa frase já escrita para corrigi-la, e apagá-la.
6. No **recorte**, arrasta as oito alças da seleção — ou a seleção inteira — e
   pode travar a proporção em 1:1, 4:3 ou 16:9. O tamanho em pixels do que vai
   sair fica à vista o tempo todo.
7. O **giro** de 90° para qualquer lado vale a qualquer momento, e leva o recorte
   junto.
8. **Concluir** fecha o painel e volta ao preview, agora com a edição aplicada.
9. Escreve uma legenda (opcional) e envia.

Desfazer e refazer cobrem os quatro: um passo é o último traço, a última palavra
escrita, o último giro ou o último recorte, o que tiver sido. Em qualquer ponto
ele pode **descartar a edição** e voltar à imagem como ela entrou, ou fechar tudo
sem enviar.

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
  items: readonly EditItem[];   // traços e textos, em coordenadas da BASE — ver §3.7 e §3.12
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
único pixel: uma lista de pontos, uma frase com posição, um número e um
retângulo. É essa propriedade, não o tamanho da estrutura, que faz a garantia de
recodificação única sobreviver ao recorte, ao giro e ao texto.

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
attachmentEdit    // traços + textos + giro + recorte. A memória da edição.
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

A regra vale para os quatro pelo mesmo motivo, e é por isso que o teste é sobre a
edição inteira, não sobre a lista de objetos:

```
intocada(edição) = nenhum objeto de edição.objetos MARCA a imagem
                   e edição.giro == 0 e edição.recorte == nenhum

marca(objeto) = objeto é traço  ? tem ponto
              : objeto é texto  ? tem conteúdo além de espaço
```

Repare que a condição não é "a lista está vazia". **Uma caixa de texto criada e
deixada vazia não marca nada**: o operador tocou a imagem, mudou de ideia e não
digitou. Se ela contasse, concluir recomprimiria a foto, jogaria o EXIF fora e
trocaria o nome do arquivo sem uma única marca visível — exatamente o que esta
seção existe para impedir. Fazer a exceção dentro da própria definição de
"intocada", e não numa limpeza chamada em cinco lugares, é o que garante que
nenhum dos cinco seja esquecido.

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

**O texto entra por esta mesma porta**, e é o que faz a resposta do editor ser
uma só: a frase é gravada em coordenadas da base e desenhada por dentro da mesma
matriz. Recortar corta a parte do texto que ficou de fora, do jeito que a tesoura
cortaria a caneta — inclusive pelo meio de uma palavra, se for lá que a borda
caiu. Girar leva o texto junto. Responder diferente para a segunda ferramenta
criaria duas regras mentais dentro do mesmo painel.

O texto pede **um acréscimo** a este modelo, e só um. Está em §3.13.

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

### 3.9 Um histórico só, para os quatro

Desfazer com quatro ferramentas tem duas saídas: uma pilha por ferramenta, ou uma
pilha de estados. **Escolhemos a pilha de estados**, e a razão é o operador, não
o código: ele não pensa em "desfazer o último traço" e "desfazer o último giro"
como filas separadas — ele pensa em "desfazer o que acabei de fazer".

Então cada passo do histórico é uma `ImageEdit` inteira, e desfazer é recuar o
índice:

```ts
{ entries: ImageEdit[]; index: number }
```

Isso seria proibitivo se um passo fosse um `ImageData`. Não é: um passo são três
campos, e cada instantâneo **compartilha os objetos** dos anteriores. Empilhar
cem passos custa cem ponteiros, não cem cópias da foto. É a mesma razão de §4.5,
levada ao caso geral.

Esse compartilhamento cobra uma disciplina que o traço não cobrava: **mexer num
objeto é trocá-lo na lista, nunca alterá-lo no lugar**. O traço estava imune por
acidente de forma — só entra no histórico depois de pronto e nunca mais muda. O
texto é reescrito, movido e redimensionado depois de criado, e alterá-lo no lugar
reescreveria todos os instantâneos anteriores de uma vez: desfazer recuaria o
índice e a tela não mudaria.

Três consequências que valem prender em teste:

- **"Descartar edição" é um passo do histórico**, não um `reset`. Desfazer logo
  depois traz tudo de volta — o operador que descarta por engano não perde o
  trabalho.
- **Reabrir o editor reconstrói um histórico plausível** a partir da `ImageEdit`
  que voltou: primeiro a geometria, depois um passo por objeto. A ordem real da
  passagem anterior não foi guardada, e não precisa ser — qualquer caminho até
  aquela edição termina na mesma imagem. O que importa é que desfazer continue
  descascando o trabalho anterior um passo por vez, em vez de ficar desabilitado
  logo na abertura. Objetos que não marcam a imagem (§3.6) não ganham passo, e
  não voltam: um passo que não muda nada na tela é um desfazer que parece
  quebrado.
- **Desfazer solta a seleção.** Ver §3.12 — o identificador do objeto é
  reaproveitado, e seleção presa a um crachá reaproveitado apaga o texto errado.

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

### 3.12 De lista de traços a lista de objetos

Esta é a decisão que o texto obriga, e a única que muda a forma do estado. Tudo o
que vem depois — §3.13 a §3.15 — só é possível por causa dela.

**O que era.** A edição guardava `strokes: Stroke[]`, e traço é a única
ferramenta cujo estado cabe numa lista imutável de pontos: é criado com um gesto,
solto, e nunca mais tocado. Não tem seleção, não tem "qual deles", não tem
"mover". Reeditar era acrescentar ao fim.

**O que passa a ser.** Uma lista única e ordenada de objetos:

```ts
type TextItem = {
  id: number;      // identidade da seleção. NUNCA é mostrado ao operador.
  text: string;
  x: number;       // âncora, em pixels da imagem BASE
  y: number;
  size: number;    // corpo da fonte, também em pixels da BASE
  color: string;
  turn: 0|90|180|270;   // o quadro em que foi escrito — ver §3.13
};

type EditItem = ({ kind: "stroke" } & Stroke) | ({ kind: "text" } & TextItem);
type ImageEdit = { items: readonly EditItem[]; rotation: Rotation; crop?: Rect };
```

**Por que uma lista só, e não `strokes[]` mais `texts[]`.** Porque a ordem de
criação é a ordem de empilhamento. Duas listas paralelas obrigariam a uma camada
fixa — todo texto sempre acima de todo traço, ou o contrário — e a camada fixa é
mentira em metade dos casos: quem risca um texto para cancelá-lo espera o risco
por cima. Com uma lista só, "por cima" é consequência de "depois", e a
repintura é um laço sem ramo de prioridade.

**O `id` é derivado, não sorteado.** É o maior id de texto da lista mais um.
Nada de contador global nem de `randomUUID`: reabrir o editor com a mesma edição
tem de reconstruir os mesmos ids, senão a seleção deixa de significar a mesma
coisa entre uma passagem e outra. O preço é que **o id é reaproveitado**: apagar
o segundo texto devolve o crachá 2 ao terceiro. Isso é inofensivo enquanto a
seleção não sobreviver a um desfazer — e é por isso que §3.9 manda soltá-la.

#### O impacto na reedição a partir do original

Nenhum, e vale dizer por quê, porque a pergunta é razoável.

§3.5 se apoia numa propriedade só: **a edição é descrição, não pixel**. Traço é
uma lista de pontos; texto é uma frase, uma posição e um corpo. Os dois são
repintados do zero sobre o original a cada confirmação, e o pipeline continua
sendo *original → aplica tudo → codifica uma vez*, quantas vezes o editor abrir.
A reedição não replica mais "um passo por traço": replica **um passo por
objeto**, na ordem da lista. É a mesma frase com uma palavra trocada.

O que muda é um detalhe honesto de reprodutibilidade: **o texto é rasterizado
pela fonte da máquina**. Dois pontos de um traço reconstroem os mesmos pixels em
qualquer aparelho; uma frase reconstrói os mesmos pixels só se a mesma fonte
estiver lá. Por isso o corpo é declarado com uma pilha de fontes explícita, e não
herdado do padrão do canvas (que é `10px sans-serif`, e produziria letra
minúscula sem ninguém pedir). Se a primeira fonte da pilha faltar, a frase sai
com métrica um pouco diferente da que o operador viu — a posição continua a
mesma, porque a âncora é gravada, mas a largura não. Não é um problema de
qualidade: é uma diferença de um caractere de largura, entre máquinas, num texto
que ninguém vai medir. Vale saber que existe.

### 3.13 O texto é tinta, mas tinta tem um lado certo para cima

§3.7 já decidiu que a marcação é tinta sobre a foto. O texto herda isso: fica em
coordenadas da base, o recorte o corta e o giro o leva junto.

**Mas rabisco não tem em pé, e frase tem.** E é aí que a herança direta produz um
bug que não existia com a caneta:

> A foto do documento chega deitada. O operador gira 90° para endireitá-la — que
> é justamente a ordem certa de trabalhar — e então escreve "conferido". Com o
> texto desenhado em coordenadas da base por dentro da matriz do giro, as letras
> **correm para baixo**. Não é uma surpresa que aparece uma edição depois: é o
> resultado imediato, na mesma sessão.

Isso não é o modelo do papel, é um erro. No papel, quem endireita a foto e depois
escreve escreve em pé. A regra completa que o papel descreve é: **o texto nasce
em pé no quadro em que foi escrito, e um giro posterior o leva junto.**

**A decisão:** cada texto guarda `turn`, o giro do quadro no momento em que foi
criado. O desenho compõe a matriz da geometria com um quarto de volta inverso, e
as duas metades saem de graça:

```
matrizDoTexto = matrizDaGeometria(base, geometria)
              ∘ translação(texto.x, texto.y)
              ∘ giro(−texto.turn)
```

- Escrito com o quadro girado em 90° e visto com o quadro em 90°: os dois giros
  se cancelam e sobra **translação pura** — letra em pé.
- Escrito em 0° e visto em 90°: sobra um quarto de volta — o texto **girou junto
  com a foto**, como a tinta.

O `∘ giro(−turn)` é composto **em aritmética, não empilhando `rotate`/`translate`
no contexto**. Isso é de propósito: mantém uma chamada de transformação por
objeto, mantém a matriz inteira visível ao teste — dá para afirmar determinante 1
nos dezesseis pares (`turn`, giro) —, e é o que preserva a propriedade de §4.6 de
que nada no editor reamostra pixel.

**A alternativa rejeitada** é manter o texto sempre em pé na tela, contra-girando
a cada giro. Ela conserta o caso acima e estraga o outro: quem circulou um rosto
e escreveu ao lado veria a frase se desprender do que ela nomeia assim que a foto
virasse. E exigiria relayout a cada giro, porque a caixa muda de orientação — o
texto que cabia deixa de caber.

**Duas consequências de contabilidade que custam pouco e economizam horas:**

- A **caixa** do texto vive no quadro do próprio texto, com a âncora na origem. A
  pegada na base sai da mesma matriz, e nos quartos ímpares ela tem largura e
  altura trocadas. Usar largura e altura cruas para prender o texto dentro da
  imagem erra exatamente aí, e o texto sai pela borda.
- O que se prende é a **pegada**, não a âncora — a âncora anda pelo mesmo
  deslocamento. Um texto escrito de lado se estende *para cima* a partir da
  âncora; prender a âncora deixaria a metade de cima fora da foto.

**A alça de seleção não tem geometria própria**: é a mesma matriz do desenho
aplicada à mesma caixa. É isso que faz ela pousar sobre as letras em qualquer
giro e qualquer recorte, sem um segundo conjunto de contas para errar.

**E a alça de um texto que o recorte jogou para fora não é desenhada.** O recorte
corta o texto como corta a tinta — isso é o modelo, e vale igual para os dois —,
mas a alça é um `<button>` de verdade: deixada para trás, ela fica invisível (a
camada tem `overflow: hidden`) e ainda assim na ordem do Tab, e um Delete ali
apaga um texto que ninguém está vendo. Para trazer o texto de volta, desfaz-se o
recorte, exatamente como se faria com um traço cortado.

### 3.14 O texto vira pixel no envio, e o campo de digitação não fica sobre a imagem

São duas perguntas que parecem uma, e a resposta separada é o que resolve.

**Quando o texto vira pixel.** Nunca antes da exportação, exatamente como o
traço, o giro e o recorte. O canvas desenha o texto a cada repintura — o canvas
*é* a prévia —, mas o único momento em que pixel de texto entra num arquivo é o
`toBlob` do Concluir. Confirmar o texto **não** o achata na imagem; ele continua
sendo `{ frase, posição, corpo }` até o fim. É essa recusa em achatar que mantém
a garantia de §3.5: reabrir o editor pela quinta vez ainda é uma recodificação,
não cinco.

**Onde o operador digita.** Num `<input>` comum, rotulado, na barra de
ferramentas logo abaixo da moldura. **Não** num campo flutuante posicionado sobre
o canvas.

Essa é a decisão que mais parece preguiça e menos é. O campo flutuante é o que
todo editor de foto faz, e traz três problemas de uma vez:

1. **Acessibilidade.** Um campo posicionado em cima de um canvas, sem fluxo de
   documento, com fonte escalada por transformação, é um trabalho por si só —
   leitor de tela, IME de idioma asiático, teclado de celular que redimensiona a
   viewport, e o cursor de texto que tem de acompanhar o zoom da moldura.
2. **Duas verdades sobre a mesma frase.** O DOM renderiza texto com uma métrica e
   o canvas com outra. Ou você desenha o texto duas vezes e ele fantasma, ou você
   o esconde do canvas enquanto digita e ele "assenta" num salto ao confirmar.
3. **Fonte divergente.** Fazer o campo parecer o desenho exige espelhar pilha de
   fontes, peso e escala — e qualquer divergência aparece como a frase mudando de
   tamanho no momento em que se confirma.

Pondo o campo na barra, os três **deixam de existir** em vez de serem resolvidos.
É um input comum: leitor de tela, IME e teclado de celular funcionam sem uma
linha a respeito. E o canvas passa a ser a única fonte de verdade sobre a
aparência da foto — não há segunda renderização com que divergir.

**O preço, dito sem maquiagem:** o cursor de digitação não fica sobre a imagem. O
operador digita num campo a alguns pixels abaixo da foto e vê a frase aparecer na
foto em tempo real, a cada tecla. Num painel de 720 px com a barra encostada na
moldura, a distância é curta e o retorno é imediato — mas é uma diferença real
em relação a escrever *na* imagem, e quem quiser o campo flutuante vai ter de
pagar os três problemas acima.

Sobre o canvas fica **apenas a alça**: um `<button>` por texto, do tamanho da
caixa, que serve para selecionar, arrastar e receber foco de teclado. É o mesmo
padrão que as alças do recorte já usavam, e não pinta nada — quem desenha é o
canvas por baixo.

### 3.15 Um passo de histórico por gesto, não por tecla

Digitar "urgente" são sete teclas. Se cada uma empilhar um passo, desfazer vira
inútil: o operador aperta desfazer esperando tirar a palavra e tira uma letra.
Segurar a seta para reposicionar é pior — a autorrepetição dispara uma tecla por
quadro e enterra o histórico em sessenta passos que ninguém pediu.

**A regra:** cada `commit` pode declarar uma **chave de agrupamento**. Passo com
a mesma chave do passo anterior **substitui o topo** da pilha; chave diferente, ou
chave nenhuma, empilha.

| Ação | Chave | Efeito |
| --- | --- | --- |
| Criar a caixa e digitar | `text:<id>` | Um passo. O primeiro caractere substitui a caixa vazia, então desfazer some com o texto inteiro em vez de deixar uma caixa vazia para trás. |
| Arrastar a régua de tamanho | `size:<id>` | Um passo por ajuste, não um por pixel de arrasto. |
| Escolher a cor | `color:<id>` | Um passo por "recolori", não um por tentativa. |
| Mover pelo teclado | `move:<id>` | Um passo por reposicionamento — o mesmo que o arrasto do ponteiro já custava. |
| Arrastar, girar, recortar, riscar | nenhuma | Empilham sempre. |

Três armadilhas, cada uma com o seu fecho:

- **Sair do controle fecha o grupo.** Ajustar, ir fazer outra coisa e voltar a
  ajustar tem de dar dois passos. Sem isso, dois ajustes separados por qualquer
  coisa se fundiriam num só.
- **Desfazer fecha o grupo.** Se a chave sobreviver ao desfazer, o próximo passo
  com a mesma chave **substitui o passo que o desfazer acabou de restaurar** — e
  o desfazer seguinte pula um estado inteiro. É a falha mais difícil de enxergar
  das três, porque só aparece na sequência ajustar → desfazer → ajustar.
- **A chave é do objeto selecionado, não da ação.** `text:3` e `text:4` são
  grupos diferentes, e é por isso que **trocar de seleção fecha o grupo** — o Esc
  que solta a seleção, a troca de ferramenta e o desfazer, todos. Reafirmar o
  *mesmo* texto não fecha nada, e é essa distinção que deixa a seta repetida ser
  um gesto de reposicionar em vez de um passo por tecla.

Uma consequência que vale como regra: **enquanto houver chave, há seleção**.
Todos os agrupamentos são de operações sobre um texto selecionado, então soltar a
seleção é o único lugar que precisa fechar a chave — não cada caminho por onde a
seleção se solta.

### 3.16 Inserir texto sem mouse

Um editor de foto é a peça mais dependente de ponteiro de um sistema de
atendimento, e texto é a ferramenta que menos precisa ser. O caminho de teclado é
completo, e cada peça dele reaproveita uma convenção que já existia no painel:

| Ação | Sem mouse | Já existia em |
| --- | --- | --- |
| Criar | Botão **Adicionar texto**, que centra a caixa no que está à vista e **leva o foco ao campo** | — |
| Digitar | O campo é um `<input>` comum, rotulado (§3.14) | — |
| Encontrar um texto já criado | Tab: cada texto é um `<button>` rotulado com o próprio conteúdo | as oito alças do recorte |
| Mover | Setas movem 1 px; com Shift, 10 | `nudge` das alças do recorte |
| Editar o conteúdo | Enter na caixa leva o foco ao campo | — |
| Apagar | Delete ou Backspace na caixa | — |
| Cor e tamanho | Grupo de rádio e `<input type="range">` | a caneta |

Cinco detalhes que decidem se isso funciona de verdade:

- **O foco automático depois de criar.** Sem ele, quem usa teclado insere a caixa
  e fica procurando o campo — o que anula o botão.
- **O foco vai no quadro seguinte, não no mesmo.** O campo só deixa de estar
  desabilitado quando a seleção chega ao render, e elemento desabilitado não
  recebe foco. Mandar o foco no mesmo tique é escrever no vazio. Vale para o botão
  de criar e para o Enter na caixa.
- **Inserções repetidas descem uma linha.** Todo o cálculo da inserção é
  determinístico: sem uma escada, dois cliques no botão largam duas caixas no
  mesmo pixel, a segunda frase nasce por cima da primeira e as alças se sobrepõem
  exatamente. A descida é medida na tela, não na base — numa foto girada, "uma
  linha abaixo" aponta para outro eixo.
- **Clicar numa alça também dá foco a ela.** O `preventDefault` que o arrasto
  precisa impede o navegador de mover o foco, e sem foco a barra passa a falar de
  um texto enquanto a seta e o Delete agem noutro.
- **Setas e Delete só valem com foco na caixa.** No campo, seta move o cursor de
  texto e Backspace apaga caractere, que é o que qualquer um espera. Dois donos
  para a mesma tecla é como se perde a confiança num editor.

E o **Esc é uma escada**, um passo por tecla: primeiro cancela o arrasto em
curso, depois solta a seleção do texto, e só então fecha o painel. Fechar de uma
vez a partir do campo de digitação descartaria a edição inteira de quem só queria
sair do campo.

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
type Texto  = { id: number; frase: string; x: number; y: number;
                corpo: number; cor: string; quadro: 0|90|180|270 };
type Objeto = { tipo: "traço" } & Traço | { tipo: "texto" } & Texto;
type Edição = { objetos: Objeto[]; giro: 0|90|180|270; recorte?: Retângulo };
```

Repintar é sempre: fundo do tamanho da saída → aplica a geometria → imagem →
cada objeto na ordem da lista, que é a ordem de empilhamento. Desfazer e refazer
são fatias da lista de edições (§3.9).

Guardar `ImageData` por passo custaria, num canvas de 5 MP, **20 MB por nível de
histórico**. A lista de edições custa alguns kilobytes, porque os instantâneos
compartilham os objetos entre si — e é por compartilhá-los que mexer num objeto
tem de ser trocá-lo na lista, nunca alterá-lo no lugar (§3.9).

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

### 4.7 O desenho do texto

Três linhas de contabilidade, e uma delas não é óbvia.

**A âncora é o canto superior esquerdo** (`textBaseline = "top"`), e não a linha
de base. O motivo é a alça: é o canto de cima à esquerda que a caixa de seleção
usa, e com a linha de base como âncora mover a alça um pixel moveria o texto um
pixel e a caixa outro.

**O contorno vem antes do preenchimento.** A paleta tem branco, e branco sobre
céu branco não existe. Um `strokeText` escuro por baixo — largura em torno de um
oitavo do corpo, `lineJoin: "round"` para as quinas não crescerem — separa a
letra de qualquer fundo. Desenhar o contorno *depois* cobriria o miolo da letra
com a cor do contorno, que é o mesmo erro com o resultado invertido.

**A altura da linha é uma constante, não uma medida.** `measureText` devolve
largura; altura confiável só sai de `actualBoundingBoxAscent`/`Descent`, que nem
todo ambiente expõe. Um múltiplo do corpo (aqui, 1,28) cobre ascendente e
descendente com folga, e é o que a caixa de seleção e o limite da imagem usam. É
calibração, não medição — está declarado como tal.

Uma armadilha de teste: **o `measureText` é a única parte do editor que depende
de um canvas de verdade**. A aritmética da caixa fica testável passando o medidor
como argumento — um medidor de mentira previsível no teste, o do contexto na
aplicação. Sem essa injeção, metade de §3.13 vira código sem teste.

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

/** §3.7/§3.8 — a marcação na base, o recorte no quadro girado. */
export type Geometry  = { rotation: Rotation; crop?: Rect };

/** §3.12/§3.13 — `turn` é o quadro em que a frase foi escrita. */
export type TextItem  = { id: number; text: string; x: number; y: number;
                          size: number; color: string; turn: Rotation };
export type EditItem  = ({ kind: "stroke" } & Stroke) | ({ kind: "text" } & TextItem);
export type ImageEdit = { items: readonly EditItem[]; rotation: Rotation; crop?: Rect };
export const PRISTINE_EDIT: ImageEdit = { items: [], rotation: 0 };

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
export const oppositeRotation = (rotation: Rotation): Rotation =>
  ((360 - rotation) % 360) as Rotation;      // o inverso de 0 é 0, não 360

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

/* ---------- §3.12 e §3.13: o texto ---------- */

export const TEXT_LEVELS = { min: 1, max: 6, default: 3 } as const;
export const TEXT_SIZE_DIVISOR = 60;   // §3.12 — nível 3 em 5% do lado maior
export const TEXT_MIN_SIZE = 12;       // piso em pixels da base
export const TEXT_LINE_RATIO = 1.28;   // §4.7 — altura da caixa, calibração
export const TEXT_MAX_LENGTH = 120;    // é legenda, não parágrafo
/** A mesma pilha do tema. Declarar é obrigatório: o padrão do canvas é
 *  `10px sans-serif`, e herdá-lo produz letra minúscula sem ninguém pedir. */
export const TEXT_FONT_STACK = 'Inter, ui-sans-serif, system-ui, sans-serif';
export const TEXT_HALO = "#000000b8";  // §4.7 — o contorno que separa da foto

/** §4.7 — medir texto é a única parte que depende do canvas de verdade, então o
 *  medidor entra como argumento e a aritmética continua testável sem ele. */
export type TextMeasure = (text: string, size: number) => number;

export const textSize = (level: number, longestSide: number): number =>
  Math.max(TEXT_MIN_SIZE,
    Math.round((Math.max(longestSide, 1) * clamp(level, TEXT_LEVELS.min, TEXT_LEVELS.max)) / TEXT_SIZE_DIVISOR));
/** O caminho de volta, para a régua mostrar o corpo do texto selecionado. */
export const textLevelOf = (size: number, longestSide: number): number =>
  clamp(Math.round((size * TEXT_SIZE_DIVISOR) / Math.max(longestSide, 1)), TEXT_LEVELS.min, TEXT_LEVELS.max);

/** §4.6 — `a` depois de `b`. Compor em aritmética, e não empilhando
 *  `rotate`/`translate` no contexto, é o que mantém a matriz inteira conferível. */
export const composeMatrix = (a: Matrix, b: Matrix): Matrix => [
  a[0]*b[0] + a[2]*b[1], a[1]*b[0] + a[3]*b[1],
  a[0]*b[2] + a[2]*b[3], a[1]*b[2] + a[3]*b[3],
  a[0]*b[4] + a[2]*b[5] + a[4], a[1]*b[4] + a[3]*b[5] + a[5],
];
export const spinMatrix = (rotation: Rotation): Matrix =>
  rotation ===  90 ? [0,  1, -1,  0, 0, 0] :
  rotation === 180 ? [-1, 0,  0, -1, 0, 0] :
  rotation === 270 ? [0, -1,  1,  0, 0, 0] : [1, 0, 0, 1, 0, 0];

/** Quarto de volta mantém o retângulo alinhado aos eixos: dois cantos bastam. */
export const mapRect = (matrix: Matrix, rect: Rect): Rect => {
  const a = applyMatrix(matrix, { x: rect.x, y: rect.y });
  const b = applyMatrix(matrix, { x: rect.x + rect.width, y: rect.y + rect.height });
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
           width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
};

/** §3.13 — a caixa no quadro do PRÓPRIO texto, com a âncora na origem. Texto vazio
 *  ainda tem caixa: senão a alça de quem acabou de criar nasce com zero pixel. */
export const textBox = (item: TextItem, measure: TextMeasure): Rect => ({
  x: 0, y: 0,
  width:  Math.max(item.size / 2, measure(item.text || " ", item.size)),
  height: Math.max(1, item.size * TEXT_LINE_RATIO),
});

/** §3.13 — quadro do texto → base: põe a âncora e DESFAZ o giro em que foi escrito. */
export const textBaseMatrix = (item: TextItem): Matrix =>
  composeMatrix([1, 0, 0, 1, item.x, item.y], spinMatrix(oppositeRotation(item.turn)));
/** Quadro do texto → canvas. Uma matriz só, ainda rígida: a letra não reamostra. */
export const textMatrix = (item: TextItem, base: Size, geometry: Geometry): Matrix =>
  composeMatrix(geometryMatrix(base, geometry), textBaseMatrix(item));
/** A pegada na base — largura e altura TROCADAS nos quartos ímpares. */
export const textBaseRect = (item: TextItem, measure: TextMeasure): Rect =>
  mapRect(textBaseMatrix(item), textBox(item, measure));
/** §3.13 — a alça não tem geometria própria: é a matriz do desenho. */
export const textOverlayRect = (item: TextItem, measure: TextMeasure,
                                base: Size, geometry: Geometry): Rect =>
  mapRect(textMatrix(item, base, geometry), textBox(item, measure));

/** O pedaço da base que está à vista: a imagem, ou o recorte. */
export const visibleBase = (base: Size, geometry: Geometry): Rect =>
  mapRect(invertMatrix(geometryMatrix(base, geometry)), fullRect(outputSize(base, geometry)));

/** §3.13 — deslocamento da TELA para deslocamento da base. Sem isto a seta para a
 *  direita move o texto para baixo depois do primeiro giro. */
export const canvasDeltaToBase = (delta: Point, base: Size, geometry: Geometry): Point => {
  const inverse = invertMatrix(geometryMatrix(base, geometry));
  const origin = applyMatrix(inverse, { x: 0, y: 0 });
  const moved  = applyMatrix(inverse, delta);
  return { x: moved.x - origin.x, y: moved.y - origin.y };
};

/** §3.13 — prende a PEGADA, e move a âncora pelo mesmo deslocamento. */
export const clampTextPosition = (item: TextItem, measure: TextMeasure, bounds: Rect): Point => {
  const rect = textBaseRect(item, measure);
  const x = clamp(rect.x, bounds.x, Math.max(bounds.x, bounds.x + bounds.width  - rect.width));
  const y = clamp(rect.y, bounds.y, Math.max(bounds.y, bounds.y + bounds.height - rect.height));
  return { x: item.x + (x - rect.x), y: item.y + (y - rect.y) };
};

/** §3.13 — os dois se tocam? Uma alça fora da moldura seria um alvo de Tab que
 *  ninguém vê, e um Delete ali apagaria um texto invisível. */
export const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** §3.12 — id derivado da lista, não sorteado nem de contador global. */
export const nextTextId = (items: readonly EditItem[]): number =>
  items.reduce((max, i) => (i.kind === "text" ? Math.max(max, i.id) : max), 0) + 1;

/** §3.9 — copy-on-write: os instantâneos do histórico compartilham os objetos. */
export const updateTextItem = (edit: ImageEdit, id: number, patch: Partial<TextItem>): ImageEdit =>
  ({ ...edit, items: edit.items.map((i) =>
      i.kind === "text" && i.id === id ? { ...i, ...patch } : i) });

/** §3.6 — traço sem ponto e texto sem conteúdo não põem pixel na imagem. */
export const marksImage = (item: EditItem): boolean =>
  item.kind === "stroke" ? item.points.length > 0 : item.text.trim().length > 0;

/** §3.6 — sem marcação, sem giro e sem recorte não há o que reexportar. */
export const isPristineEdit = (edit: ImageEdit): boolean =>
  edit.rotation === 0 && !edit.crop && !edit.items.some(marksImage);

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

/** §4.7 — escreve na ORIGEM: quem posiciona é a matriz. O contorno vem antes do
 *  preenchimento, senão ele cobre o miolo da letra. */
export const drawText = (context: CanvasRenderingContext2D, item: TextItem): void => {
  if (!item.text) return;
  context.font = `700 ${Math.round(item.size)}px ${TEXT_FONT_STACK}`;
  context.textAlign = "left";
  context.textBaseline = "top";
  context.lineJoin = "round";
  context.lineWidth = Math.max(2, Math.round(item.size / 8));
  context.strokeStyle = TEXT_HALO;
  context.strokeText(item.text, 0, 0);
  context.fillStyle = item.color;
  context.fillText(item.text, 0, 0);
};

/** §3.7 e §4.5 — repintura completa: fundo da SAÍDA, geometria, imagem e objetos
 *  nas coordenadas da BASE. É esta ordem que responde "a marcação acompanha o
 *  recorte?": acompanha, porque a marcação é tinta sobre a foto e o recorte é a
 *  moldura por onde se olha para ela. */
export const renderAnnotation = (
  context: CanvasRenderingContext2D,
  image: CanvasImageSource | undefined,
  items: readonly EditItem[],
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
  for (const item of items) {                       // a ordem é o empilhamento
    if (item.kind === "stroke") { tracePath(context, item); continue; }
    // §3.13 — o texto tem quadro próprio. E a geometria VOLTA depois dele, senão o
    // objeto seguinte herda o quadro do texto anterior.
    const t = textMatrix(item, base, geometry);
    context.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
    drawText(context, item);
    context.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  }
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
type Mode = "pen" | "text" | "crop";

/** §3.9 — no modo recorte o canvas mostra o quadro INTEIRO: a seleção é uma
 *  moldura por cima, não um corte já aplicado. Só ao concluir — ou ao voltar
 *  para a caneta ou o texto — o recorte entra na imagem.
 *
 *  O texto vê a mesma geometria que a caneta: escrever no pedaço que o recorte
 *  joga fora seria trabalho perdido sem aviso. */
const geometryOf = (edit: ImageEdit, mode: Mode): Geometry =>
  mode === "crop" ? { rotation: edit.rotation }
                  : { rotation: edit.rotation, crop: edit.crop };

/** §3.9 — reconstrói um histórico plausível a partir da edição que voltou:
 *  primeiro a geometria, depois um passo por objeto. Objeto que não marca a
 *  imagem não ganha passo, e não volta: um desfazer que não muda nada na tela
 *  parece quebrado. */
const seedHistory = (edit: ImageEdit): ImageEdit[] => {
  const geometry: ImageEdit = { items: [], rotation: edit.rotation, crop: edit.crop };
  const entries: ImageEdit[] = [PRISTINE_EDIT];
  if (edit.rotation !== 0 || edit.crop) entries.push(geometry);
  const marks = edit.items.filter(marksImage);
  for (let i = 1; i <= marks.length; i += 1)
    entries.push({ ...geometry, items: marks.slice(0, i) });
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
  const liveTextRef = useRef<{ id: number; x: number; y: number }>();
  const textFieldRef = useRef<HTMLInputElement>(null);
  const groupRef  = useRef<string>();        // §3.15 — a chave do último passo
  const contextRef = useRef<CanvasRenderingContext2D>();  // §4.7 — para medir texto

  // §3.9 — um histórico só, para os quatro.
  const [history, setHistory] = useState(() =>
    ({ entries: seed.current, index: seed.current.length - 1 }));
  const [base,  setBase]  = useState<Size>({ width: 0, height: 0 });
  const [mode,  setMode]  = useState<Mode>("pen");
  const [aspect, setAspect] = useState<number>();
  const [liveCrop, setLiveCrop] = useState<Rect>();
  const [drag,  setDrag]  = useState<{ handle: CropHandle; pointerId: number; rect: Rect; point: Point }>();
  const [liveText, setLiveText] = useState<{ id: number; x: number; y: number }>();
  const [selectedText, setSelectedText] = useState<number>();   // e um ref-espelho
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
    contextRef.current = context;
    renderAnnotation(context, imageRef.current,
      live ? [...next.items, { kind: "stroke", ...live }] : next.items, size, geometry);
  }, []);
  /** §3.15 — passo com a mesma chave do anterior SUBSTITUI o topo; chave diferente,
   *  ou chave nenhuma, empilha. É o que faz uma palavra digitada ser um Desfazer e
   *  não oito, sem que o histórico precise saber o que é digitar. */
  const commit = useCallback((next: ImageEdit, group?: string) => {
    const merge = Boolean(group) && group === groupRef.current;
    groupRef.current = group;
    editRef.current = next;
    setHistory((cur) => ({
      entries: [...cur.entries.slice(0, merge ? cur.index : cur.index + 1), next],
      index: merge ? cur.index : cur.index + 1,
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
    if (!canvas || !ready || busy || event.button > 0) return;
    // §3.13 — tocar a imagem no modo texto põe a caixa ali e abre o campo.
    if (modeRef.current === "text") {
      event.preventDefault();
      insertText(canvasPoint(canvas, event.clientX, event.clientY), "left");
      return;
    }
    if (modeRef.current !== "pen") return;
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
    commit({ ...editRef.current, items: [...editRef.current.items, { kind: "stroke", ...live.stroke }] });
  };

  /** §3.8 — girar não toca na lista de objetos; o recorte, esse, tem de acompanhar. */
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

  /** §3.13 — põe uma caixa e abre o campo. `at` é um ponto do CANVAS, e `align` diz
   *  que ponto da caixa cai ali: o toque quer a borda esquerda na altura do dedo, o
   *  botão quer a caixa centrada. Como o texto nasce no quadro corrente, a matriz
   *  dele é translação pura — e o canto da caixa em pixels do canvas vira a âncora na
   *  base com uma conversão só, sem deslocamento para errar o sinal depois de girar. */
  const insertText = (at: Point, align: "left" | "center") => {
    const geometry = geometryOf(editRef.current, "text");
    const fitted = outputSize(baseRef.current, geometry);   // §4.4 — mede no que se vê
    const size = textSize(textLevel, Math.max(fitted.width, fitted.height));
    const id = nextTextId(editRef.current.items);
    const turn = editRef.current.rotation;
    const empty = { id, text: "", x: 0, y: 0, size, color: textColor, turn };
    const box = textBox(empty, measure);
    const corner = { x: at.x - (align === "center" ? box.width / 2 : 0),
                     y: at.y - box.height / 2 };
    const bounds = visibleBase(baseRef.current, geometry);
    // §3.16 — a escada, medida na TELA: duas inserções pelo botão cairiam no mesmo
    // pixel, e a segunda frase nasceria por cima da primeira.
    const step = canvasDeltaToBase({ x: 0, y: box.height }, baseRef.current, geometry);
    let anchor = toBasePoint(corner, baseRef.current, geometry);
    while (textsOf(editRef.current.items).some((o) => o.x === anchor.x && o.y === anchor.y))
      anchor = { x: anchor.x + step.x, y: anchor.y + step.y };
    const placed = { kind: "text" as const, ...empty,
                     ...clampTextPosition({ ...empty, ...anchor }, measure, bounds) };
    chooseText(id);
    // §3.15 — criação e teclas na MESMA chave: o primeiro caractere substitui a
    // caixa vazia, e um Desfazer some com o texto inteiro.
    commit(addItem(editRef.current, placed), `text:${id}`);
    // §3.16 — no quadro seguinte: até o React repintar o campo ainda está
    // desabilitado, e elemento desabilitado não recebe foco.
    queueMicrotask(() => textFieldRef.current?.focus());
  };

  /** §3.15 — a chave do agrupamento é do objeto selecionado, então trocar de seleção
   *  fecha o grupo e reafirmar a mesma não fecha nada. Concentrar a regra aqui é o
   *  que dispensa fechá-la em cada caminho por onde a seleção se solta. */
  const chooseText = (id?: number) => {
    if (id !== selectedRef.current) groupRef.current = undefined;
    selectedRef.current = id;
    setSelectedText(id);
  };

  /** §3.13 — remede e prende de volta a cada tecla: sem isto, frase longa perto da
   *  borda cresce para fora da foto e o pedaço de fora some no envio. */
  const reshapeText = (id: number, patch: Partial<TextItem>, group: string) => {
    const item = textById(editRef.current.items, id);
    if (!item) return;
    const bounds = visibleBase(baseRef.current, geometryOf(editRef.current, "text"));
    commit(updateTextItem(editRef.current, id, {
      ...patch, ...clampTextPosition({ ...item, ...patch }, measure, bounds),
    }), group);
  };

  const step = (delta: number) => {                    // §3.9 — desfazer/refazer
    const index = history.index + delta;
    const next = history.entries[index];
    if (!next || busy) return;
    editRef.current = next;
    // §3.12 — a seleção não pode sobreviver a um desfazer, porque o id é reaproveitado
    // e ela passaria a falar de outro texto. E soltá-la fecha a chave do agrupamento
    // (§3.15), sem o que o passo seguinte SUBSTITUIRIA o que acabou de ser restaurado.
    chooseText(undefined);
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

/* §3.14 — a camada do texto só tem alças; quem desenha é o canvas por baixo. */
.editor-text-layer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.editor-text-item {
  position: absolute;                  /* left/top/width/height em % da moldura */
  border: 1px dashed;
  background: transparent;
  cursor: move; pointer-events: auto; touch-action: none;
}
.editor-text-item:focus-visible { outline: 2px solid; outline-offset: 2px; }

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
| **Paleta de cores** | Seis cores escolhidas por já existirem no tema deste sistema, para o editor não inventar cor nova. As cores em si são arbitrárias; o que vale manter é que cubram foto clara e escura. O texto usa **a mesma paleta** da caneta: duas paletas seriam duas coisas para manter. |
| **Pilha de fontes do texto** | É a do `:root` deste projeto, para o texto na foto sair com a letra do produto. O que vale manter é que ela seja **declarada**: o padrão do canvas é `10px sans-serif`, e herdar isso produz letra minúscula sem ninguém pedir. |
| **Divisor 60 e níveis 1–6 do corpo** | Calibração a olho, §3.12. O nível 3 cai em 5% do lado maior. |
| **Altura de linha 1,28** | §4.7 — cobre ascendente e descendente com folga. Calibração, não medição. |
| **Teto de 120 caracteres** | É legenda sobre foto, não parágrafo. Arbitrário. |
| **Contorno preto translúcido** | §4.7 — o que vale manter é que ele exista e contraste com a paleta inteira; a cor é escolha. |
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
`tracePath`, `drawText`, `renderAnnotation`, `exportPlan`, `exportAnnotated`,
toda a geometria (`frameSize`, `clampCrop`, `normalizeCrop`, `outputSize`,
`geometryMatrix`, `invertMatrix`, `toBasePoint`, `turnRotation`,
`oppositeRotation`, `turnRect`, `fitAspect`, `dragCrop`, `composeMatrix`,
`spinMatrix`, `mapRect`), toda a aritmética do texto (`textBox`,
`textBaseMatrix`, `textMatrix`, `textBaseRect`, `textOverlayRect`, `visibleBase`,
`canvasDeltaToBase`, `clampTextPosition`, `nextTextId`, `marksImage`), o modelo
de histórico com agrupamento, e as decisões de §3.

---

## 6. O que não está incluído

Caneta, texto, recorte e giro. Cada item abaixo ficou de fora por ser trabalho
próprio, não por descuido — e cada um exige mais do que parece.

**Formas** (seta, retângulo, círculo). Estrutura parecida com a da caneta — dois
pontos em vez de N —, mas cada forma tem seu desenho e suas alças de ajuste. A
seta em particular precisa de cabeça proporcional à espessura. Depois de §3.12
isto é bem mais barato do que era: já existe lista de objetos, seleção, alça,
arrasto e agrupamento de histórico. O que falta é o desenho de cada forma.

**Mosaico / desfoque.** O mais caro dos cinco, e o único que a lista de objetos
não ajuda. Exige ler os pixels da região (`getImageData`), processar e escrever
de volta — e isso é destrutivo, então não cabe no modelo de §4.5: ou você guarda
a região original de cada aplicação, ou reprocessa tudo a cada repintura. Também
é onde mais importa acertar: um desfoque fraco demais não esconde o dado que o
operador quis esconder.

**Emoji e figurinha.** Um seletor, a imagem do emoji carregada, e posicionamento
com arrastar e redimensionar. Estruturalmente é o texto com um `drawImage` no
lugar do `fillText`: `TextItem` vira `ImageItem`, e §3.13 vale igual — inclusive
o `turn`, porque emoji também tem um lado certo para cima.

**Múltiplas linhas num mesmo texto.** O texto é de uma linha só, de propósito: a
caixa fica um retângulo, o Enter continua significando "pronto" no campo, e a
colisão, o limite da imagem e o arrasto são uma conta só. Duas linhas viram dois
textos. Se você precisar de parágrafo, o que muda é a caixa (altura por número de
linhas) e a medição (a maior largura entre as linhas) — o resto de §3.13
sobrevive.

O padrão que mudou: **a caneta era a única ferramenta cujo estado cabia numa
lista imutável de pontos**. O texto obrigou a troca para uma lista de objetos
selecionáveis (§3.12), e era essa mudança de modelo, não o desenho, que era o
trabalho. Feita ela, forma e emoji viraram acréscimos; o mosaico continua sendo
outro problema.

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

**Texto deitado depois de endireitar a foto.** O caso de §3.13, e o mais fácil de
não prever: o operador gira para endireitar e *então* escreve, e as letras correm
para o lado. Não aparece na primeira versão do teste porque sem giro o quadro do
texto é a identidade — o mesmo formato de armadilha do traço em §3.7, com o
agravante de que aqui o resultado errado é imediato, e não uma edição depois.

**Objeto de texto alterado no lugar.** O histórico é barato porque os
instantâneos compartilham os objetos (§3.9). O traço nunca cobrou essa disciplina
porque só entra pronto e nunca mais muda; o texto é reescrito e movido depois de
criado. Um `objeto.x = novo` reescreve todos os passos anteriores de uma vez, e o
modo de falha é o pior possível: desfazer recua o índice e a tela não muda.

**Uma tecla, um passo de desfazer.** Sem o agrupamento de §3.15, escrever
"urgente" deixa sete passos e segurar uma seta deixa sessenta. O operador aperta
desfazer esperando tirar a palavra e tira uma letra — e conclui que o desfazer
está quebrado, o que, para o que ele queria, está.

**A chave de agrupamento que sobrevive ao desfazer.** A mais sutil das três de
§3.15: o próximo passo com a mesma chave substitui o estado que o desfazer acabou
de restaurar, e o desfazer seguinte pula um estado inteiro. Só aparece na
sequência ajustar → desfazer → ajustar, que ninguém testa por acaso.

**Seleção sobrevivendo a um desfazer.** O id do texto é o maior da lista mais um
(§3.12), então apagar um texto devolve o crachá para o próximo. Uma seleção que
atravessa o desfazer passa a apontar para outro texto, e o Delete seguinte apaga
o errado. Soltar a seleção em todo desfazer é mais barato que rastrear a
identidade pelo histórico inteiro.

**Caixa de texto vazia contando como edição.** Tocar a imagem e desistir de
digitar deixa um objeto na lista. Se `intocada` olhar "a lista está vazia" em vez
de "algum objeto marca a imagem", concluir recomprime a foto, joga o EXIF fora e
troca o nome do arquivo sem uma única marca visível (§3.6).

**Texto que vaza pela borda.** `measureText` só é chamado se alguém o chamar: sem
remedir a cada tecla e prender de volta, uma frase escrita perto da borda cresce
para fora da foto, e o pedaço de fora simplesmente não vai no envio. O operador
não vê o que perdeu — vê uma frase que acaba antes do fim.

**Prender a âncora em vez da pegada.** Num texto escrito com o quadro girado, a
caixa se estende *para cima* a partir da âncora (§3.13). Prender a âncora dentro
da imagem deixa a metade de cima do texto do lado de fora, e a conta parece certa
o tempo todo — até alguém escrever numa foto girada.

**A régua de tamanho mentindo ao selecionar.** Selecionar um texto criado no
nível 6 com a régua marcando 3 faz o primeiro arrasto dela encolher a frase para
um tamanho que ninguém pediu. Sincronizar a régua com o objeto selecionado é uma
linha; descobrir por que "a régua está mexendo sozinha" é uma tarde.

**A régua saturando depois de um recorte apertado.** Aresta conhecida, e é
consequência direta de §4.4: o corpo é fração do que está à vista. Recortar para
um terço da imagem faz um texto de nível 3 passar a valer nível 9 naquela vista,
a régua satura em 6, e o entalhe abaixo dela muda o corpo em quase metade. Não é
erro de conta — é a mesma escala relativa que faz a caneta parecer constante —,
mas o operador que mexer na régua depois de um recorte forte vai ver um salto.
Desfazer devolve. Se isso incomodar no seu caso, a saída é medir o corpo contra a
base em vez da saída, aceitando que a letra deixa de ser constante para quem olha.

**O foco mandado no mesmo tique da seleção.** O campo de digitação só deixa de
estar desabilitado depois que a seleção chega ao render, e elemento desabilitado
não recebe foco. Quem chama `focus()` dentro do próprio manipulador escreve no
vazio — e o pior é que **um teste em jsdom pode não pegar**: se houver um
`focus()` agendado por outra ação ainda pendente na fila de microtasks, ele chega
durante a espera do teste e dá o foco ao campo por conta própria, mascarando o
defeito. Drene a fila antes de afirmar.

**A alça deixada para trás pelo recorte.** Um texto que o recorte jogou para fora
some do desenho, como qualquer tinta cortada — mas se a alça continuar sendo
renderizada, ela vira um `<button>` invisível (a camada tem `overflow: hidden`)
que o Tab ainda alcança, e um Delete ali apaga um texto que ninguém vê.

**Duas caixas no mesmo pixel.** Toda a conta da inserção é determinística, então o
botão de criar sem mouse larga a segunda caixa exatamente sobre a primeira, com as
alças sobrepostas e sem nada que as distinga na tela. Uma escada de uma linha
resolve — medida na tela, senão numa foto girada ela anda para o lado.

---

## Referências no código deste projeto

Para quem tiver acesso a este repositório:

- `web/apps/dashboard/src/ui/imageAnnotation.ts` — a lógica pura de §5.1
- `web/apps/dashboard/src/ui/ImageAnnotator.tsx` — o componente de §5.2
- `web/apps/dashboard/src/ui/imageAnnotation.test.ts` — testes da aritmética
- `web/apps/dashboard/src/ui/InboxImageEditor.test.tsx` — caminho completo, do
  arquivo que entra ao `File` que sai
- PR #56 (o editor), PR #62 (a tela de composição que o hospeda), PR #71
  (recorte e giro) e PR #104 (texto, e a lista de traços virando lista de
  objetos)
