ALTER TABLE conversations ADD COLUMN visibilityState TEXT NOT NULL DEFAULT 'visible' CHECK (visibilityState IN ('visible', 'quarantined', 'technical'));
ALTER TABLE conversations ADD COLUMN integrityClassification TEXT NOT NULL DEFAULT 'inconclusive' CHECK (integrityClassification IN ('valid_direct', 'valid_group', 'probable_false_direct', 'technical', 'inconclusive'));
ALTER TABLE conversations ADD COLUMN integrityReasonSafe TEXT;
ALTER TABLE conversations ADD COLUMN integrityReviewedAt TEXT;
CREATE INDEX idx_conversations_visibility_activity ON conversations(workspaceId, visibilityState, lastMessageAt DESC);
