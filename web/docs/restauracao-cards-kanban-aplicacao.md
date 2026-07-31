# Restaurar os 504 cards de Kanban apagados

Procedimento para desfazer o `DELETE` executado no SQL Editor em 31/07/2026, que
removeu de `conversation_kanban_state` os cards das conversas de sessão WhatsApp
não listada pela WAHA.

Estado confirmado às 18h47 de 31/07: **127 cards** na tabela, de 631. Faltam
**504**.

## 1. Por que dá para restaurar sem perda

A tabela não tem chave substituta: a chave primária é
`(conversation_id, board_id)`. Isso torna a restauração **idempotente** — rodar
duas vezes não duplica nada, porque a segunda passada não insere linha alguma.

Todas as colunas que importam estão no CSV e são reinseridas como estavam:
`position`, `manual_override`, `last_transition_source`, `last_transition_by`,
`last_transition_at`, `created_at` e `updated_at`. Nenhuma delas é recalculada,
e nenhuma recebe `now()` — se recebessem, a ordem dos cards no quadro e o
histórico de quem os moveu seriam perdidos junto.

As chaves estrangeiras (`board_id`, `stage_id`, e o par
`workspace_id, conversation_id`) exigem que quadro, etapa e conversa ainda
existam. Nenhuma conversa foi apagada — 658 antes, 658 agora —, então a
inserção deve entrar inteira.

## 2. Gerar o SQL

O gerador lê o CSV **por nome de coluna**, não por posição, então a ordem em que
o export as colocou não importa. Se faltar qualquer coluna obrigatória ele para
e diz qual: restaurar pela metade seria pior que não restaurar.

A partir de `web/`:

```bash
node docs/restauracao-cards-gerador.mjs /caminho/para/cards.csv > /tmp/restaurar.sql
```

Ele não toca em banco nenhum — lê o CSV e escreve SQL. Confira o cabeçalho do
arquivo gerado: a primeira linha diz quantos cards ele vai restaurar, e esse
número **tem que ser 504**. Se vier outro, pare e descubra por quê antes de
executar.

## 3. Executar

Abra `/tmp/restaurar.sql`, cole no SQL Editor do Supabase e rode. O arquivo já
vem com `BEGIN`/`COMMIT` e três conferências embutidas:

| conferência | resultado esperado |
|---|---|
| `antes` | 127 |
| `depois` | 631 |
| `cards_sem_conversa` | 0 |

Se `depois` não for `antes + 504`, alguma linha bateu no `ON CONFLICT` — ou seja,
o card já existia — ou a chave estrangeira recusou. Nos dois casos, **não faça
`COMMIT`**: rode `ROLLBACK` e investigue.

## 4. Conferir na aplicação

Depois do `COMMIT`, o quadro tem de voltar a mostrar 631 cards, sendo 628 na
etapa "Novo". Pela API:

```bash
curl -s http://127.0.0.1:3000/api/v1/inbox/kanban/boards \
  -H 'x-workspace-id: default-workspace' \
  -H 'x-user-id: 00000000-0000-4000-8000-000000000001'
```

O KPI de conversas do painel não muda: ele conta `conversations`, que não foi
tocada.

## 5. Depois de restaurar: não repita o DELETE como estava

O `DELETE` original selecionava os cards cuja conversa está numa sessão que a
WAHA não lista. Isso incluía **499 cards da sessão `chatpro-42217e8d…`**, que o
worker declara como **alias** da sessão viva — conversas que continuam
alcançáveis e respondíveis. Ver `sessao-inativa-validacao-investigacao.md`.

Genuinamente órfãos são **5**, da sessão `chatpro-a14338b9…`.

## 6. O que este documento não faz

- Não executa nada. O `COMMIT` é seu.
- Não reconstrói o CSV: as colunas `position`, `created_at` e
  `last_transition_at` não são deriváveis do estado atual, e é por isso que o
  export prévio é insubstituível. **Guarde-o até a conferência da seção 4
  passar.**
- Não trata o caso de o CSV ter menos de 504 linhas. Se tiver, o que faltar
  ficou perdido, e a única reconstrução possível seria pelo reparo
  `POST /api/v1/inbox/kanban/backfill` — que recria o card com `position` nova,
  `manual_override` falso e datas de agora. Recupera a presença no quadro, não a
  história.
