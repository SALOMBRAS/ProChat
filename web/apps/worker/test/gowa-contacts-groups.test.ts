import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@chatpro/contracts';
import { gowaContact, gowaGroup, gowaParticipant } from '../src/gowa-contacts.adapter.js';
import { GowaProvider } from '../src/gowa-provider.js';
import { gowaClientStub } from './support/gowa-client.stub.js';

const context: RequestContext = { workspaceId: 'workspace-a', correlationId: 'correlation-a', userId: 'user-a' };
const group = '120363000000000001@g.us';

/** Structs reais do GOWA, commit be8155c5 (domains/user/account.go, domains/group/group.go). */
const contactData = { jid: '5511999990001@s.whatsapp.net', name: 'Ana Silva' };
const participante = { jid: '5511999990002@s.whatsapp.net', phone_number: '5511999990002', lid: '251556368777322@lid', display_name: 'Bia', is_admin: true, is_super_admin: false };

describe('contatos GOWA', () => {
  it('mapeia jid e name, e nada além disso', () => {
    expect(gowaContact(contactData)).toEqual({ whatsappId: contactData.jid, name: 'Ana Silva' });
    // O endpoint não entrega telefone/LID/avatar — o adaptador não inventa.
    expect(Object.keys(gowaContact(contactData)!)).toEqual(['whatsappId', 'name']);
  });

  it('recusa nome que na verdade é identificador ou telefone', () => {
    expect(gowaContact({ ...contactData, name: '5511999990001@s.whatsapp.net' })!.name).toBeNull();
    expect(gowaContact({ ...contactData, name: '+55 11 99999-0001' })!.name).toBeNull();
  });
});

describe('participantes e grupos GOWA', () => {
  it('trata phone_number e lid como campos distintos e confiáveis', () => {
    const mapped = gowaParticipant(participante)!;
    expect(mapped).toMatchObject({ phone: '5511999990002', lid: '251556368777322@lid', displayName: 'Bia', role: 'admin' });
  });

  it('NUNCA transforma dígitos de @lid em telefone', () => {
    const semTelefone = gowaParticipant({ jid: '251556368777322@lid', phone_number: '', lid: '251556368777322@lid', is_admin: false })!;
    expect(semTelefone.phone).toBeNull();
    expect(semTelefone.lid).toBe('251556368777322@lid');

    // Nem quando o provider põe um LID no campo de telefone.
    expect(gowaParticipant({ jid: 'x@lid', phone_number: '251556368777322@lid' })!.phone).toBeNull();
  });

  it('distingue member, admin e superadmin', () => {
    expect(gowaParticipant({ jid: 'a@s.whatsapp.net' })!.role).toBe('member');
    expect(gowaParticipant({ jid: 'a@s.whatsapp.net', is_admin: true })!.role).toBe('admin');
    expect(gowaParticipant({ jid: 'a@s.whatsapp.net', is_admin: true, is_super_admin: true })!.role).toBe('superadmin');
  });

  it('a conversa é o group_id; participante jamais vira conversa', () => {
    const mapped = gowaGroup({ group_id: group, name: 'Equipe', participants: [participante] })!;

    expect(mapped.chatId).toBe(group);
    expect(mapped.participants[0].whatsappId).toBe(participante.jid);
    // A regressão travada: o participante não pode ser o chatId.
    expect(mapped.chatId).not.toBe(participante.jid);
  });

  it('recusa group_id que não é grupo, em vez de abrir conversa direta', () => {
    expect(gowaGroup({ group_id: '5511999990001@s.whatsapp.net', participants: [] })).toBeUndefined();
  });
});

describe('grupo pelo provider', () => {
  it('declara a capability e devolve metadados do grupo', async () => {
    const client = gowaClientStub({ getSessionStatus: vi.fn().mockResolvedValue({ isConnected: true, isLoggedIn: true }), getGroupParticipants: vi.fn().mockResolvedValue([participante]) });
    const provider = new GowaProvider(client);
    await provider.createSession(context, 'session-a', {});

    expect(provider.supports('groups')).toBe(true);
    const info = await provider.getGroupInfo(context, { sessionId: 'session-a', chatId: group });
    expect(info).toMatchObject({ chatId: group });
    expect(info!.participants[0]).toMatchObject({ whatsappId: participante.jid, role: 'admin' });
  });
});
