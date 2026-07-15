# ChatPro — análise técnica

Data da análise: 15/07/2026. Esta documentação descreve o conteúdo entregue em `build/`, isto é, uma versão **compilada** do aplicativo, não o projeto-fonte React original.

## Visão geral

ChatPro 3.0.1 é um aplicativo desktop Electron para automação do WhatsApp. O processo principal (`electron.js`) abre a janela e concentra os canais IPC; o preload expõe uma API controlada ao React; os serviços implementam banco SQLite, WhatsApp/Baileys, licenças, campanhas, bots, backups e integrações.

| Camada | Arquivo/local | Responsabilidade |
|---|---|---|
| Empacotamento | `package.json` | metadados, ponto de entrada e dependências |
| Processo principal | `build/electron.js` | janela Electron, ciclo de vida, IPC e orquestração |
| Ponte segura | `build/preload.js` | `window.electronAPI` para o renderer |
| Interface | `build/static/js/main.09f84bf6.js` | bundle React minificado |
| HTML inicial | `build/index.html` | carrega bundle, CSS e tela de carregamento |
| Domínio | `build/services/` | regras de WhatsApp, dados, licença e automação |

## Leitura recomendada

1. [[01-Architecture]]
2. [[03-API-Reference]]
3. [[04-Database-Schema]]
4. [[08-Modification-Plan]]

## Resultado da classificação

- **Críticos:** `package.json`, `build/electron.js`, `build/preload.js`, `build/index.html`, `build/static/`, `build/services/`, `build/models/`, `build/config/` e as migrações de banco.
- **Modificáveis com teste:** marca, textos, ícones, locais, configurações de revenda, CSS/bundle React e serviços isolados.
- **Descartáveis/suspeitos:** `build/For More Cracked Software.url`, tudo em `build/iNFo/` e o iframe externo de `build/index.html`. Removê-los é recomendável; valide a inicialização após a remoção.

> Não há scripts `start`, `build` ou `test` neste `package.json`. Para uma manutenção sustentável, é necessário recuperar/criar o projeto-fonte antes de alterar o bundle minificado.
