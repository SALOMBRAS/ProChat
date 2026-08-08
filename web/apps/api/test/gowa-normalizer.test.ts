import { describe, expect, it } from 'vitest';
import { normalizeGowaEvent, type CanonicalWhatsAppEvent } from '../src/services/gowa-normalizer.js';

const group = '120363000000000001@g.us';
const participant = '5511999990002@s.whatsapp.net';
const direct = '5511999990001@s.whatsapp.net';

const one = (event: { event: string; payload: Record<string, unknown>; timestamp?: string }): CanonicalWhatsAppEvent => normalizeGowaEvent(event)[0];

describe('normalizador canônico GOWA', () => {
  describe('a regra que já custou quatro incidentes', () => {
    it('mensagem de grupo fica no grupo e o participante vira apenas autor', () => {
      const result = one({ event: 'message', payload: { id: 'm1', chat_id: group, from: participant, is_from_me: false, body: 'oi' } });

      expect(result).toMatchObject({ kind: 'message', conversation: { chatId: group, type: 'group' } });
      // O participante nunca pode virar a conversa.
      expect((result as { conversation: { chatId: string } }).conversation.chatId).not.toBe('5511999990002@c.us');
      expect((result as { author: { whatsappId: string } }).author.whatsappId).toBe('5511999990002@c.us');
    });

    it('nenhum evento com chat_id de grupo produz conversa direta', () => {
      for (const event of ['message', 'message.reaction', 'message.revoked', 'message.edited']) {
        const result = one({ event, payload: { id: 'm1', chat_id: group, from: participant, is_from_me: false, body: 'x', emoji: '👍' } });
        if (result.kind === 'ignored') continue;
        expect((result as { conversation: { type: string } }).conversation.type).toBe('group');
      }
    });

    it('chat_id ausente ou não conversacional é descartado, nunca resgatado pelo from', () => {
      expect(one({ event: 'message', payload: { id: 'm1', from: direct, is_from_me: false, body: 'oi' } })).toEqual({ kind: 'ignored', reason: 'invalid_chat' });
      expect(one({ event: 'message', payload: { id: 'm1', chat_id: 'status@broadcast', from: direct, is_from_me: false, body: 'oi' } })).toEqual({ kind: 'ignored', reason: 'invalid_chat' });
    });
  });

  describe('LID', () => {
    it('nunca deriva telefone dos dígitos de um @lid', () => {
      const result = one({ event: 'message', payload: { id: 'm1', chat_id: '251556368777322@lid', from: '251556368777322@lid', is_from_me: false, body: 'oi' } });

      expect((result as { author: { phone: string | null } }).author.phone).toBeNull();
      expect((result as { author: { lid: string | null } }).author.lid).toBe('251556368777322@lid');
    });

    it('guarda from_lid como alias quando vem junto do JID de telefone', () => {
      const result = one({ event: 'message', payload: { id: 'm1', chat_id: direct, from: direct, from_lid: '251556368777322@lid', is_from_me: false, body: 'oi' } });

      expect((result as { author: { phone: string | null; lid: string | null } }).author).toMatchObject({ phone: '5511999990001', lid: '251556368777322@lid' });
    });
  });

  describe('nomes visíveis', () => {
    it('recusa nome que na verdade é identificador ou telefone', () => {
      const result = one({ event: 'message', payload: { id: 'm1', chat_id: direct, from: direct, is_from_me: false, body: 'oi', sender_display_name: '5511999990001@s.whatsapp.net', from_name: '+55 11 99999-0001' } });

      expect((result as { author: { displayName: string | null; pushName: string | null } }).author).toMatchObject({ displayName: null, pushName: null });
    });
  });

  describe('mídia', () => {
    it('reconhece cada tipo e separa nota de voz de áudio', () => {
      const kinds = [
        ['image', { image: { url: 'https://gowa.invalid/a.jpg', caption: 'legenda' } }, 'image'],
        ['video', { video: { url: 'https://gowa.invalid/a.mp4' } }, 'video'],
        ['audio comum', { audio: { url: 'https://gowa.invalid/a.ogg' } }, 'audio'],
        ['nota de voz', { audio: { url: 'https://gowa.invalid/a.ogg', ptt: true } }, 'voice'],
        ['documento', { document: { url: 'https://gowa.invalid/a.pdf', filename: 'a.pdf' } }, 'document'],
        ['sticker', { sticker: { url: 'https://gowa.invalid/a.webp' } }, 'sticker'],
      ] as const;

      for (const [, payload, expected] of kinds) {
        const result = one({ event: 'message', payload: { id: 'm1', chat_id: direct, from: direct, is_from_me: false, ...payload } });
        expect((result as { media: { kind: string } }).media.kind).toBe(expected);
      }
    });

    it('nunca lê o file_path local do GOWA como fonte de mídia', () => {
      // Com auto-download ligado o GOWA manda um caminho do servidor dele.
      const result = one({ event: 'message', payload: { id: 'm1', chat_id: direct, from: direct, is_from_me: false, image: 'statics/media/deadbeef.jpg' } });

      // Sem url a mídia existe mas precisa ser baixada pelo endpoint; o caminho
      // do servidor não pode virar contrato nem chegar ao navegador.
      expect((result as { media: { url: string | null } }).media.url).toBeNull();
      expect(JSON.stringify(result)).not.toContain('statics/media');
    });
  });

  describe('localização e contato', () => {
    it('aceita coordenada como número e como string, e preserva o título', () => {
      const numeric = one({ event: 'message', payload: { id: 'm1', chat_id: direct, from: direct, is_from_me: false, location: { latitude: -23.5, longitude: -46.6, name: 'Loja' } } });
      const stringly = one({ event: 'message', payload: { id: 'm2', chat_id: direct, from: direct, is_from_me: false, location: { latitude: '-23.5', longitude: '-46.6' } } });

      expect((numeric as { location: unknown }).location).toEqual({ latitude: -23.5, longitude: -46.6, title: 'Loja' });
      expect((stringly as { location: unknown }).location).toEqual({ latitude: -23.5, longitude: -46.6, title: null });
    });

    it('normaliza cartão de contato único e múltiplo', () => {
      const result = one({ event: 'message', payload: { id: 'm1', chat_id: direct, from: direct, is_from_me: false, contacts: [{ name: 'Ana', phone: '5511999990002' }, { name: 'Bia', phone: '5511999990003' }] } });

      expect((result as { contacts: unknown[] }).contacts).toHaveLength(2);
      expect((result as { contacts: Array<{ fullName: string | null }> }).contacts[0].fullName).toBe('Ana');
    });
  });

  describe('reação, ack, edição e revogação', () => {
    it('aponta a reação para a mensagem reagida, não para o próprio evento', () => {
      const result = one({ event: 'message.reaction', payload: { id: 'evento', reacted_message_id: 'alvo', chat_id: direct, from: direct, emoji: '👍' } });

      expect(result).toMatchObject({ kind: 'reaction', messageId: 'alvo', emoji: '👍' });
    });

    it('trata emoji vazio como remoção de reação', () => {
      expect(one({ event: 'message.reaction', payload: { reacted_message_id: 'alvo', chat_id: direct, from: direct, emoji: '' } })).toMatchObject({ kind: 'reaction', emoji: '' });
    });

    it('expande um ack com vários ids e mapeia read_self para read', () => {
      const delivered = one({ event: 'message.ack', payload: { ids: ['a', 'b'], chat_id: direct, receipt_type: 'delivered' } });
      const read = one({ event: 'message.ack', payload: { ids: ['c'], chat_id: direct, receipt_type: 'read_self' } });

      expect(delivered).toMatchObject({ kind: 'ack', messageIds: ['a', 'b'], status: 'delivered' });
      expect(read).toMatchObject({ kind: 'ack', status: 'read' });
    });

    it('normaliza edição e revogação sem corromper estado', () => {
      expect(one({ event: 'message.edited', payload: { chat_id: direct, message_id: 'm1', body: 'corrigido' } })).toMatchObject({ kind: 'message.edited', messageId: 'm1', body: 'corrigido' });
      expect(one({ event: 'message.revoked', payload: { chat_id: direct, message_id: 'm1' } })).toMatchObject({ kind: 'message.revoked', messageId: 'm1' });
    });
  });

  describe('chamada', () => {
    it('abre a conversa pelo autor, porque call.offer não traz chat_id', () => {
      const result = one({ event: 'call.offer', payload: { from: direct, call_id: 'call-1' } });

      expect(result).toMatchObject({ kind: 'call', conversation: { chatId: '5511999990001@c.us', type: 'direct' }, callId: 'call-1' });
    });

    it('nunca aceita grupo como origem de chamada', () => {
      expect(one({ event: 'call.offer', payload: { from: group, call_id: 'call-1' } })).toEqual({ kind: 'ignored', reason: 'invalid_chat' });
    });
  });

  describe('descartes', () => {
    it('ignora envio nosso, evento desconhecido e mensagem sem conteúdo', () => {
      expect(one({ event: 'message', payload: { id: 'm1', chat_id: direct, is_from_me: true, body: 'x' } })).toEqual({ kind: 'ignored', reason: 'own_message' });
      expect(one({ event: 'newsletter.message', payload: {} })).toEqual({ kind: 'ignored', reason: 'unsupported_event' });
      expect(one({ event: 'message', payload: { id: 'm1', chat_id: direct, from: direct, is_from_me: false } })).toEqual({ kind: 'ignored', reason: 'empty' });
    });
  });
});
