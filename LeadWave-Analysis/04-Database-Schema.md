# Esquema SQLite

O banco é gerenciado por `build/services/database.service.js`, com `better-sqlite3`; migrações adicionais estão em `build/database/migrations/`.

## Grupos de tabelas identificados

| Domínio | Tabelas |
|---|---|
| Base | `app_settings`, `activity_logs`, `contacts`, `contact_groups`, `contact_group_members`, `message_templates`, `message_history`, `whatsapp_sessions`, `lid_mappings` |
| Campanhas | `bulk_campaigns`, `bulk_campaigns_new`, `bulk_campaign_recipients`, `bulk_message_settings`, `campaign_message_counts`, `campaign_proxy_assignments` |
| Bots e IA | `auto_reply_rules`, `auto_reply_cooldowns`, `chatbot_*`, `ai_providers`, `ai_chatbots`, `ai_documents`, `ai_document_chunks`, `ai_knowledge_base`, `ai_intents`, `ai_messages`, `ai_conversations`, `ai_decision_flows`, `ai_appointments`, `ai_form_*`, `ai_global_settings`, `ai_learning_data` |
| Atendimento | `live_chat_conversations`, `live_chat_messages`, `live_chat_contacts`, `live_chat_assignments`, `live_chat_notes`, `live_chat_quick_replies`, `live_chat_activity_log` |
| Consentimento | `communication_preferences`, `opt_out_keywords`, `opt_out_requests`, `opt_out_settings`, `compliance_audit_log` |
| Follow-up/recall | `follow_up_messages`, `follow_up_logs`, `follow_up_statistics`, `reminders`, `recall_bot_settings`, `recall_bot_logs` |
| Enquetes | `poll_messages`, `poll_options`, `poll_votes` |
| Infraestrutura | `proxies`, `proxy_settings`, `proxy_usage_logs`, `backup_history`, `backup_schedules`, `email_*`, `google_drive_config`, `voice_transcriptions`, `spintax_state` |
| Aquecimento/suporte | `warmer_campaigns`, `warmer_templates`, `warmer_logs`, `support_bot_customers`, `support_bot_field_mappings`, `support_bot_settings`, `support_bot_logs` |
| Localização | `translation_keys`, `translation_overrides`, `translation_stats` |

## Migrações entregues

`ai_chatbot_schema.sql`, `follow_up_schema.sql`, `live_chat_schema.sql`, `poll_tracking_schema.sql`, `create_lid_mappings.sql` e `add_poll_question_field.sql`.

## Recomendação

Não remova tabelas ou migrações de uma cópia instalada. Faça backup, registre a versão da migração e teste restauração; há relações funcionais entre campanhas, contatos, sessões e histórico.
