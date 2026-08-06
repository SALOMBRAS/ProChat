import type { WorkspaceUser } from '@chatpro/contracts';
import { ApiClient } from './client';
import type { AuthSession } from './auth-storage';

export class AuthApi {
  constructor(private readonly http = new ApiClient()) {}
  login = (email: string, password: string) => this.http.post<AuthSession>('/api/v1/auth/login', { email, password });
  me = () => this.http.get<{ user: WorkspaceUser }>('/api/v1/auth/me');
  logout = () => this.http.post<void>('/api/v1/auth/logout');
  changePassword = (currentPassword: string, newPassword: string) => this.http.put<void>('/api/v1/auth/password', { currentPassword, newPassword });
  resetUserPassword = (userId: string, password: string) => this.http.post<void>(`/api/v1/auth/users/${encodeURIComponent(userId)}/password`, { password });
}
