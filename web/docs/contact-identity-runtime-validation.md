# Validação de runtime — identidade atômica de contatos

Data: 2026-07-23 (America/Sao_Paulo)
Project ref: `vhfixhqfwusobczmubfu`
Commit validado: `e70e0fa`

## Ambiente

O runtime oficial `npm run dev:waha` foi iniciado localmente com API em
`127.0.0.1:3000`, worker interno em `127.0.0.1:3101` e dashboard em
`127.0.0.1:5173`. A API retornou healthcheck saudável, o dashboard respondeu
HTTP 200 e a sessão WAHA já existente estava conectada.

O provider remoto é Supabase: a Inbox retornou dados do workspace configurado,
a RPC `public.chatpro_resolve_contact_identity(text, text, text, jsonb, text)`
estava presente e o resolver `SupabaseContactIdentityResolver` usa essa RPC
para o webhook inbound e para a sincronização de identidade WAHA.

## Casos executados

- **Inicialização e sincronização WAHA:** executadas. Os logs registraram
  sincronizações de identidade direta e eventos `conversation.updated`/
  realtime, sem `23503`, `PGRST202`, `PGRST205`, erro 500 ou chave duplicada.
- **Inbound de contato existente:** não foi artificialmente gerado, para não
  criar ou alterar mensagens de produção. O caminho real de sincronização de
  identidades foi exercitado pelo runtime; o fluxo inbound usa o mesmo
  resolver RPC antes do upsert de conversa.
- **LID:** nenhum LID pendente estava presente no banco no momento da consulta.
  Não foi fabricado evento; a regra permanece validada pela RPC e pelos testes.
- **Grupo:** havia conversas de grupo no workspace. Nenhuma tinha `contact_id`
  e nenhum identificador `@g.us` estava associado a contato.
- **Outbound:** não executado. Não havia contato de teste explicitamente
  autorizado; nenhuma mensagem foi enviada.
- **Evento duplicado:** não reprocessado contra dados remotos para evitar criar
  eventos sintéticos persistentes. A cobertura automatizada permanece verde.

## Integridade remota

Consultas agregadas, sem expor dados pessoais, retornaram zero para:

- aliases apontando para contatos inexistentes;
- identificadores duplicados no mesmo workspace;
- telefones duplicados no mesmo workspace;
- identificadores de grupo associados a contatos;
- conversas de grupo com contato direto.

Não houve `23503` nem duplicidade não tratada nos logs do runtime. Não foram
executados `DELETE`, `TRUNCATE`, merge, backfill ou limpeza de dados.

## Limitações

Uma validação completa de inbound/outbound exige um chat de teste autorizado.
Como o runtime estava conectado a dados reais e essa autorização não estava
disponível, a validação foi limitada a healthcheck, sessão, Inbox, sincronização
real de identidade, inspeção do caminho RPC, integridade agregada e testes
automatizados. Nenhuma correção de código foi necessária.
