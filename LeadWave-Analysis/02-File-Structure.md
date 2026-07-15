# Estrutura de arquivos

```text
ChatPro/
├── package.json
├── build/
│   ├── electron.js                 # processo principal
│   ├── preload.js                  # API IPC exposta ao React
│   ├── index.html                  # bootstrap da interface
│   ├── manifest.json               # metadados PWA
│   ├── static/js/main.09f84bf6.js  # React compilado/minificado
│   ├── static/css/main.a5b05d13.css
│   ├── services/                   # regra de negócio
│   ├── models/                     # Contact, ContactGroup, Template, Session
│   ├── database/migrations/        # 6 migrações SQL
│   ├── locales/                    # ar, en, es, fr, he, pt, ru
│   ├── config/                     # app, revenda e segurança
│   ├── assets/images/              # ativos de marca
│   ├── images/                     # placeholder
│   └── logo*.png, logo.svg, favicon.ico
└── node_modules/
```

Há 81 arquivos não pertencentes a `node_modules`, 64 JavaScript e 6 migrações SQL.

## Marca, nome, textos e tema

| Item | Localização confirmada |
|---|---|
| Logo de loading | `build/logo.png`, referenciada diretamente por `build/index.html` |
| Ícones da aplicação | `build/favicon.ico`, `build/logo192.png`, `build/logo512.png`, declarados em `build/manifest.json` |
| Outras logos | `build/logo.svg` e `build/assets/images/{logo.png,logo.svg,1213logo.svg,logo-example.svg}` |
| Nome canônico | `build/config/app.config.js` (`APP_NAME`, `COMPANY_NAME`) |
| Nome de revenda/título | `build/config/reseller-config.js` e `.json` |
| Nome de pacote | `package.json` (`name`, descrição e autor) |
| HTML/tela inicial | `build/index.html` |
| Textos da UI | `build/locales/*.js`; há também textos embutidos no bundle React minificado |
| Traduções personalizadas | tabelas `translation_*` no SQLite |
| Estilos/tokens práticos | `build/static/css/main.a5b05d13.css`, classes Tailwind compiladas no JS e CSS inline em `index.html` |
| Cores PWA | `build/manifest.json`: preto `#000000` e branco `#ffffff` |

## Tela de licença

A interface de licença está no bundle minificado `build/static/js/main.09f84bf6.js`, portanto os nomes originais se perderam. Ela é apresentada pelo componente raiz quando o contexto de licença indica registro/chave ausente; a análise do bundle mostra componentes minificados equivalentes a `LicenseInput` e `LicenseRenewal`, além de estados de expirada, suspensa e revogada. A lógica de backend está em `electron.js` e nos serviços `local-license-service.js`, `cloud-license-service.js` e `newlic-license-service.js`.
