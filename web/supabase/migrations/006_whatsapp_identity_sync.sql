ALTER TABLE public.whatsapp_identities ADD COLUMN IF NOT EXISTS short_name text NULL;
ALTER TABLE public.whatsapp_identities ADD COLUMN IF NOT EXISTS canonical_whatsapp_id text NULL;
UPDATE public.whatsapp_identities SET canonical_whatsapp_id = CASE WHEN whatsapp_id LIKE '%@c.us' THEN whatsapp_id WHEN phone IS NOT NULL AND phone <> '' THEN phone || '@c.us' ELSE whatsapp_id END WHERE canonical_whatsapp_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_identities_canonical ON public.whatsapp_identities(workspace_id, waha_session, canonical_whatsapp_id);

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS canonical_chat_id text NULL;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS delivery_chat_id text NULL;
UPDATE public.conversations SET canonical_chat_id = chat_id, delivery_chat_id = chat_id WHERE canonical_chat_id IS NULL OR delivery_chat_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_direct_canonical ON public.conversations(workspace_id, waha_session, canonical_chat_id) WHERE conversation_type = 'direct';
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.whatsapp_identities, public.whatsapp_groups, public.whatsapp_group_participants TO service_role;
