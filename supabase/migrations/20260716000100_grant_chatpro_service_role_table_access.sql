-- The server-only Supabase adapter uses PostgREST for simple table operations.
-- RLS remains enabled; this only gives the service role the table privileges it
-- needs while keeping anon and authenticated roles without public access.
grant usage on schema public to service_role;

grant select, insert, update, delete on table public.contacts to service_role;
grant select, insert, update, delete on table public.tags to service_role;
grant select, insert, update, delete on table public.contact_tags to service_role;
grant select, insert, update, delete on table public.templates to service_role;
grant select, insert, update, delete on table public.pipelines to service_role;
grant select, insert, update, delete on table public.stages to service_role;
grant select, insert, update, delete on table public.leads to service_role;
grant select, insert, update, delete on table public.lead_tags to service_role;
grant select, insert, update, delete on table public.lead_notes to service_role;
grant select, insert, update, delete on table public.activities to service_role;
grant select, insert, update, delete on table public.campaigns to service_role;
grant select, insert, update, delete on table public.campaign_recipients to service_role;
grant select, insert, update, delete on table public.workspace_settings to service_role;
grant select, insert, update, delete on table public.opt_out_history to service_role;

notify pgrst, 'reload schema';
