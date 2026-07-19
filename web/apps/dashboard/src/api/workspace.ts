import type { Team, TeamMember, WorkspaceUser } from '@chatpro/contracts';
import { ApiClient } from './client';
export class WorkspaceApi {
  constructor(private readonly http = new ApiClient()) {}
  users = () => this.http.get<WorkspaceUser[]>('/api/v1/workspace/users');
  createUser = (input: Pick<WorkspaceUser, 'email' | 'displayName'> & Partial<Pick<WorkspaceUser, 'avatarUrl' | 'role' | 'status'>>) => this.http.post<WorkspaceUser>('/api/v1/workspace/users', input);
  updateUser = (id: string, input: Partial<Pick<WorkspaceUser, 'displayName' | 'avatarUrl' | 'role' | 'status'>>) => this.http.patch<WorkspaceUser>(`/api/v1/workspace/users/${encodeURIComponent(id)}`, input);
  disableUser = (id: string) => this.http.post<WorkspaceUser>(`/api/v1/workspace/users/${encodeURIComponent(id)}/disable`);
  enableUser = (id: string) => this.http.post<WorkspaceUser>(`/api/v1/workspace/users/${encodeURIComponent(id)}/enable`);
  teams = () => this.http.get<Team[]>('/api/v1/workspace/teams');
  createTeam = (input: Pick<Team, 'name'> & Partial<Pick<Team, 'description' | 'color' | 'isActive'>>) => this.http.post<Team>('/api/v1/workspace/teams', input);
  updateTeam = (id: string, input: Partial<Pick<Team, 'name' | 'description' | 'color' | 'isActive'>>) => this.http.patch<Team>(`/api/v1/workspace/teams/${encodeURIComponent(id)}`, input);
  members = (teamId: string) => this.http.get<TeamMember[]>(`/api/v1/workspace/teams/${encodeURIComponent(teamId)}/members`);
  addMember = (teamId: string, input: Pick<TeamMember, 'userId'> & Partial<Pick<TeamMember, 'membershipRole'>>) => this.http.post<TeamMember>(`/api/v1/workspace/teams/${encodeURIComponent(teamId)}/members`, input);
  removeMember = (teamId: string, userId: string) => this.http.delete(`/api/v1/workspace/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`);
}
