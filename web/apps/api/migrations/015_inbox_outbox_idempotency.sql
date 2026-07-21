ALTER TABLE inbox_outbox_jobs ADD COLUMN clientRequestId TEXT;
ALTER TABLE inbox_outbox_jobs ADD COLUMN providerAcceptedAt TEXT;
UPDATE inbox_outbox_jobs SET clientRequestId = id WHERE clientRequestId IS NULL;
CREATE UNIQUE INDEX idx_inbox_outbox_client_request ON inbox_outbox_jobs(workspaceId, clientRequestId);
