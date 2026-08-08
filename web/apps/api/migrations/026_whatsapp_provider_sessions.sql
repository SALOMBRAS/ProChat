CREATE TABLE whatsapp_provider_sessions (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  provider TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  sessionName TEXT NOT NULL,
  providerDeviceId TEXT NOT NULL,
  providerStatus TEXT NOT NULL,
  chatproStatus TEXT NOT NULL CHECK (chatproStatus IN ('disconnected','connecting','waiting_qr','connected','stopped','error')),
  capabilitiesJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(capabilitiesJson) AND json_type(capabilitiesJson) = 'array'),
  providerMetadataJson TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(providerMetadataJson) AND json_type(providerMetadataJson) = 'object'),
  reconciliationState TEXT NOT NULL CHECK (reconciliationState IN ('healthy','missing','unverified')),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  lastReconciledAt TEXT,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (id),
  UNIQUE (workspaceId, provider, sessionId),
  UNIQUE (provider, providerDeviceId)
);

CREATE INDEX idx_whatsapp_provider_sessions_provider_workspace ON whatsapp_provider_sessions(provider, workspaceId);
