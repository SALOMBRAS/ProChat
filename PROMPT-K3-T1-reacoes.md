# PROMPT K3 — PR-T1: Sistema de Reações em Mensagens

## ⚠️ REGRAS ABSOLUTAS (leia antes de tudo)
1. **Workspace:** `C:\Projeto Salo\ChatPro\ChatPro Main`
2. **Git:** já deu `git pull` de `https://github.com/SALOMBRAS/ProChat` — branch `feat/replace-repository-with-chatpro`, working tree atualizada.
3. **SUPABASE:** usar SEMPRE e APENAS as credenciais do `.env` / `.env.local` do projeto local. NUNCA acesse, modifique ou execute operações em qualquer instância Supabase externa, cloud ou cadastrada em você mesmo.
4. **NÃO criar migrations, NÃO alterar schema, NÃO aplicar SQL remoto** sem solicitação explícita.
5. **Terminar sempre com:** `npm run typecheck` + `npm test` + `npm run build` + `git diff --check`.
6. **Não carregue listas inteiras, não percorra páginas para localizar uma conversa** e não introduza N+1 ou polling por item.
7. O projeto usa TypeScript, React 18/Vite, Express 5, Zod, Vitest, WebSocket, Supabase e `better-sqlite3`. Monorepo em `web/` (npm workspaces).
8. Leia `CLAUDE.md` na raiz antes de qualquer alteração.

---

## 📋 Contexto da Feature

A feature **T1 — Reações em Mensagens** está **100% explorada e planejada**, mas a **implementação nesta sessão anterior foi 0%** — NENHUM arquivo foi alterado na sessão que gerou o documento de contexto. No entanto, o `git pull` recente pode ter trazido código de reações de sessões anteriores — **verifique com `grep -ri "reaction" apps/ packages/` antes de começar**.

### Objetivo
Reações a mensagens da inbox (estilo WhatsApp Web): o operador reage com emoji a uma mensagem, a reação vai para o WhatsApp via WAHA, persiste localmente, e aparece em tempo real para todos os operadores do workspace. Reações feitas por contatos chegam por webhook e aparecem na inbox.

### Comportamento esperado (paridade WhatsApp Web)
- Uma reação **por autor** por mensagem: reagir de novo com outro emoji **substitui**; reagir com o mesmo emoji **remove** (toggle).
- Remoção = emoji vazio (`""`) no protocolo WAHA.
- Reações do operador (via dashboard) e do telefone são indistinguíveis no protocolo.

---

## 📖 Documento de Contexto Completo

Leia INTEIRO o arquivo antes de qualquer ação:
**`C:\Users\Salombras\Downloads\PR-T1-reacoes.md`**

Este documento contém:
- §1: Visão geral completa
- §2: Arquitetura e mapa de componentes
- §3: Exploração realizada (não refazer)
- §4: Decisões de design aprovadas
- §5: Mecânica de reações (envio/recebimento/remoção)
- §6: Backend — detalhes técnicos
- §7: Frontend — detalhes técnicos
- §8: Testes — cenários a cobrir
- §9: Pendências e próximos passos
- §10: Supabase (somente leitura)
- §11: Roteiro de testes em localhost

---

## ✅ O que você deve fazer

1. **Verificar estado atual:** rode `grep -ri "reaction" apps/ packages/` para ver se reações já existem no código após o git pull.
2. **Se já existir código de reações:** compare com o documento T1. O que falta? O que está incompleto? Prossiga daí.
3. **Se NÃO existir:** implementar do zero seguindo o plano aprovado no documento T1, na ordem:
   - Contracts (`packages/contracts`)
   - Worker (`apps/worker`)
   - API (`apps/api`)
   - Dashboard (`apps/dashboard`)
   - Testes (de cada camada, conforme §8 do T1)
4. **Validar:** typecheck → testes (contracts, worker, api, dashboard) → build → `git diff --check`.
5. **Reportar:** arquivos alterados, motivos, como testar, limitações conhecidas.

---

## 🚨 Atenções Especiais

- O documento T1 foi gerado quando o working tree tinha **57 arquivos não commitados de sessões anteriores**. Após o `git pull`, a base pode ter mudado. **Revalide todos os números de linha com `Grep` antes de editar.**
- O arquivo `Inbox.tsx` (~1.900 linhas) é disputado por múltiplas features — confirme mtime e processe com cuidado.
- A sessão que gerou o T1 **não alterou nenhum arquivo** — o código de reações que pode existir veio de sessões ANTERIORES ao documento.
- Sempre reutilize a arquitetura existente; nunca crie fluxo paralelo.
- Toda alteração termina com testes.

---

## 📁 Referências rápidas

- Documento completo: `C:\Users\Salombras\Downloads\PR-T1-reacoes.md`
- CLAUDE.md (regras do projeto): `C:\Projeto Salo\ChatPro\ChatPro Main\CLAUDE.md`
- Diretório do projeto: `C:\Projeto Salo\ChatPro\ChatPro Main\web`
