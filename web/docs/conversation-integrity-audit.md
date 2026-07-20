# Conversation integrity audit

Run `npx tsx scripts/audit-conversation-integrity.ts` from `web` for a read-only, masked report. It writes `docs/conversation-integrity-audit.json` (ignored operational output) and does not modify messages or conversations.

`--apply` is deliberately limited to reversible metadata updates for records already classified as `technical` or `probable_false_direct`. Participant-only records remain `inconclusive` until a WAHA chat-list comparison is available, so they cannot be quarantined accidentally.
