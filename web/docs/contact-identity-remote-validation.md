# Remote validation — contact identity RPC

Date: 2026-07-23 (America/Sao_Paulo)
Project ref: `vhfixhqfwusobczmubfu`

## Result

**Not applied; no rollback required.** The pre-application PostgREST probe
returned `PGRST202` for
`public.chatpro_resolve_contact_identity(p_workspace_id, p_phone_number,
p_display_name, p_identifiers, p_source)`, as expected before migration.

The requested schema reload, RPC invocation, concurrency test, workspace
isolation test, and identity mutation tests were not run because this session
lacks an administrative SQL execution channel and cannot safely inspect the
remote schema first. No data, contacts, aliases, pending identities, webhook
records, frontend files, deployment, or remote migration state was changed.

## Required next step

Run the target SQL and its dry-run through an authenticated Supabase CLI,
Dashboard SQL Editor, or PostgreSQL connection with schema-inspection rights;
then execute `NOTIFY pgrst, 'reload schema';` and repeat the validation matrix.
Use `20260723000100_contact_identity_atomic.rollback.sql` only if one of the
specified critical rollback conditions is observed.
