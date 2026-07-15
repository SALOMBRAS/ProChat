# ChatPro

ChatPro é um projeto acadêmico para a criação de uma plataforma web de atendimento por WhatsApp. A grafia do produto é **ChatPro**, embora o repositório remoto principal se chame `ProChat`.

A fundação técnica está ativa. Ela fornece um workspace Node.js pequeno e modular, mas ainda não implementa integração com WhatsApp, QR Code, Supabase, autenticação, mensagens, CRM, mídias, PWA ou deploy.

## Arquitetura atual

- `apps/web`: aplicação Next.js com App Router, TypeScript, Tailwind CSS e ESLint.
- `services/whatsapp-connector`: processo Node.js independente que apenas inicia, aguarda sinais e encerra de forma controlada.
- `packages/shared`: espaço reservado para tipos, validações e utilitários compartilhados.
- `packages/database`: espaço reservado para a futura camada de dados e Supabase.
- `packages/whatsapp-core`: espaço reservado para contratos normalizados e o futuro `WhatsAppProvider`.

```text
ChatPro Main/
├── apps/
│   └── web/
├── services/
│   └── whatsapp-connector/
├── packages/
│   ├── shared/
│   ├── database/
│   └── whatsapp-core/
├── package.json
└── tsconfig.base.json
```

## Requisitos locais

- Node.js `24.16.0`.
- npm `11.16.0`.

Use apenas npm. O projeto utiliza npm workspaces e mantém um único `package-lock.json` na raiz.

## Instalação

```powershell
npm install
```

## Desenvolvimento

Aplicação web:

```powershell
npm run dev:web
```

Conector independente:

```powershell
npm run dev:connector
```

Os comandos acima iniciam processos permanentes e devem ser encerrados com `Ctrl+C`.

## Validação

```powershell
npm run lint
npm run typecheck
npm run build
npm run check
```

`npm run check` executa lint, typecheck e builds sem manter servidores ativos.

## Documentação técnica

A memória operacional e as decisões detalhadas ficam no Cofre externo e independente:

- Local padrão: `C:\Projeto Salo\ChatPro\ChatPro Cofre`
- Repositório: <https://github.com/SALOMBRAS/ProChat-Obsidian>
