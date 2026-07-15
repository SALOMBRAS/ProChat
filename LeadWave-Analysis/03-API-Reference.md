# Referência de `electronAPI`

`build/preload.js` publica `window.electronAPI`. Chamadas retornam Promises por IPC, salvo os registradores de evento, que retornam uma função de limpeza.

| Grupo | Operações expostas |
|---|---|
| Raiz | `getVersion`, diálogos abrir/salvar/mensagem, confirmação de fechamento |
| `whatsapp` | sessões, QR/pairing, mensagens/templates, validação de números, chats, mídia, grupos, labels, bloqueio, enquetes e eventos (`on*`) |
| `database` | `query`, `deleteAllData` |
| `optOut` | status, opt-in/out, filtro de contatos, relatórios e mensagens automáticas |
| `campaignScheduler` | status, verificação e início de campanhas |
| `app` | estatísticas, saúde, atividades, sair e reiniciar |
| `license` | machine ID, ativar/renovar/atualizar, trial, validar, status, cache local e diagnóstico |
| `cloudLicense` / `newlicLicense` | ativar, validar, obter informação e limpar/apagar |
| `backup` | criar, restaurar, histórico, seleção e validação de backup |
| `update` | checar, baixar, instalar e estado de atualização |
| `ai` | provedores, chatbots, documentos/base de conhecimento e testes de IA |
| `liveChat` | conversas, mensagens, contatos, notas, respostas rápidas e estatísticas |
| `proxy`, `warmer`, `email` | proxies, aquecimento de contas, e-mail/configuração |
| `translation` | idiomas, chaves, edição, importação/exportação e estatísticas |

## WhatsApp: operações principais

`createSession`, `disconnectSession`, `reconnectSession`, `deleteSession`, `getSessions`, `getSessionStatus`, `requestPairingCode`, `sendMessage`, `sendTemplateMessage`, `checkNumber`, `getChats`, `getChatHistory`, `downloadMedia`, `uploadMedia`, `fetchAllGroups`, `createGroup`, administrar participantes/configurações/foto, `sendGroupMessage`, `getLabels`, bloqueio, operações em lote e depuração de enquetes.

Eventos: `on(event, callback)`, `onQRCode`, `onSessionConnected`, `onSessionDisconnected`, `onSessionStatusUpdate`, `onMessageReceived`, `onContactsUpdate`, `onPresenceUpdate`, `onCallReceived`, `onSessionDeleted` e `removeAllListeners`.

## Observações de segurança

- `database.query` recebe SQL genérico do renderer; isso amplia muito a superfície de alteração/exfiltração de dados. Prefira APIs específicas e validação de operações.
- Há handlers de leitura/gravação de arquivo e abertura de URL no processo principal. Eles devem validar caminho/URL e não ser expostos a conteúdo remoto.
- Sempre pare listeners no desmontar de componentes: os métodos `on*` retornam a limpeza apropriada.
