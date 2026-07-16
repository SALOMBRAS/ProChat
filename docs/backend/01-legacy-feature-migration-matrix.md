# Matriz de migração seletiva do legado

| Módulo legado | Arquivos/serviços principais | Finalidade e dependências | Classe | Proposta ChatPro / motivo |
|---|---|---|---|---|
| Contatos | `models/Contact.js`, `database.service.js` | cadastro, busca e importação; SQLite | A | `contacts` isolados por workspace; sem dados legados. |
| Etiquetas | `Contact.js`, `whatsapp.service.js` | tags locais e labels WhatsApp | A | `tags`, relações normalizadas; labels remotas ficam fora. |
| Templates | `models/MessageTemplate.js` | conteúdo e variáveis; SQLite | A | `templates` + JSON de variáveis validado. |
| CRM | não identificado como módulo estruturado | leads/pipeline não são núcleo do legado | A | novo modelo `pipelines/stages/leads`, sem copiar esquema. |
| Opt-out | `opt-out.service.js` | consentimento e histórico; SQLite | A | histórico por contato; processamento de mensagem posterior. |
| Campanhas | `campaign-scheduler.service.js` | agendamento e destinatários; WhatsApp | B | estados pré-envio e vínculos de contatos; entrega depende do worker. |
| Relatórios | `app.service.js` | agregações de campanhas/mensagens | B | consultas futuras sobre dados próprios; métricas de entrega dependem de WhatsApp. |
| Configurações | `database.service.js`, `app.service.js` | ajustes locais do app | A | `workspace_settings` JSON, sem segredos. |
| Mensagens | `whatsapp.service.js`, `message-processor.service.js` | envio/recebimento Baileys | C | requer conexão real, eventos e armazenamento próprio. |
| Chat ao vivo | `live-chat.service.js` | atendimento baseado em eventos | C | requer mensagens recebidas e canal em tempo real. |
| Grupos | `whatsapp.service.js` | consulta/administração de grupos | C | requer sessão WhatsApp conectada. |
| Automações | `followup-scheduler`, `recall-bot`, bots | jobs e respostas por WhatsApp | B | regras/dados podem ser modelados depois; validação exige eventos reais. |
| Login/licença | serviços `*license*`, IPC | ativação, máquina, pagamento | D | substituído futuramente por autenticação/autorização web; nunca migrar credenciais. |
| Serviços pagos | proxy, e-mail, IA, cloud-license | integrações externas | D | fora do produto-base desta fase e sem APIs pagas. |
