# ChatPro

ChatPro é um projeto acadêmico para a criação de uma plataforma web de atendimento por WhatsApp. A grafia oficial do produto é **ChatPro**, embora o repositório remoto principal se chame `ProChat`.

O escopo futuro prevê atendimento por mensagens, mensagens rápidas, CRM e outros recursos operacionais. Nenhuma dessas funcionalidades está implementada nesta fase.

## Arquitetura planejada

- Frontend web/PWA em Next.js.
- Supabase para PostgreSQL, autenticação, Storage e Realtime.
- Conector WhatsApp como serviço Node.js persistente e independente.
- Baileys como integração inicial planejada, isolada atrás do contrato `WhatsAppProvider`.
- Aplicativo móvel/APK futuro consumindo os mesmos serviços.
- Vercel somente para hospedagem futura do frontend.

## Estado atual

O projeto está na fase de **inicialização documental**. Ainda não há aplicação, dependências ou código funcional.

A memória técnica e as decisões do projeto ficam no Cofre externo e independente:

- Local padrão: `C:\Projeto Salo\ChatPro\ChatPro Cofre`
- Repositório: <https://github.com/SALOMBRAS/ProChat-Obsidian>
