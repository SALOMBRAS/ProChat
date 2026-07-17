ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS media_url text NULL;
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS media_mime_type text NULL;
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS media_filename text NULL;
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS media_size bigint NULL;
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS thumbnail_url text NULL;
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS duration integer NULL;
ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS quoted_message_id text NULL;
