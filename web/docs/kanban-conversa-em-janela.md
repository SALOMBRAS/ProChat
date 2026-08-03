# Abrir a conversa a partir de um card do Kanban

**03/08/2026.** Duplo clique num card abre a conversa por cima do quadro. Este
documento registra as duas decisões que não são óbvias: **qual formato de
janela** e **o que exatamente é reaproveitado da Inbox**.

---

## 1. Sobreposição, e não painel lateral nem janela arrastável

As três opções foram consideradas contra o que o operador quer: **voltar rápido
para o quadro**.

| | a favor | contra |
|---|---|---|
| **Painel lateral** | o quadro continua visível | o Kanban é **horizontal**; a gaveta encolhe justamente as colunas que estão sendo lidas, e num quadro de seis etapas isso custa uma coluna inteira |
| **Janela arrastável** | dá para posicionar e comparar | arrastar, redimensionar, ordem de empilhamento e foco viram código permanente; e em tela de notebook ela acaba cobrindo o quadro do mesmo jeito |
| **Sobreposição centrada** | `Esc` fecha; nada a manter | esconde o quadro enquanto está aberta |

**Escolhida: a sobreposição.** O pedido "voltar rápido ao quadro" é um problema
de **fechar**, não de ver as duas coisas ao mesmo tempo — e fechar é onde a
sobreposição ganha das outras duas: uma tecla, sem reflow de coluna nenhuma.

O quadro **continua montado** por trás. Fechar não recarrega o Kanban, não refaz
os `GET`s por etapa e não perde a rolagem horizontal.

Se a operação pedir depois "ler a conversa **e** mexer no quadro ao mesmo
tempo", a decisão muda — e aí o painel lateral é o candidato, não a janela
arrastável.

## 2. O que é reaproveitado, e o que impedia reaproveitar

O `Inbox` **não** era montável dentro de uma janela como estava. Três coisas
impediam:

1. **A seleção vinha da URL, não de parâmetro.** `conversationIdFromLocation()`
   mais um ouvinte de `popstate` decidiam qual conversa mostrar. Abrir um card
   teria de mexer na barra de endereço, e a rota do Kanban se perderia.
2. **Ele sempre renderiza a própria lista** e carrega uma página de 50 conversas
   ao montar. Sobre o quadro isso é a UI errada e uma lista carregada à toa.
3. **É um componente de 1.500 linhas sem peça separável**: composição, anexos,
   editor de imagem, áudio, câmera, notas e painel do cliente moram todos dentro
   dele.

O que **não** impedia: o `InboxKanban` já é renderizado **de dentro** do `Inbox`
(`view === "kanban"`), então todo o estado da conversa já está no escopo certo.

A correção foi extrair o bloco `inbox-history` — a coluna do meio, 165 linhas —
para uma closure `conversationPane()`, usada nos **dois** lugares. Closure e não
componente de propósito: o painel usa dezenas de estados e manipuladores da
função (`selected`, `messages`, composição, gravação, arrastar-arquivo), e
passá-los por props seria reescrever a fiação para não reescrever a tela.

A extração é **neutra de comportamento** — os 487 testes do dashboard passaram
sem alteração antes de qualquer coisa nova ser acrescentada.

### Abrir sem sair da rota

`openConversation(conversation, false)` já existia: o `false` pula o
`history.pushState`. É o mesmo caminho do deep link, menos a barra de endereço.

A conversa vem da página já carregada quando estiver lá, e **por `id`** quando
não estiver — nunca por varredura de páginas. São 630 cartões contra 50
conversas por página; procurar percorrendo seria a regra crítica nº 4 do
`CLAUDE.md`.

### A armadilha que isso criou

Quem chega ao quadro **vindo da Inbox com uma conversa aberta** ainda tem o
`conversationId` na URL. Abrir um card limpa a seleção — e era exatamente esse o
gatilho para o efeito do deep link reabrir a conversa **da URL** por cima da que
o operador clicou. A guarda é uma linha, e tem caso de teste próprio.

## 3. Teclado

O card é `article` arrastável, o que já era inacessível por natureza. Abrir não
precisava ser: com o gancho de abrir presente, o card ganha `tabIndex`,
`role="button"`, rótulo, e responde a `Enter` e `Espaço`. `Esc` fecha a janela, o
foco entra nela ao abrir e volta para o card ao fechar.

Sem o gancho — `InboxKanban` renderizado solto — o card continua sendo só um card
arrastável, sem foco nem rótulo. Há caso de teste para isso também, senão os
outros passariam por acidente.

## 4. O que este trabalho não faz

- **Não foi conferido em tela.** A extensão do Chrome está proibida neste
  repositório (`CLAUDE.md`), e o que existe é prova por teste e leitura de CSS:
  a sobreposição, o `Esc`, o foco, o reaproveitamento do painel e a rota
  intacta. **Como fica visualmente — largura, altura, o painel da Inbox solto
  fora do grid de três colunas — é conferência sua.**
- **Não muda o título do card**, que ainda mostra o JID mascarado.
- **Uma janela por vez.** Abrir outro card troca a conversa da mesma janela.
