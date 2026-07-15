# Interface React

O código-fonte dos componentes não acompanha esta pasta: está compilado/minificado em `build/static/js/main.09f84bf6.js`. É possível identificar as rotas e responsabilidades, mas não os nomes originais confiáveis dos componentes.

| Rota | Módulo funcional |
|---|---|
| `/dashboard`, `/devices` | painel e sessões WhatsApp |
| `/single-message`, `/templates`, `/contacts`, `/bulk-messages` | mensagens e contatos |
| `/proxies`, `/warmer`, `/opt-out-management` | infraestrutura e conformidade |
| `/auto-reply`, `/chatbot`, `/support-bot`, `/ai-chatbot` | automações e IA |
| `/call-responder`, `/follow-up`, `/recall-bot`, `/live-chat` | atendimento e acompanhamento |
| `/group-grabber`, `/manage-group`, `/reports` | grupos e relatórios |
| `/localization`, `/settings` | idioma e configurações |

O componente raiz bloqueia a aplicação durante a validação de licença, mostra a tela de renovação quando expirada e a entrada/registro quando a chave não existe. Há também tema claro/escuro por classes `dark:` no bundle.

## Onde modificar com segurança

Para modificações pontuais, altere o HTML inicial e configurações de marca. Para mudanças estruturais de componentes, rotas ou textos, obtenha o repositório React original: editar um bundle minificado perde legibilidade, é frágil e será sobrescrito por qualquer nova compilação.
