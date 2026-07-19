CREATE TABLE IF NOT EXISTS public.workspace_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, email text NOT NULL,
  display_name text NOT NULL, avatar_url text NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'agent')),
  status text NOT NULL CHECK (status IN ('active', 'invited', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NULL,
  UNIQUE (workspace_id, email), UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_users_directory ON public.workspace_users(workspace_id, status, display_name);
CREATE TABLE IF NOT EXISTS public.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, name text NOT NULL, description text NULL, color text NULL,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name), UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_teams_directory ON public.teams(workspace_id, is_active, name);
CREATE TABLE IF NOT EXISTS public.team_members (
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.workspace_users(id) ON DELETE RESTRICT,
  membership_role text NOT NULL DEFAULT 'member' CHECK (membership_role IN ('member', 'leader')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON public.team_members(user_id, team_id);
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS assigned_team_id uuid NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_assigned_team ON public.conversations(workspace_id, assigned_team_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_users, public.teams, public.team_members TO service_role;
