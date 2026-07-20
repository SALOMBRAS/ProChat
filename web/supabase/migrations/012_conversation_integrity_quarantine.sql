ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS visibility_state text NOT NULL DEFAULT 'visible' CHECK (visibility_state IN ('visible', 'quarantined', 'technical'));
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS integrity_classification text NOT NULL DEFAULT 'inconclusive' CHECK (integrity_classification IN ('valid_direct', 'valid_group', 'probable_false_direct', 'technical', 'inconclusive'));
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS integrity_reason_safe text;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS integrity_reviewed_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_conversations_visibility_activity ON public.conversations(workspace_id, visibility_state, last_message_at DESC);
