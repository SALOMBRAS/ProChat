# Plano de modificações

## Prioridade 1 — higienizar a distribuição

1. Fazer cópia integral e backup das sessões/dados antes de qualquer alteração.
2. Remover o iframe oculto de `build/index.html` que chama `c-ut.com`.
3. Remover `build/For More Cracked Software.url` e a pasta `build/iNFo/`.
4. Substituir o título adulterado de `index.html` por um título oficial.
5. Verificar procedência e malware de todos os binários/instalador antes de distribuir.

## Prioridade 2 — rebranding consistente

Atualizar em conjunto `package.json`, `build/config/app.config.js`, `build/config/reseller-config.{js,json}`, `build/index.html`, `build/manifest.json`, logos e `build/locales/*.js`. Testar nome de diretório de dados/migrações para não perder sessões existentes.

## Prioridade 3 — recuperar manutenibilidade

1. Obter o fonte React/Electron original e seu lockfile.
2. Criar scripts `dev`, `build` e `test` no `package.json`.
3. Separar handlers IPC do enorme `electron.js` por domínio.
4. Gerar tipos/contrato para `electronAPI`.
5. Versionar as migrações SQLite e testar backup/restauração.

## Prioridade 4 — segurança

- Restringir `database.query`, filesystem e abertura externa a listas permitidas.
- Manter `contextIsolation` e validar todos os argumentos IPC.
- Revisar CSP: `unsafe-inline`/`unsafe-eval` e scripts CDN aumentam o risco.
- Proteger chaves de IA, SMTP e proxy fora do bundle e fora do banco em texto simples.

## Classificação final

| Classe | Arquivos/áreas |
|---|---|
| Críticos | `package.json`, `electron.js`, `preload.js`, `index.html`, `static/`, `services/`, `models/`, `config/`, migrações e imagens referenciadas |
| Opcionais/modificáveis | manifest, tema, logos, locales, configuração de revenda, módulos de produto que não sejam usados após auditoria |
| Descartáveis | atalhos `.url` de conteúdo não relacionado e iframe externo oculto; são indícios de adulteração |

## Checklist de rebranding

- [x] Nome do app alterado em todos os arquivos textuais da distribuição
- [ ] Logo substituída
- [ ] Favicon substituído
- [ ] Ícones substituídos
- [x] Arquivos suspeitos removidos
- [x] Iframe externo removido
