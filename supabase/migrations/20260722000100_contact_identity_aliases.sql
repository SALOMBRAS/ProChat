CREATE TABLE IF NOT EXISTS public.contact_identifiers (id text NOT NULL, workspace_id text NOT NULL, contact_id text NOT NULL, identifier text NOT NULL, type text NOT NULL, source text NOT NULL, created_at timestamptz NOT NULL, PRIMARY KEY (workspace_id,id), UNIQUE (workspace_id,identifier), FOREIGN KEY (workspace_id,contact_id) REFERENCES public.contacts(workspace_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_contact_identifiers_contact ON public.contact_identifiers(workspace_id,contact_id);
CREATE TABLE IF NOT EXISTS public.pending_contact_identities (id text NOT NULL, workspace_id text NOT NULL, identifier text NOT NULL, type text NOT NULL, source text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY (workspace_id,id), UNIQUE (workspace_id,identifier));
INSERT INTO public.contact_identifiers (id,workspace_id,contact_id,identifier,type,source,created_at) SELECT md5(random()::text || clock_timestamp()::text || c.id),c.workspace_id,c.id,c.phone_number,'phone','migration',c.created_at FROM public.contacts c ON CONFLICT (workspace_id,identifier) DO NOTHING;
ALTER TABLE public.contact_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_contact_identities ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contact_identifiers, public.pending_contact_identities TO service_role;
