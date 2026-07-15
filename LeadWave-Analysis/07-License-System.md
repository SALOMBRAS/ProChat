# Sistema de licença

Existem três camadas de licença:

- `local-license-service.js`: licença local, trial e dados de ativação;
- `cloud-license-service.js`: ativação/validação por serviço remoto;
- `newlic-license-service.js`: armazenamento cifrado (`license.enc`), assinatura e detecção de adulteração.

`electron.js` implementa os canais IPC de máquina, ativação, renovação, upgrade, trial, validação, status e limpeza. Também calcula/persiste um identificador de máquina e realiza validação em segundo plano.

## Tela e estados

O bundle React escolhe entre carregamento, registro, entrada de chave, renovação e bloqueios de licença expirada/suspensa/revogada. Os textos correspondentes aparecem em `build/locales/*.js`, especialmente nas seções `licenseInput` e `licenseRenewal`.

## Alterações permitidas

É possível ajustar mensagens, visual da tela e endpoint/configuração de uma instalação autorizada. Não altere validação, assinatura, chave secreta ou armazenamento cifrado sem autorização do titular: isso compromete integridade, suporte e segurança. Nunca coloque segredos de produção diretamente no bundle distribuído.
