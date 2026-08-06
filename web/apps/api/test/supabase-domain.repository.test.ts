import { describe, expect, it, vi } from 'vitest';
import { SupabaseDomainRepository } from '../src/persistence/supabase-domain.repository.js';

type Call = { name: string; args: Record<string, unknown> };
class ControlledClient {
  readonly calls: Call[] = [];
  rpc(name: string, args: Record<string, unknown>) { this.calls.push({ name, args }); return Promise.resolve({ data: name === 'chatpro_create_contact' ? { id: 'contact-1', workspace_id: args.p_workspace_id, phone_number: '5511999990000' } : null, error: name === 'chatpro_set_lead_tag' && args.p_tag_id === 'other-workspace-tag' ? { message: 'tag not found in workspace', code: 'P0001' } : null }); }
  from(table: string) { this.calls.push({ name: `from:${table}`, args: {} }); const result = { data: [{ id: 'tag-1', workspace_id: 'workspace-a', name: 'VIP' }], error: null }; const query = { select: (_columns?: string, options?: Record<string, unknown>) => { if (options?.head) this.calls.push({ name: `count:${table}`, args: options }); return query; }, eq: () => query, in: () => query, or: () => query, order: () => ({ ...query, then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result)), range: () => Promise.resolve({ data: result.data, count: result.data.length, error: null }) }), maybeSingle: () => Promise.resolve({ data: result.data[0], error: null }), update: () => query, insert: () => query, single: () => Promise.resolve({ data: result.data[0], error: null }), delete: () => query, then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: null, count: table === 'conversations' ? 7 : table === 'whatsapp_messages' ? 42 : null, error: null })) }; return query; }
}

const repositoryFor = () => {
  const client = new ControlledClient();
  return { client, repository: new SupabaseDomainRepository(client as unknown as ConstructorParameters<typeof SupabaseDomainRepository>[0]) };
};

type ContactRow = { id: string; workspace_id: string; display_name: string; phone_number: string; email: string | null; created_at: string };
const CONTACTS: ContactRow[] = [
  { id: 'contact-1', workspace_id: 'workspace-a', display_name: 'Ada Lovelace', phone_number: '5511999990001', email: 'ada@example.com', created_at: '2026-01-03T00:00:00.000Z' },
  { id: 'contact-2', workspace_id: 'workspace-a', display_name: 'Alan Turing', phone_number: '5511999990002', email: 'alan@example.com', created_at: '2026-01-02T00:00:00.000Z' },
  { id: 'contact-3', workspace_id: 'workspace-a', display_name: 'Grace Hopper', phone_number: '5511988880003', email: null, created_at: '2026-01-01T00:00:00.000Z' },
  { id: 'contact-4', workspace_id: 'workspace-b', display_name: 'Ada from another workspace', phone_number: '5511999990004', email: 'ada@other.example.com', created_at: '2026-01-04T00:00:00.000Z' },
];

/** Applies the `or=` grammar the way PostgREST does, so a filter the server
 * would reject or read differently cannot pass the test. */
const applyOrFilter = (rows: ContactRow[], filter: string) => {
  const matches = [...filter.matchAll(/([a-z_]+)\.ilike\."((?:[^"\\]|\\.)*)"/g)];
  // The clauses must account for the whole string; anything left over means the
  // term leaked into the filter grammar instead of staying a value.
  if (matches.map((match) => match[0]).join(',') !== filter) throw new Error(`unparseable PostgREST or filter: ${filter}`);
  const clauses = matches.map(([, column, value]) => ({ column, pattern: value.replace(/\\(.)/g, '$1') }));
  return rows.filter((row) => clauses.some(({ column, pattern }) => {
    const value = row[column as keyof ContactRow];
    if (typeof value !== 'string') return false;
    const [, term] = /^%(.*)%$/.exec(pattern) ?? [];
    return term !== undefined && value.toLowerCase().includes(term.toLowerCase());
  }));
};

export const TAG_VIP = '11111111-1111-4111-8111-111111111111';
export const TAG_LEAD = '22222222-2222-4222-8222-222222222222';
const CONTACT_TAGS = [
  { workspace_id: 'workspace-a', contact_id: 'contact-1', tag_id: TAG_VIP },
  { workspace_id: 'workspace-a', contact_id: 'contact-2', tag_id: TAG_LEAD },
];
const OPT_OUTS = [{ id: 'opt-out-1', workspace_id: 'workspace-a', contact_id: 'contact-2' }];
const EMBEDS: Record<string, Array<Record<string, unknown>>> = { contact_tags: CONTACT_TAGS, opt_out_history: OPT_OUTS };
/** Duas identidades para o mesmo telefone: a mais recente é a que vale. A linha
 * do workspace-b não pode vazar para o enriquecimento do workspace-a. */
const WHATSAPP_IDENTITIES = [
  { workspace_id: 'workspace-a', phone: '5511999990001', name: 'Ada antiga', push_name: 'old', profile_picture_url: 'https://cdn.example/ada-old.jpg', updated_at: '2026-01-01T00:00:00.000Z' },
  { workspace_id: 'workspace-a', phone: '5511999990001', name: 'Ada WA', push_name: 'Ada push', profile_picture_url: 'https://cdn.example/ada-new.jpg', updated_at: '2026-02-01T00:00:00.000Z' },
  { workspace_id: 'workspace-b', phone: '5511999990002', name: 'Alan de outro workspace', push_name: null, profile_picture_url: 'https://cdn.example/alan-other.jpg', updated_at: '2026-02-02T00:00:00.000Z' },
];
/** Origem dos contatos: contact-1 nasceu da agenda ('waha_contact_sync' →
 * 'phonebook'), contact-3 das conversas, contact-2 de cadastro manual. A linha
 * do workspace-b não pode vazar para o enriquecimento do workspace-a. */
const CONTACT_IDENTIFIERS = [
  { workspace_id: 'workspace-a', contact_id: 'contact-1', identifier: '5511999990001@c.us', source: 'waha_contact_sync' },
  { workspace_id: 'workspace-a', contact_id: 'contact-3', identifier: '120363363444637332@g.us', source: 'waha_chat_history' },
  { workspace_id: 'workspace-b', contact_id: 'contact-1', identifier: 'intruso@c.us', source: 'waha_contact_sync' },
];
const SOURCES: Record<string, Array<Record<string, unknown>>> = { contacts: CONTACTS, whatsapp_identities: WHATSAPP_IDENTITIES, contact_identifiers: CONTACT_IDENTIFIERS, ...EMBEDS };

/** Records what reached the transport and answers like PostgREST: embedding,
 * filtering, ordering, counting and slicing all happen on the server side, so a
 * provider that paginates in memory cannot pass these tests. */
class ContactsClient {
  readonly requests: Array<{ table: string; select?: string; count?: unknown; head?: boolean; eq: Array<[string, unknown]>; is: Array<[string, unknown]>; in: Array<[string, unknown[]]>; or?: string; order?: [string, boolean]; range?: [number, number] }> = [];
  from(table: string) {
    const request: (typeof this.requests)[number] = { table, eq: [], is: [], in: [] };
    this.requests.push(request);
    // `*,contact_tags!inner(tag_id)` -> [{ name: 'contact_tags', inner: true }]
    const embeds = () => (request.select ?? '*').split(',').flatMap((part) => { const [, name, inner] = /^([a-z_]+)(!inner)?\(/.exec(part.trim()) ?? []; return name ? [{ name, inner: Boolean(inner) }] : []; });
    const embedded = (name: string, contactId: string) => (EMBEDS[name] ?? []).filter((item) => item.contact_id === contactId && request.eq.every(([column, value]) => { const [scope, field] = column.split('.'); return scope !== name || item[field] === value; }));
    const rows = () => {
      let result: Array<Record<string, unknown>> = (SOURCES[table] ?? []).filter((row) => request.eq.every(([column, value]) => column.includes('.') || row[column] === value));
      for (const embed of embeds()) result = result.map((row) => ({ ...row, [embed.name]: embedded(embed.name, String(row.id)) })).filter((row) => !embed.inner || (row[embed.name] as unknown[]).length > 0);
      for (const [column] of request.is) result = result.filter((row) => !((row[column] as unknown[] | undefined) ?? []).length);
      for (const [column, values] of request.in) result = result.filter((row) => values.includes(row[column]));
      if (request.or) result = applyOrFilter(result as ContactRow[], request.or);
      if (request.order) { const [column, ascending] = request.order; result = [...result].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1)); }
      return result;
    };
    const answer = () => { const matched = rows(); return { matched, count: request.count === 'exact' ? matched.length : null }; };
    const query = {
      select: (columns?: string, options?: Record<string, unknown>) => { request.select = columns; request.count = options?.count; request.head = Boolean(options?.head); return query; },
      eq: (column: string, value: unknown) => { request.eq.push([column, value]); return query; },
      is: (column: string, value: unknown) => { request.is.push([column, value]); return query; },
      in: (column: string, values: unknown[]) => { request.in.push([column, values]); return query; },
      or: (filter: string) => { request.or = filter; return query; },
      order: (column: string, options?: { ascending?: boolean }) => { request.order = [column, options?.ascending !== false]; return query; },
      range: (from: number, to: number) => {
        request.range = [from, to];
        const { matched, count } = answer();
        // PostgREST answers 416/PGRST103 rather than an empty page when the
        // requested offset is past the last row.
        if (from > 0 && from >= matched.length) return Promise.resolve({ data: null, count: null, error: { code: 'PGRST103', message: 'Requested range not satisfiable', details: `An offset of ${from} was requested, but there are only ${matched.length} rows.` } });
        return Promise.resolve({ data: matched.slice(from, to + 1), count, error: null });
      },
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      // A head count query is awaited straight after the filters; any other
      // awaited query answers with its rows.
      then: (resolve: (value: unknown) => unknown) => { const { matched, count } = answer(); return Promise.resolve(resolve({ data: request.head ? null : matched, count, error: null })); },
    };
    return query;
  }
}

const contactsRepositoryFor = () => {
  const client = new ContactsClient();
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
  it('filters contacts in the database and returns only the matches', async () => {
    const { client, repository } = contactsRepositoryFor();
    const result = await repository.contacts('workspace-a', { search: 'ada' }) as unknown as { items: Array<{ id: string }>; total: number };
    expect(result.items.map((item) => item.id)).toEqual(['contact-1']);
    expect(result.total).toBe(1);
    const [request] = client.requests;
    expect(request.or).toBe('display_name.ilike."%ada%",phone_number.ilike."%ada%",email.ilike."%ada%"');
    expect(request.eq).toEqual([['workspace_id', 'workspace-a']]);
    expect(request.count).toBe('exact');
    expect(request.range).toEqual([0, 24]);
  });

  it('matches contacts partially and case-insensitively, like the SQLite provider', async () => {
    const { repository } = contactsRepositoryFor();
    const byName = await repository.contacts('workspace-a', { search: 'LOVELACE' }) as unknown as { items: Array<{ id: string }> };
    expect(byName.items.map((item) => item.id)).toEqual(['contact-1']);
    const byPhone = await repository.contacts('workspace-a', { search: '98888' }) as unknown as { items: Array<{ id: string }> };
    expect(byPhone.items.map((item) => item.id)).toEqual(['contact-3']);
    const byEmail = await repository.contacts('workspace-a', { search: 'Alan@Example' }) as unknown as { items: Array<{ id: string }> };
    expect(byEmail.items.map((item) => item.id)).toEqual(['contact-2']);
  });

  it('returns an empty page for a search without results instead of the whole list', async () => {
    const { client, repository } = contactsRepositoryFor();
    const result = await repository.contacts('workspace-a', { search: 'no-such-contact' }) as { items: unknown[]; total: number; page: number; pageSize: number };
    expect(result).toEqual({ items: [], page: 1, pageSize: 25, total: 0 });
    expect(client.requests[0].or).toContain('no-such-contact');
  });

  it('paginates in the database while keeping the filter applied', async () => {
    const { client, repository } = contactsRepositoryFor();
    const first = await repository.contacts('workspace-a', { search: '55119999', page: 1, pageSize: 1 }) as unknown as { items: Array<{ id: string }>; total: number };
    expect(first.items.map((item) => item.id)).toEqual(['contact-1']);
    expect(first.total).toBe(2);
    expect(client.requests[0].range).toEqual([0, 0]);
    const second = await repository.contacts('workspace-a', { search: '55119999', page: 2, pageSize: 1 }) as unknown as { items: Array<{ id: string }>; total: number };
    expect(second.items.map((item) => item.id)).toEqual(['contact-2']);
    expect(second.total).toBe(2);
    // Cada consulta de contatos agora também dispara a consulta em lote de
    // identidades, então a posição dos requests de contatos não é mais 0 e 1.
    const contactRequests = client.requests.filter((request) => request.table === 'contacts');
    expect(contactRequests[1].range).toEqual([1, 1]);
    expect(contactRequests[1].or).toBe(contactRequests[0].or);
  });

  it('keeps the search inside the workspace and orders like the SQLite provider', async () => {
    const { client, repository } = contactsRepositoryFor();
    const result = await repository.contacts('workspace-a', {}) as unknown as { items: Array<{ id: string }>; total: number };
    expect(result.items.map((item) => item.id)).toEqual(['contact-1', 'contact-2', 'contact-3']);
    expect(result.total).toBe(3);
    expect(client.requests[0].order).toEqual(['created_at', false]);
  });

  it('marks each contact with its origin: phonebook when the agenda created it, history otherwise', async () => {
    const { client, repository } = contactsRepositoryFor();
    const result = await repository.contacts('workspace-a', {}) as unknown as { items: Array<{ id: string; origin: string }> };
    expect(result.items.find((item) => item.id === 'contact-1')!.origin).toBe('phonebook');
    expect(result.items.find((item) => item.id === 'contact-2')!.origin).toBe('history');
    expect(result.items.find((item) => item.id === 'contact-3')!.origin).toBe('history');
    // Uma consulta em lote, escopada ao workspace — nunca uma por linha.
    const identifiers = client.requests.filter((request) => request.table === 'contact_identifiers');
    expect(identifiers).toHaveLength(1);
    expect(identifiers[0]!.eq).toEqual([['workspace_id', 'workspace-a']]);
    expect(identifiers[0]!.in).toEqual([['contact_id', ['contact-1', 'contact-2', 'contact-3']]]);
  });

  it('enriches each contact with the latest WhatsApp identity of its phone in one batch query', async () => {
    const { client, repository } = contactsRepositoryFor();
    const result = await repository.contacts('workspace-a', {}) as unknown as { items: Array<{ id: string } & Record<string, unknown>> };
    const ada = result.items.find((item) => item.id === 'contact-1')!;
    expect(ada).toMatchObject({ photoUrl: 'https://cdn.example/ada-new.jpg', whatsappName: 'Ada WA', whatsappPushName: 'Ada push' });
    // Sem identidade no MESMO workspace o contato volta intocado — a linha do
    // workspace-b para o telefone do Alan não pode vazar.
    const alan = result.items.find((item) => item.id === 'contact-2')!;
    expect('photoUrl' in alan).toBe(false);
    const grace = result.items.find((item) => item.id === 'contact-3')!;
    expect('photoUrl' in grace).toBe(false);
    const identity = client.requests.find((request) => request.table === 'whatsapp_identities')!;
    expect(identity.eq).toEqual([['workspace_id', 'workspace-a']]);
    expect(identity.in).toEqual([['phone', ['5511999990001', '5511999990002', '5511988880003']]]);
    expect(identity.order).toEqual(['updated_at', false]);
  });

  it('lists contacts without enrichment when the identity table does not answer', async () => {
    const { client, repository } = contactsRepositoryFor();
    const baseFrom = client.from.bind(client);
    vi.spyOn(client, 'from').mockImplementation((table: string) => {
      if (table !== 'whatsapp_identities') return baseFrom(table);
      const query: Record<string, unknown> = {};
      const self = () => query;
      Object.assign(query, { select: self, eq: self, in: self, order: self, then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: null, error: { code: '42P01', message: 'relation "whatsapp_identities" does not exist' } })) });
      return query as ReturnType<typeof baseFrom>;
    });
    const result = await repository.contacts('workspace-a', {}) as unknown as { items: Array<Record<string, unknown>>; total: number };
    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => !('photoUrl' in item))).toBe(true);
  });

  it('quotes search terms so PostgREST cannot read them as extra filter clauses', async () => {
    const { client, repository } = contactsRepositoryFor();
    await expect(repository.contacts('workspace-a', { search: 'ada,phone_number.ilike.%' })).resolves.toMatchObject({ items: [], total: 0 });
    expect(client.requests[0].or).toBe('display_name.ilike."%ada,phone_number.ilike.%%",phone_number.ilike."%ada,phone_number.ilike.%%",email.ilike."%ada,phone_number.ilike.%%"');
  });

  it('rejects pagination inputs the SQLite provider also rejects', async () => {
    const { repository } = contactsRepositoryFor();
    await expect(repository.contacts('workspace-a', { page: 'not-a-number' })).rejects.toThrow();
    await expect(repository.contacts('workspace-a', { page: -1 })).rejects.toThrow();
    await expect(repository.contacts('workspace-a', { pageSize: 500 })).rejects.toThrow();
  });

  it('filters by tag through an inner embed instead of reading every contact', async () => {
    const { client, repository } = contactsRepositoryFor();
    const result = await repository.contacts('workspace-a', { tagId: TAG_VIP }) as unknown as { items: Array<{ id: string }>; total: number };
    expect(result.items.map((item) => item.id)).toEqual(['contact-1']);
    expect(result.total).toBe(1);
    expect(client.requests[0].select).toBe('*,contact_tags!inner(tag_id)');
    expect(client.requests[0].eq).toEqual([['workspace_id', 'workspace-a'], ['contact_tags.tag_id', TAG_VIP]]);
  });

  it('separates opted-out contacts from the rest in the database', async () => {
    const { client, repository } = contactsRepositoryFor();
    const optedOut = await repository.contacts('workspace-a', { optOut: 'true' }) as unknown as { items: Array<{ id: string }> };
    expect(optedOut.items.map((item) => item.id)).toEqual(['contact-2']);
    expect(client.requests[0].select).toBe('*,opt_out_history!inner(id)');
    const reachable = await repository.contacts('workspace-a', { optOut: 'false' }) as unknown as { items: Array<{ id: string }> };
    expect(reachable.items.map((item) => item.id)).toEqual(['contact-1', 'contact-3']);
    const contactRequests = client.requests.filter((request) => request.table === 'contacts');
    expect(contactRequests[1].select).toBe('*,opt_out_history(id)');
    expect(contactRequests[1].is).toEqual([['opt_out_history', null]]);
  });

  it('lists only opted-out contacts for the opt-out endpoint', async () => {
    const { repository } = contactsRepositoryFor();
    const result = await repository.optOutContacts('workspace-a', {}) as unknown as { items: Array<{ id: string }>; total: number };
    expect(result.items.map((item) => item.id)).toEqual(['contact-2']);
    expect(result.total).toBe(1);
  });

  it('never leaks the join machinery into a contact', async () => {
    const { repository } = contactsRepositoryFor();
    const result = await repository.contacts('workspace-a', { tagId: TAG_LEAD, optOut: 'true' }) as { items: Array<Record<string, unknown>> };
    expect(result.items).toEqual([{ id: 'contact-2', workspaceId: 'workspace-a', displayName: 'Alan Turing', phoneNumber: '5511999990002', email: 'alan@example.com', createdAt: '2026-01-02T00:00:00.000Z', origin: 'history' }]);
  });

  it('answers an empty page with the real total when the page is past the end', async () => {
    const { client, repository } = contactsRepositoryFor();
    await expect(repository.contacts('workspace-a', { page: 4, pageSize: 2 })).resolves.toEqual({ items: [], page: 4, pageSize: 2, total: 3 });
    expect(client.requests[1].head).toBe(true);
  });

  it('reads the tags linked to a contact so an editor can preselect them', async () => {
    const { client, repository } = contactsRepositoryFor();
    await expect(repository.contactTags('workspace-a', 'contact-1')).resolves.toEqual([TAG_VIP]);
    const request = client.requests.find((item) => item.table === 'contact_tags');
    expect(request?.eq).toEqual([['workspace_id', 'workspace-a'], ['contact_id', 'contact-1']]);
    expect(request?.order).toEqual(['tag_id', true]);
    await expect(repository.contactTags('workspace-a', 'contact-3')).resolves.toEqual([]);
    await expect(repository.contactTags('workspace-b', 'contact-1')).rejects.toThrow('contacts not found in workspace');
  });

  it('uses bounded workspace-scoped count queries for Inbox totals', async () => {
    const { client, repository } = repositoryFor();
    await expect(repository.dashboard('workspace-a', [])).resolves.toMatchObject({ conversations: 7, messages: 42 });
    expect(client.calls.filter((call) => call.name.startsWith('count:'))).toEqual([{ name: 'count:conversations', args: { count: 'exact', head: true } }, { name: 'count:whatsapp_messages', args: { count: 'exact', head: true } }]);
  });
});
