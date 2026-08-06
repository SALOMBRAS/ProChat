import type { WorkspaceUser } from '@chatpro/contracts';
import { saveAuthSession } from '../api/auth-storage';

export const fakeUser = (overrides: Partial<WorkspaceUser> = {}): WorkspaceUser => ({
  id: '00000000-0000-4000-8000-0000000000aa',
  workspaceId: 'default-workspace',
  email: 'dono@chatpro.dev',
  displayName: 'Dono Teste',
  avatarUrl: null,
  role: 'owner',
  status: 'active',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastSeenAt: null,
  ...overrides,
});

export const seedSession = (user: WorkspaceUser = fakeUser()) =>
  saveAuthSession({ token: 'test-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), user });
