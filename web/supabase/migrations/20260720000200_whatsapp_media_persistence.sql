ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS media_storage_path text;
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS media_checksum text;
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS media_persistence_status text NOT NULL DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS whatsapp_messages_media_persistence_idx ON public.whatsapp_messages (media_persistence_status) WHERE media_url IS NOT NULL;
GRANT SELECT, UPDATE ON TABLE public.whatsapp_messages TO service_role;
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('chatpro-whatsapp-media', 'chatpro-whatsapp-media', false, 52428800)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit;
