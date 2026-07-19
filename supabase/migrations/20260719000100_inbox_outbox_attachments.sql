-- Keep this migration aligned with web/supabase/migrations/011_inbox_outbox_attachments.sql.
CREATE TABLE IF NOT EXISTS public.inbox_outbox_jobs (
  id uuid NOT NULL, workspace_id text NOT NULL, conversation_id uuid NOT NULL, waha_session text NOT NULL,
  type text NOT NULL CHECK (type IN ('image','audio','video','document')), storage_object_path text NULL,
  filename text NULL, mime_type text NULL, size_bytes bigint NULL CHECK (size_bytes >= 0), caption text NULL,
  status text NOT NULL CHECK (status IN ('pending','processing','sent','confirmed','failed','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0), external_message_id text NULL,
  last_error_safe text NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id), FOREIGN KEY (workspace_id, conversation_id) REFERENCES public.conversations(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS inbox_outbox_jobs_workspace_status_idx ON public.inbox_outbox_jobs(workspace_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_outbox_jobs_external_message_idx ON public.inbox_outbox_jobs(workspace_id, external_message_id) WHERE external_message_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE ON TABLE public.inbox_outbox_jobs TO service_role;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('chatpro-temporary-attachments', 'chatpro-temporary-attachments', false, 52428800,
ARRAY['image/jpeg','image/png','image/webp','audio/ogg','audio/mpeg','audio/mp4','audio/webm','video/mp4','video/webm','application/pdf','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']::text[])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;
