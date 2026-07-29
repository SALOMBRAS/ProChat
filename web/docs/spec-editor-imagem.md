# Editor de imagem antes do envio — especificação portável

Escrito para quem vai implementar o mesmo recurso em outro sistema, sem acesso a
este código. Descreve o que foi construído nas PRs #56 (o editor) e #62 (a tela
que o hospeda), por que cada decisão foi tomada, e o que quebra se for feito sem
cuidado.

Onde a decisão foi arbitrária, está escrito que foi arbitrária. Onde há número
medido, a medição está junto.

---

## 1. O que faz

O operador marca uma foto a caneta antes de enviá-la: escolhe a imagem, rabisca
por cima para circular ou apontar alguma coisa, e manda. Não é edição de imagem —
é um marcador sobre uma foto, do jeito que o WhatsApp faz.

### Fluxo do ponto de vista do operador

1. Escolhe uma imagem — pela câmera, pelo seletor de arquivos, colando ou
   arrastando. Tanto faz de onde veio.
2. A imagem aparece grande, com uma barra de ferramentas.
3. Clica em **Editar**. O preview dá lugar ao painel de marcação: a imagem, uma
   paleta de cores, um controle de espessura, e os botões desfazer, refazer,
   descartar e concluir.
4. Desenha com o mouse, o dedo ou a caneta.
5. **Concluir** fecha o painel e volta ao preview, agora com o traço aplicado.
6. Escreve uma legenda (opcional) e envia.

Em qualquer ponto ele pode **descartar a edição** e voltar à imagem como ela
entrou, ou fechar tudo sem enviar.

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
type EditorProps = {
  file: File;                                    // sempre o arquivo ORIGINAL
  initialStrokes?: Stroke[];                     // traços de uma edição anterior
  onCancel: () => void;                          // fechar sem aplicar
  onConfirm: (edited: File, strokes: Stroke[]) => void;
};
```

Devolver os traços junto do arquivo é o que permite reabrir a edição sem empilhar
perda de qualidade — ver §3.5.

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

### 3.5 Reeditar parte sempre do original

**Problema:** JPEG é compressão com perdas. Reexportar um JPEG que já foi
reexportado acumula artefato a cada rodada — a chamada perda geracional. Se o
operador abrir o editor três vezes, a foto passou por três compressões.

**Solução:** o editor recebe sempre o arquivo **como foi escolhido**, e os traços
já aplicados voltam por `initialStrokes`. Ao confirmar, o desenho inteiro é
repintado sobre o original e exportado **uma vez**.

Quem chama guarda dois estados:

```ts
attachmentSource  // o File como entrou. Nunca muda até trocar de anexo.
attachmentStrokes // os traços aplicados. A memória da edição.
attachment        // o File que vai ser enviado (o exportado, ou o próprio source)
```

Consequências:

- Abrir o editor pela quinta vez ainda parte do original: **uma** recodificação,
  não cinco.
- O desenho anterior reaparece, então reabrir não perde trabalho.
- "Descartar edição" volta à imagem original de verdade, não a um estado
  intermediário já achatado.
- Trocar o anexo tem de limpar os traços junto, senão o desenho de uma foto
  reaparece sobre a próxima.

Os traços ficam em coordenadas do canvas já reduzido. Como a redução é
determinística para o mesmo arquivo, reabrir reconstrói exatamente o mesmo
desenho.

### 3.6 Confirmar sem traço devolve o `File` intocado

Se não houver nenhum traço, **não exporte**. Devolva o mesmo objeto `File` que
entrou.

Sem isso, abrir o editor e fechar no "Concluir" recodificaria a imagem por nada:
perderia qualidade, perderia o EXIF (que aqui não interessa a ninguém, já que a
foto não foi marcada) e trocaria o nome do arquivo. O operador não fez nenhuma
edição; o arquivo não deve mudar.

É uma linha de código e evita uma classe inteira de surpresa.

### 3.7 `minmax(0, 1fr)` na célula do preview

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

O ponteiro dá coordenadas de viewport; o canvas desenha nas suas próprias, que são
as da imagem já reduzida. Sem converter, o traço sai deslocado e com espessura
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

### 4.4 Espessura proporcional

A espessura é fração do lado maior da imagem, não um número fixo de pixels de
canvas. Com valor fixo, o mesmo nível sai grosso numa imagem de 600 px e vira fio
de cabelo numa foto de 12 MP.

```
espessura(nível, ladoMaior) = max(2, arredondar(ladoMaior * limitar(nível,1,6) / 260))
```

Como a imagem é sempre mostrada na mesma largura, proporcional à imagem quer dizer
**constante para quem olha**.

**O divisor 260 é calibração arbitrária.** Foi escolhido para que o nível 3 desse
cerca de 1,2% do lado maior, o que pareceu certo a olho. Não houve medição da
caneta do WhatsApp nem de nenhuma outra referência — se ficar fino ou grosso
demais no seu caso, mexa no divisor sem cerimônia. A faixa de 1 a 6 níveis também
é arbitrária.

### 4.5 Repintura e histórico

Guarde os traços como **lista de objetos**, não como snapshots de pixels:

```ts
type Ponto  = { x: number; y: number };
type Traço  = { cor: string; espessura: number; pontos: Ponto[] };
```

Repintar é sempre: fundo branco → imagem → cada traço na ordem. Desfazer e refazer
são fatias dessa lista.

Guardar `ImageData` por passo custaria, num canvas de 5 MP, **20 MB por nível de
histórico**. A lista de traços custa alguns kilobytes.

A repintura completa a cada `pointermove` é simples e sempre correta. A 2560 px é
um *blit* de ~5 MP, que o navegador faz bem abaixo de um quadro. Se aparecer
engasgo com muitos traços em máquina fraca, o próximo passo é desenhar só o trecho
novo durante o arrasto — mas comece pelo simples.

---

## 5. Implementação de referência

Código real, em React + TypeScript. **Leia a seção §5.3 antes de copiar**: parte
disto é específica deste projeto.

### 5.1 A lógica pura — portável inteira

```ts
export type Point  = { x: number; y: number };
export type Stroke = { color: string; width: number; points: Point[] };
export type Size   = { width: number; height: number };

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

/** §4.5 — repintura completa: fundo, imagem, traços na ordem. */
export const renderAnnotation = (
  context: CanvasRenderingContext2D,
  image: CanvasImageSource | undefined,
  strokes: readonly Stroke[],
  size: Size,
): void => {
  context.save();
  context.fillStyle = ANNOTATION_BACKDROP;
  context.fillRect(0, 0, size.width, size.height);
  if (image) context.drawImage(image, 0, 0, size.width, size.height);
  for (const stroke of strokes) tracePath(context, stroke);
  context.restore();
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
export function ImageAnnotator({ file, initialStrokes = [], onCancel, onConfirm }: {
  file: File;                      // §3.5 — SEMPRE o original
  initialStrokes?: readonly Stroke[];
  onCancel: () => void;
  onConfirm: (edited: File, strokes: Stroke[]) => void;
}) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const imageRef   = useRef<CanvasImageSource>();
  const sizeRef    = useRef<Size>({ width: 0, height: 0 });
  const liveRef    = useRef<{ pointerId: number; stroke: Stroke }>();
  // Os manipuladores de ponteiro leem o histórico durante o arrasto, quando o
  // estado do React ainda não repassou: a referência é a lista corrente.
  const strokesRef = useRef<Stroke[]>([...initialStrokes]);

  const [strokes, setStrokes] = useState<Stroke[]>(() => [...initialStrokes]);
  const [undone,  setUndone]  = useState<Stroke[]>([]);
  const [color,   setColor]   = useState(PEN_COLORS[0].value);
  const [level,   setLevel]   = useState(3);
  const [ready,   setReady]   = useState(false);
  const [notice,  setNotice]  = useState("");
  const [busy,    setBusy]    = useState(false);

  const repaint = useCallback((live?: Stroke) => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    renderAnnotation(context, imageRef.current,
      live ? [...strokesRef.current, live] : strokesRef.current, sizeRef.current);
  }, []);
  const commit = useCallback((next: Stroke[], nextUndone: Stroke[]) => {
    strokesRef.current = next; setStrokes(next); setUndone(nextUndone);
  }, []);

  // §3.2 — HTMLImageElement aplica a orientação do EXIF ao decodificar.
  useEffect(() => {
    let cancelled = false;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const fitted = fitWithin(image.naturalWidth || image.width, image.naturalHeight || image.height);
      canvas.width = fitted.width; canvas.height = fitted.height;
      imageRef.current = image;
      sizeRef.current = { width: fitted.width, height: fitted.height };
      setNotice(fitted.reduced
        ? `Imagem reduzida para ${fitted.width}×${fitted.height} px na edição.` : "");
      setReady(true);
      repaint();
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
  }, [file, repaint]);

  // Desfazer, refazer e descartar mudam a lista inteira: repintar do zero.
  useEffect(() => { repaint(); }, [strokes, repaint]);

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    // button > 0 é botão do meio/direito; toque e caneta chegam com 0.
    if (!canvas || !ready || busy || event.button > 0) return;
    event.preventDefault();
    capturePointer(canvas, event.pointerId, true);
    const longest = Math.max(sizeRef.current.width, sizeRef.current.height);
    liveRef.current = {
      pointerId: event.pointerId,
      stroke: { color, width: penWidth(level, longest),
                points: [canvasPoint(canvas, event.clientX, event.clientY)] },
    };
    repaint(liveRef.current.stroke);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current, canvas = canvasRef.current;
    if (!live || !canvas || live.pointerId !== event.pointerId) return;
    event.preventDefault();
    for (const s of pointerSamples(event))                       // §4.2
      live.stroke.points.push(canvasPoint(canvas, s.clientX, s.clientY));
    repaint(live.stroke);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current;
    if (!live || live.pointerId !== event.pointerId) return;
    liveRef.current = undefined;
    if (canvasRef.current) capturePointer(canvasRef.current, event.pointerId, false);
    // Traço novo apaga o refazer: manter a pilha traria de volta um traço que
    // já não pertence ao desenho atual.
    commit([...strokesRef.current, live.stroke], []);
  };

  const undo = () => {
    const cur = strokesRef.current;
    if (!cur.length) return;
    commit(cur.slice(0, -1), [...undone, cur[cur.length - 1]]);
  };
  const redo = () => {
    if (!undone.length) return;
    commit([...strokesRef.current, undone[undone.length - 1]], undone.slice(0, -1));
  };
  const discard = () => commit([], []);   // §3.5 — volta ao original

  const confirm = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !ready || busy) return;
    // §3.6 — sem traço não há o que reexportar.
    if (!strokesRef.current.length) { onConfirm(file, []); return; }
    setBusy(true);
    try {
      const outcome = await exportAnnotated(canvas, file);
      if (!outcome.ok) { /* mostrar o motivo e o tamanho medido */ return; }
      onConfirm(outcome.file, strokesRef.current);
    } finally { setBusy(false); }
  };

  return (/* canvas + paleta + espessura + desfazer/refazer/descartar/concluir */);
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

CSS mínimo, e as duas propriedades que não são cosméticas:

```css
.editor-canvas {
  width: 100%;
  max-height: 260px;      /* ajuste ao seu espaço */
  object-fit: contain;
  touch-action: none;     /* SEM ISTO o dedo rola a página em vez de desenhar */
  cursor: crosshair;
}
```

### 5.3 O que é específico deste projeto

Não copie sem trocar:

| Item | Por que é específico |
| --- | --- |
| **Paleta de cores** | Seis cores escolhidas por já existirem no tema deste sistema, para o editor não inventar cor nova. As cores em si são arbitrárias; o que vale manter é que cubram foto clara e escura. |
| **Limite de 15 MB** | É a política do servidor **deste** projeto para imagem. Troque pelo do seu. |
| **Allowlist `jpeg/png/webp`** | Idem: é o que o servidor daqui aceita, com checagem de *magic bytes*. |
| **Nome `-editada`** | Convenção local. |
| **Textos em português** | Óbvio, mas está em toda parte no código. |
| **Estrutura do composer** | Onde o editor é montado, quem guarda `attachmentSource` e `attachmentStrokes`, como o anexo pendente é exibido. Nada disso é do editor. |
| **Níveis 1–6 e divisor 260** | Calibração a olho, §4.4. |
| **Teto de 2560 px** | O teto é obrigatório; **o valor** é escolha, §3.3. |

Portável sem alteração: `fitWithin`, `canvasPoint`, `pointerSamples`,
`tracePath`, `renderAnnotation`, `exportPlan`, `exportAnnotated`, o modelo de
histórico, e as decisões de §3.

---

## 6. O que não está incluído

Nada além da caneta livre. Cada item abaixo ficou de fora por ser trabalho
próprio, não por descuido — e cada um exige mais do que parece.

**Recorte.** Exige uma segunda camada de coordenadas: retângulo de seleção com
alças, restrição de proporção, e a decisão de recortar antes ou depois dos traços
(depois obriga a transformar os traços junto). Muda o contrato: a saída deixa de
ter as dimensões da entrada, o que afeta o teto de resolução e o cálculo de
espessura.

**Giro.** Parece trivial e não é: girar 90° troca largura e altura, o que invalida
os traços já feitos a menos que você os transforme. Também interage com a
orientação do EXIF (§3.2) — girar por cima de uma imagem que já veio girada
confunde o operador se a interface não mostrar o estado atual.

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

**Imagem estourando a área com barra de rolagem.** O caso de §3.7. Encontrado na
tela, invisível para teste de DOM.

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

**Traços sobrevivendo à troca de anexo.** Se quem chama não limpar
`attachmentStrokes` ao trocar o arquivo, o desenho de uma foto reaparece sobre a
próxima. É estado de fora do editor, então nenhum teste do editor pega.

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
- PR #56 (o editor) e PR #62 (a tela de composição que o hospeda)
