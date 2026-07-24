# Atomic contact identity design

`whatsapp-identifier.ts` is the single transport boundary: it removes device
suffixes, converts `@s.whatsapp.net` to `@c.us`, retains unresolved `@lid`, and
classifies groups without converting them into direct contacts. The domain still
accepts only an 8-15 digit phone as a contact-creation key.

`ContactIdentityResolver.resolveDetailed` accepts workspace, session/chat
context, aliases, optional phone, source, and group/participant flags. It
returns the canonical chat ID, linked identifiers, optional confirmed contact
and phone, pending identity, resolution source, and creation/attachment flags.
Group chats and group participants always return without a direct contact.

SQLite performs contact creation, alias attachment and pending cleanup inside
one `better-sqlite3` transaction. Supabase uses
`chatpro_resolve_contact_identity`, added in
`20260723000100_contact_identity_atomic.sql`; advisory transaction locks and
database unique constraints serialize duplicate `message`/`message.any` work.
The RPC returns only a contact inserted or reread in that transaction, so a
foreign-key alias never observes an unconfirmed local UUID.

The Supabase migration is additive and has not been applied remotely. Roll back
with `20260723000100_contact_identity_atomic.rollback.sql`, which removes only
the RPC. It intentionally does not merge existing contacts: an existing alias
that points to a different canonical contact remains a data ambiguity requiring
manual review.
