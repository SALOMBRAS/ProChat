# Mídia indisponível

A WAHA guarda o arquivo por 180 s e o descarta. A mensagem que não foi
persistida dentro dessa janela fica no banco com `mediaPersistenceStatus =
'unavailable'`: registro, legenda e metadados — sem arquivo. O reprocessamento do
histórico traz milhares nesse estado, e eles **não voltam**.

A API converte a ausência em 404 controlado e não deixa erros de stream ou
Promises em segundo plano encerrarem o processo.

## Como a Inbox descobre

**O dashboard não recebe `mediaPersistenceStatus`.** O `InboxMessage` que a API
entrega tem `mediaUrl`, `mediaMimeType`, `mediaFilename`, `mediaSize`, `duration`
e `thumbnailUrl` — e nenhum campo de estado da persistência. Medido na API de
produção em 03/08/2026.

Então quem responde "sumiu de vez" é o proxy de mídia, e a Inbox pergunta a ele:

| passo | resposta medida |
| --- | --- |
| `GET /inbox/messages/:id/media/access` | 200, devolve a URL do proxy |
| `HEAD` nessa URL, arquivo descartado | **404** `Media file not found`, em 0,1 s |
| `HEAD` nessa URL, arquivo guardado | 200, zero byte |

A pergunta é feita **uma vez por mídia e só depois de o elemento já ter
falhado**. Perguntar na montagem seria uma requisição por mensagem de mídia da
conversa — o N+1 que a regra crítica nº 4 proíbe. No caminho feliz o custo é
zero.

`HEAD` e não `GET` porque um `GET` que desse certo baixaria o arquivo inteiro só
para descobrir que ele existe.

## O que o operador vê

Um cartão cinza — não vermelho — dizendo `<tipo> indisponível`, com a frase "O
arquivo não chegou a ser guardado e o WhatsApp já o descartou", e os metadados
que sobreviveram: nome, duração e tamanho. **A legenda continua**, porque quem a
desenha é o balão, não o cartão de mídia.

Cinza é decisão, não estética: o arquivo ter sido descartado é fato sobre o
histórico, e pintar de erro faria o operador procurar defeito no sistema a cada
mensagem antiga.

O tipo é dito pelo nome certo — `Figurinha`, `Mensagem de voz`, `Imagem`,
`Vídeo`, `Áudio`, `Documento` —, porque figurinha não é imagem e nota de voz não
é arquivo de áudio.

### Por tipo

| tipo | como a falha aparece |
| --- | --- |
| imagem, figurinha | `onError` do `<img>`, sem clique |
| vídeo | `onError` do `<video>`, sem clique |
| nota de voz, áudio | `onError` do `<audio preload="metadata">`, sem clique |
| documento | **no primeiro clique** — um link não avisa que o destino sumiu |

Documento é o único sem carga passiva. O primeiro clique é retido, a pergunta é
feita (0,1 s) e ou o cartão vira o aviso, ou o clique é repassado ao próprio link
— que baixa com a semântica nativa do `download`.

## O que não é perda

Status diferente de 404, e erro de rede, continuam sendo falha de agora: o vídeo
volta a dizer "Formato de vídeo inválido ou não suportado" e o áudio, "Não foi
possível reproduzir o áudio agora". Chamar de perdido o que talvez volte apagaria
a diferença entre "tente de novo" e "não há o que tentar".

## Player de áudio

Play/pausa, seek, duração e 1x/1.5x/2x; iniciar outro áudio pausa o anterior.

---

**Pendência conhecida.** O comentário de `reprocess-discarded.service.ts` diz que
`unavailable` "é o estado que a Inbox já sabe representar". Não era: até esta
correção a imagem virava ícone quebrado, o vídeo culpava o formato e o documento
baixava um JSON de 404. Agora a Inbox sabe — mas por dedução, não porque o campo
chegue a ela. Expor `mediaPersistenceStatus` no `InboxMessage` tornaria a
pergunta ao proxy desnecessária, e é mudança de `apps/api/src`.
