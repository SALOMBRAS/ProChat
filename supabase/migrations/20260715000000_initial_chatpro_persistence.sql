-- PostgreSQL/Supabase equivalent of the SQLite persistence schema. No policy is
-- deliberately created: RLS stays closed until the authentication design exists.
create table public.contacts (id text not null, workspace_id text not null, display_name text not null, phone_number text not null, email text, company text, created_at timestamptz not null, updated_at timestamptz not null, primary key (workspace_id, id), unique (workspace_id, phone_number));
create index idx_contacts_workspace_created on public.contacts (workspace_id, created_at desc);
create table public.tags (id text not null, workspace_id text not null, name text not null, color text, created_at timestamptz not null, updated_at timestamptz not null, primary key (workspace_id, id), unique (workspace_id, name));
create table public.contact_tags (workspace_id text not null, contact_id text not null, tag_id text not null, created_at timestamptz not null, primary key (workspace_id, contact_id, tag_id), foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete cascade, foreign key (workspace_id, tag_id) references public.tags(workspace_id, id) on delete cascade);
create index idx_contact_tags_tag on public.contact_tags (workspace_id, tag_id);
create table public.templates (id text not null, workspace_id text not null, name text not null, content text not null, variables_json jsonb not null default '[]'::jsonb check (jsonb_typeof(variables_json) = 'array'), active boolean not null default true, created_at timestamptz not null, updated_at timestamptz not null, primary key (workspace_id, id), unique (workspace_id, name));
create table public.pipelines (id text not null, workspace_id text not null, name text not null, created_at timestamptz not null, updated_at timestamptz not null, primary key (workspace_id, id), unique (workspace_id, name));
create table public.stages (id text not null, workspace_id text not null, pipeline_id text not null, name text not null, position integer not null check (position >= 0), created_at timestamptz not null, updated_at timestamptz not null, primary key (workspace_id, id), unique (workspace_id, pipeline_id, position), foreign key (workspace_id, pipeline_id) references public.pipelines(workspace_id, id) on delete cascade);
create index idx_stages_pipeline on public.stages (workspace_id, pipeline_id, position);
create table public.leads (id text not null, workspace_id text not null, stage_id text not null, contact_id text, title text not null, created_at timestamptz not null, updated_at timestamptz not null, primary key (workspace_id, id), foreign key (workspace_id, stage_id) references public.stages(workspace_id, id) on delete restrict, foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete set null (contact_id));
create index idx_leads_stage on public.leads (workspace_id, stage_id);
create table public.lead_tags (workspace_id text not null, lead_id text not null, tag_id text not null, created_at timestamptz not null, primary key (workspace_id, lead_id, tag_id), foreign key (workspace_id, lead_id) references public.leads(workspace_id, id) on delete cascade, foreign key (workspace_id, tag_id) references public.tags(workspace_id, id) on delete cascade);
create table public.lead_notes (id text not null, workspace_id text not null, lead_id text not null, body text not null, created_at timestamptz not null, updated_at timestamptz not null, primary key (workspace_id, id), foreign key (workspace_id, lead_id) references public.leads(workspace_id, id) on delete cascade);
create index idx_lead_notes_lead on public.lead_notes (workspace_id, lead_id, created_at desc);
create table public.activities (id text not null, workspace_id text not null, lead_id text not null, type text not null, details_json jsonb not null default '{}'::jsonb check (jsonb_typeof(details_json) = 'object'), occurred_at timestamptz not null, created_at timestamptz not null, updated_at timestamptz not null, primary key (workspace_id, id), foreign key (workspace_id, lead_id) references public.leads(workspace_id, id) on delete cascade);
create index idx_activities_lead on public.activities (workspace_id, lead_id, occurred_at desc);
create table public.campaigns (id text not null, workspace_id text not null, name text not null, template_id text, status text not null check (status in ('draft', 'scheduled', 'ready', 'blocked', 'cancelled')), scheduled_at timestamptz, created_at timestamptz not null, updated_at timestamptz not null, primary key (workspace_id, id), foreign key (workspace_id, template_id) references public.templates(workspace_id, id) on delete set null (template_id));
create index idx_campaigns_workspace_status on public.campaigns (workspace_id, status, scheduled_at);
create table public.campaign_recipients (workspace_id text not null, campaign_id text not null, contact_id text not null, created_at timestamptz not null, primary key (workspace_id, campaign_id, contact_id), foreign key (workspace_id, campaign_id) references public.campaigns(workspace_id, id) on delete cascade, foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete restrict);
create table public.workspace_settings (id text not null, workspace_id text not null unique, settings_json jsonb not null default '{}'::jsonb check (jsonb_typeof(settings_json) = 'object'), created_at timestamptz not null, updated_at timestamptz not null, primary key (workspace_id, id));
create table public.opt_out_history (id text not null, workspace_id text not null, contact_id text not null, reason text, source text not null, occurred_at timestamptz not null, created_at timestamptz not null, updated_at timestamptz not null, primary key (workspace_id, id), foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete restrict);
create index idx_opt_out_history_contact on public.opt_out_history (workspace_id, contact_id, occurred_at desc);

alter table public.contacts enable row level security;
alter table public.tags enable row level security;
alter table public.contact_tags enable row level security;
alter table public.templates enable row level security;
alter table public.pipelines enable row level security;
alter table public.stages enable row level security;
alter table public.leads enable row level security;
alter table public.lead_tags enable row level security;
alter table public.lead_notes enable row level security;
alter table public.activities enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.opt_out_history enable row level security;
