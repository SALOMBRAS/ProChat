# Remote pre-migration audit — contact identity RPC

Date: 2026-07-23 (America/Sao_Paulo)
Project ref: `vhfixhqfwusobczmubfu`
Target migration: `20260723000100_contact_identity_atomic.sql`

## Local preflight

- Working tree was clean and the checked-out history contains implementation
  commit `d2eb0b4`.
- The target migration and its rollback were inspected. The migration creates
  only `public.chatpro_resolve_contact_identity`; the rollback drops only that
  exact function signature.
- The migration does not contain `TRUNCATE`, `DROP TABLE`, table alteration,
  contact merging, or backfill. Its only data mutations are the intended
  transactional contact/alias/pending-identity operations when the RPC is
  invoked.
- `SECURITY DEFINER SET search_path = public` is explicit and execution is
  granted only to `service_role`.

## Read-only remote probe

The configured service-role PostgREST endpoint accepted zero-row (`HEAD`)
probes for `contacts`, `contact_identifiers`, `pending_contact_identities`, and
`conversations`; no rows or personal data were read. Calling the target RPC
returned HTTP 404 / `PGRST202`, confirming it is not currently in the PostgREST
schema cache and therefore has not been applied under this signature.

The service-role REST API cannot query `information_schema`, `pg_catalog`, or
execute arbitrary migration SQL. No Supabase CLI, PostgreSQL connection string,
or Management API token is configured locally. The authenticated dashboard
could not be opened from this session. Consequently, the required remote type,
constraint, index, function-conflict, and dry-run audits have not been claimed
as complete.

## Decision

Application is intentionally stopped before any remote write. Applying without
verifying remote `contacts.id`, `contact_identifiers.contact_id`, composite FK,
and function return types would violate the migration safety conditions.
