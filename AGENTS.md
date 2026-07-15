# Instruções operacionais do ChatPro

## Identificação

- Projeto principal: `C:\Projeto Salo\ChatPro\ChatPro Main`
- Remoto: <https://github.com/SALOMBRAS/ProChat.git>
- Cofre local padrão: `C:\Projeto Salo\ChatPro\ChatPro Cofre`
- Remoto do Cofre: <https://github.com/SALOMBRAS/ProChat-Obsidian.git>

Main e Cofre são repositórios Git independentes. Não trate o Cofre como subdiretório, submódulo, subtree, pacote, workspace ou dependência do Main.

## Fluxo obrigatório do Cofre

Antes de qualquer tarefa técnica relevante:

1. Verifique se o Cofre local existe; se não existir, clone `ProChat-Obsidian` no caminho padrão.
2. Se existir, execute `git status` e nunca descarte alterações locais.
3. Se estiver limpo, atualize com `git pull --ff-only`.
4. Abra primeiro `INDEX.md` e leia somente os documentos estritamente relevantes.
5. Não percorra todo o Cofre. Por padrão, abra no máximo dois documentos técnicos além do índice, salvo justificativa expressa no andamento.
6. Use os caminhos indicados no Cofre para localizar o código relevante.

## Atualização do Cofre

Após implementar ou alterar comportamento relevante, atualize os documentos afetados com caminhos reais, funções, componentes, módulos, dependências, impactos cruzados, testes obrigatórios, limitações e riscos. Atualize `INDEX.md` quando criar um documento. Faça commit e push no Cofre separadamente do Main.

## Regras de desenvolvimento

- Execute uma tarefa por vez e não implemente fases futuras.
- Não faça varredura completa do repositório sem necessidade.
- Não adicione dependências sem justificativa.
- Não exponha segredos nem versione sessões do WhatsApp.
- Nunca coloque a chave `service_role` no frontend.
- Não use APIs pagas nem contrate pagamentos sem autorização expressa.
- Mantenha a integração WhatsApp desacoplada; nenhuma aplicação deve importar Baileys fora do adaptador próprio.
- Preserve a compatibilidade futura com aplicativo móvel.
- Execute lint, typecheck, testes e build quando aplicável.
- Não oculte erros apenas para fazer validações passarem.
- Atualize a documentação após mudanças relevantes.
- Mantenha commits do Main e do Cofre separados.

## Kit-MCP

- O Kit-MCP é uma ferramenta auxiliar do Codex e não uma dependência de runtime do ChatPro.
- Consulte o catálogo antes de recriar padrões já disponíveis e use somente recursos relacionados à tarefa atual.
- Priorize skills consultivas e agentes `leve`; respeite o `cost_tier` e justifique antes de acionar agentes ou orquestradores `pesado`.
- O Kit-MCP não substitui decisões, restrições nem documentação do Cofre.
- Não instale nem projete todos os packs. `core` é a seleção inicial; `supabase` fica reservado à fase Supabase; `ui`, à fase visual; os demais exigem necessidade expressa.
- A configuração inicial permite somente o tool MCP consultivo `kit`; não habilite tools de escrita ou auto-install sem autorização e revisão prévias.
- Para repetir a configuração local, use `scripts/setup-kit-mcp.ps1`; não versione `~/.codex/config.toml`, logs, caches, telemetria ou dados de sessão.

Para contexto e decisões detalhadas, consulte o Cofre técnico.
