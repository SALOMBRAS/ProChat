import { describe, expect, it } from 'vitest';
import { SupabaseDomainRepository } from '../src/persistence/supabase-domain.repository.js';

type Call = { name: string; args: Record<string, unknown> };
class ControlledClient {
  readonly calls: Call[] = [];
  rpc(name: string, args: Record<string, unknown>) { this.calls.push({ name, args }); return Promise.resolve({ data: name === 'chatpro_create_contact' ? { id: 'contact-1', workspace_id: args.p_workspace_id, phone_number: '5511999990000' } : null, error: name === 'chatpro_set_lead_tag' && args.p_tag_id === 'other-workspace-tag' ? { message: 'tag not found in workspace', code: 'P0001' } : null }); }
  from(table: string) { this.calls.push({ name: `from:${table}`, args: {} }); const result = { data: [{ id: 'tag-1', workspace_id: 'workspace-a', name: 'VIP' }], error: null }; const query = { select: () => query, eq: () => query, order: () => Promise.resolve(result), maybeSingle: () => Promise.resolve({ data: result.data[0], error: null }), update: () => query, insert: () => query, single: () => Promise.resolve({ data: result.data[0], error: null }), delete: () => query }; return query; }
}

const repositoryFor = () => {
  const client = new ControlledClient();
  return { client, repository: new SupabaseDomainRepository(client as unknown as ConstructorParameters<typeof SupabaseDomainRepository>[0]) };
};

describe('Supabase domain repository', () => {
  it('uses the contact RPC with normalized phone and workspace parameters', async () => {
    const { client, repository } = repositoryFor();
    await expect(repository.createContact('workspace-a', { displayName: 'Ada', phoneNumber: '+55 (11) 99999-0000', tagIds: ['tag-1'] })).resolves.toMatchObject({ workspaceId: 'workspace-a', phoneNumber: '5511999990000' });
    expect(client.calls[0]).toEqual({ name: 'chatpro_create_contact', args: { p_workspace_id: 'workspace-a', p_contact: { displayName: 'Ada', phoneNumber: '5511999990000', tagIds: ['tag-1'] }, p_tag_ids: ['tag-1'] } });
  });
  it('normalizes RPC errors from cross-workspace relationship attempts', async () => {
    const { repository } = repositoryFor();
    await expect(repository.leadTag('workspace-a', 'lead-1', 'other-workspace-tag', true)).rejects.toThrow('tag not found in workspace');
  });
  it('keeps a simple tag listing on the table transport instead of RPC', async () => {
    const { client, repository } = repositoryFor();
    await expect(repository.tags('workspace-a')).resolves.toEqual([{ id: 'tag-1', workspaceId: 'workspace-a', name: 'VIP' }]);
    expect(client.calls).toEqual([{ name: 'from:tags', args: {} }]);
  });
  it('uses a compound campaign RPC and returns its normalized result', async () => {
    const { client, repository } = repositoryFor();
    await repository.saveCampaign('workspace-a', undefined, { name: 'Launch', contactIds: ['contact-1'] });
    expect(client.calls[0]).toMatchObject({ name: 'chatpro_save_campaign', args: { p_workspace_id: 'workspace-a', p_contact_ids: ['contact-1'] } });
  });
});
