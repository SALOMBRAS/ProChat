# PROMPT K3 — PR-T4: Documentos, Arquivos e Links

## ⚠️ REGRAS ABSOLUTAS (leia antes de tudo)
1. **Workspace:** `C:\Projeto Salo\ChatPro\ChatPro Main`
2. **Git:** já deu `git pull` de `https://github.com/SALOMBRAS/ProChat` — branch `feat/replace-repository-with-chatpro`, working tree atualizada.
3. **SUPABASE:** usar SEMPRE e APENAS as credenciais do `.env` / `.env.local` do projeto local. NUNCA acesse, modifique ou execute operações em qualquer instância Supabase externa, cloud ou cadastrada em você mesmo.
4. **NÃO criar migrations, NÃO alterar schema, NÃO aplicar SQL remoto** sem solicitação explícita.
5. **Terminar sempre com:** `npm run typecheck` + `npm test` + `npm run build` + `git diff --check`.
6. O projeto usa TypeScript, React 18/Vite, Express 5, Zod, Vitest, WebSocket, Supabase e `better-sqlite3`. Monorepo em `web/` (npm workspaces).
7. Leia `CLAUDE.md` na raiz antes de qualquer alteração.

---

## 📋 Contexto da Feature

A feature **T4 — Documentos, Arquivos e Links** está **~90% completa**. Código e testes unitários **concluídos e verificados**; faltam validação manual E2E, build raiz, auditoria final, update de doc auxiliar e **um SQL manual do usuário**.

### O que foi entregue
1. **Documento de qualquer formato** — enviar qualquer arquivo até 50 MB, mimetype correto
2. **Cartão de documento rico** — etiqueta por tipo real, miniatura nativa do WhatsApp, ações de abrir/visualizar/baixar
3. **Links vivos** — URLs viram âncoras clicáveis; primeiro link ganha cartão de prévia
4. **Upload com barra de progresso** — via XHR real com `onprogress`
5. **Prévia de texto** — MD/JSON/CSV/XML visualizáveis inline
6. **GIF como documento** — colar/arrastar GIF anexa como documento (não recusado)

### Estado atual (conforme documento)
- Contracts: typecheck 0 erros, 5/5 testes ✓
- API: 493 testes passando (exceto 11 falhas estrangeiras de outro WIP) ✓
- Worker: 92/92 testes ✓
- Dashboard: `tsc --noEmit` limpo; 33 arquivos, **654/654 testes** ✓
- `git diff --check` limpo ✓

---

## 📖 Documento de Contexto Completo

Leia INTEIRO o arquivo antes de qualquer ação:
**`C:\Users\Salombras\Downloads\PR-T4-documentos-links.md`**

Este documento contém:
- §1: Visão geral da feature
- §2: Arquitetura de ponta a ponta
- §3: Análise de riscos e decisões
- §4a: Arquivos T4 (implementação completa)
- §4b: Arquivos estrangeiros (WIP de outras features — NÃO TOCAR)
- §5: Envio de documentos (policy, magic bytes, mime canônico, staging)
- §6: Recebimento de documentos (classificação, renderização, ações)
- §7: Prévia de links (nativa → retaguarda OG/oEmbed, cache, SSRF)
- §8: Links vivos no texto (linkify, segurança)
- §9: Estilos e acessibilidade
- §10: Worker e WAHA
- §11: Cache e performance
- §12: Testes (cobertura completa)
- §13: **Pendências — o que falta fazer**
- §14: Supabase (somente leitura/uso existente)
- §15: Roteiro de validação manual em localhost
- §16: Estado final e próximos passos

---

## ✅ O que você deve fazer (em ordem)

### 1. Aplicar SQL manual obrigatório (§14.3 do T4)
```sql
UPDATE storage.buckets SET allowed_mime_types = NULL
WHERE id = 'chatpro-temporary-attachments';
```
**Este SQL deve ser executado no SQL Editor do Supabase do projeto correto** (confirmar URL/keys do `.env.local`). Sem isso, documentos ZIP e formatos novos falham com 503 opaco. O agente NÃO pode executar SQL no Supabase — entregue o SQL ao usuário.

### 2. Coordenar com WIP estrangeiro (§16.3.1)
O working tree contém WIP de outras features ("openConversation/Conversar", "message reactions", "contact sync") que quebra o typecheck de API+worker. Verificar se essas features já foram mergeadas após o `git pull`. Se sim, o typecheck pode já estar limpo. Se não, documentar o estado.

### 3. Rodar `npm run build` na raiz (§16.3.2)
Validar que contracts+dashboard compilam. Esperado: API/worker podem falhar por causa alheia se o WIP estrangeiro ainda não foi resolvido.

### 4. Auditoria técnica final (§16.3.3)
Uma passada sobre todos os arquivos da §4a buscando: gargalos, duplicações, código morto, concorrência, regressões.

### 5. Atualizar `docs/anexos-pendencias.md` (§16.3.4)
O §1 (ZIP no bucket) muda de natureza — registrar a saída escolhida (SQL manual) e quem a executa.

### 6. Validação manual em aparelho real (§15)
Seguir o roteiro completo de §15: envio/recebimento de documentos, download, links e prévias, casos de erro, bordas.

### SEMPRE:
- Validar: typecheck → testes → build → `git diff --check`
- Reportar: o que funcionou, o que falhou, o que está pendente

---

## 🚨 Atenções Especiais

- **Este é um documento de PASSAGEM, não de IMPLEMENTAÇÃO.** O código T4 já está escrito e testado. O trabalho agora é **validação, build, auditoria e SQL manual**.
- O working tree contém código de **múltiplas features paralelas** (T4 + reações + contatos + etc.). A seção §4b lista EXATAMENTE quais arquivos são estrangeiros — **não os toque**.
- O SQL manual do §14.3 é **bloqueante para produção** — sem ele, o sistema aceita arquivos mas o bucket recusa com 503 opaco.
- As falhas de teste "estrangeiras" (11 no API) são do WIP "openConversation/Conversar" — não do T4. Não tente consertá-las a menos que tenha mergeado.
- Cache de prévia é em memória (não persiste entre restarts) — comportamento deliberado.
- Prévia nativa depende do WhatsApp gerar; ausência é estado normal — fallback OG cobre.

---

## 📁 Referências rápidas

- Documento completo: `C:\Users\Salombras\Downloads\PR-T4-documentos-links.md`
- CLAUDE.md (regras do projeto): `C:\Projeto Salo\ChatPro\ChatPro Main\CLAUDE.md`
- Diretório do projeto: `C:\Projeto Salo\ChatPro\ChatPro Main\web`
- Doc de pendências: `C:\Projeto Salo\ChatPro\ChatPro Main\web\docs\anexos-pendencias.md`
