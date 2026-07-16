# Supabase domain RPCs

`20260715000100_chatpro_domain_rpcs.sql` versiona RPCs `chatpro_*` para contatos com tags, pipeline padrão, movimentação/tags/notas de lead, opt-out, campanhas com destinatários/preparação e settings atômicos.

Cada RPC recebe e valida `workspace_id`, verifica vínculos no mesmo workspace e usa `security invoker`. `PUBLIC`, `anon` e `authenticated` não recebem execução; apenas `service_role`. Leituras e mudanças de uma tabela continuam via queries diretas. SQLite continua o provider padrão e o smoke remoto segue pendente.
