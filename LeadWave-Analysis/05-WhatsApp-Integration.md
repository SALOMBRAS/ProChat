# Integração WhatsApp (Baileys)

O núcleo está em `build/services/whatsapp.service.js` e usa `@itsukichan/baileys` 7.3.2. O serviço mantém mapas de sockets/stores por sessão, inicia a versão Baileys dinamicamente, autentica por QR ou código de pareamento, persiste credenciais e encaminha eventos para o Electron.

## Capacidades

- múltiplas sessões e reconexão;
- envio de texto, templates, mídia e mensagens interativas;
- grupos: criação, participantes, permissões, foto, convite e mensagens;
- chats, histórico, presença, contatos, bloqueios e labels;
- enquetes e agregação de votos;
- resolução de LID/JID e validação/formatação de números;
- download/upload de mídia e chamadas de saída.

## Fluxo

1. React chama `electronAPI.whatsapp.*`.
2. `electron.js` valida/encaminha ao serviço.
3. `whatsapp.service.js` conversa com o socket Baileys.
4. Eventos (QR, conexão, mensagem, presença e chamada) são enviados de volta por IPC.

## Dados locais

O serviço usa diretórios de autenticação e store Baileys. A análise mostra referência a migração de um caminho legado sob a pasta de usuário `ChatPro`; não apague essas credenciais se desejar preservar sessões.

## Cuidados

Baileys é uma integração não oficial com WhatsApp Web. Limite volume, tenha consentimento para mensagens e monitore mudanças de protocolo. Alterar os formatos de mensagens interativas/enquetes exige teste real por versão da biblioteca.
