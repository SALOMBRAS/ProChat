# Usuários e equipes do workspace

ChatPro diferencia operadores internos de contatos do WhatsApp. Operadores pertencem a um `workspace`, têm função (`owner`, `admin`, `manager` ou `agent`) e status (`active`, `invited` ou `disabled`). Usuários com histórico nunca são removidos: desative-os para impedir novas atribuições sem alterar eventos e conversas já registradas.

Em **Equipe** no dashboard, owners e admins criam operadores e equipes, ativam/desativam registros e administram membros. Um gestor líder de uma equipe também pode administrar os membros da própria equipe. Uma equipe inativa e um operador desativado não aparecem para novas atribuições na Inbox.

Os endpoints ficam sob `/api/v1/workspace/users` e `/api/v1/workspace/teams`. Todas as consultas e mutações são filtradas por `x-workspace-id`; uma conversa só aceita usuário/equipe daquele workspace. Cada mudança de atribuição continua sendo registrada em `conversation_events` e publicada em realtime.

## Desenvolvimento sem autenticação

Enquanto a autenticação real não estiver conectada, configure `CHATPRO_DEVELOPMENT_USER_ID` com o UUID de um operador de desenvolvimento. Na primeira operação desse UUID em cada workspace, o backend cria somente esse operador temporário como `owner`; outros usuários devem ser criados pelo diretório. Não use este fallback em produção e não exponha credenciais de service role ao frontend.

O modelo já contém `assigned_team_id`, membros de equipe e funções para sustentar filas, round robin e distribuição automática em uma etapa futura. Esses mecanismos não são executados por esta entrega.
