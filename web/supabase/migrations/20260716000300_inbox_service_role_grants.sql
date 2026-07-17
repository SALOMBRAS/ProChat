GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.waha_webhook_events, public.whatsapp_messages, public.conversations TO service_role;
