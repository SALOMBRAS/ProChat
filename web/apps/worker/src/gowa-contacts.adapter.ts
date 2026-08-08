/**
 * GOWA contact and group structs -> neutral shapes.
 *
 * Field names from the GOWA source at commit `be8155c5`:
 *   MyListContactsResponseData { jid, name }                 (domains/user/account.go)
 *   GroupParticipant           { jid, phone_number, lid,
 *                                display_name, is_admin,
 *                                is_super_admin }            (domains/group/group.go)
 *   GetGroupParticipantsResponse { group_id, name, participants }
 *
 * The contact list is deliberately poor — `jid` and `name`, nothing else. No
 * phone, no LID, no avatar, no business profile. Those come from identity
 * enrichment (events, `/user/avatar`, group participants), never invented here.
 */

export type CanonicalContact = { whatsappId: string; name: string | null };
export type CanonicalParticipant = {
  whatsappId: string;
  /** Only when GOWA states it explicitly. Never derived from @lid digits. */
  phone: string | null;
  lid: string | null;
  displayName: string | null;
  role: 'superadmin' | 'admin' | 'member';
};
export type CanonicalGroup = { chatId: string; subject: string | null; participants: CanonicalParticipant[] };

export function gowaContact(item: Record<string, unknown>): CanonicalContact | undefined {
  const whatsappId = text(item.jid);
  if (!whatsappId) return undefined;
  return { whatsappId, name: displayName(item.name) };
}

/**
 * `phone_number` and `lid` arrive as separate fields, which is exactly the
 * trustworthy evidence the alias system needs: the phone is stated by the
 * provider, never inferred from the LID's digits.
 */
export function gowaParticipant(item: Record<string, unknown>): CanonicalParticipant | undefined {
  const whatsappId = text(item.jid);
  if (!whatsappId) return undefined;
  const phone = text(item.phone_number, 32);
  const lid = text(item.lid);
  return {
    whatsappId,
    // A phone that is really a LID is not a phone; refuse rather than pretend.
    phone: phone && !phone.toLowerCase().endsWith('@lid') ? phone.replace(/\D/g, '') || null : null,
    lid: lid && lid.toLowerCase().endsWith('@lid') ? lid : null,
    displayName: displayName(item.display_name),
    role: item.is_super_admin === true ? 'superadmin' : item.is_admin === true ? 'admin' : 'member',
  };
}

/** `group_id` is the conversation. A participant is only ever a member. */
export function gowaGroup(response: Record<string, unknown>): CanonicalGroup | undefined {
  const chatId = text(response.group_id);
  if (!chatId || !chatId.toLowerCase().endsWith('@g.us')) return undefined;
  const raw = Array.isArray(response.participants) ? response.participants : [];
  return {
    chatId,
    subject: displayName(response.name),
    participants: raw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map(gowaParticipant)
      .filter((item): item is CanonicalParticipant => Boolean(item)),
  };
}

/** A name that is an identifier, or just a phone number, is not a name — it
 * would put a JID in front of the operator. */
function displayName(value: unknown): string | null {
  const name = text(value, 240)?.trim();
  if (!name) return null;
  if (/@(s\.whatsapp\.net|c\.us|g\.us|lid)$/i.test(name)) return null;
  return /[^\d()\s+.\-]/u.test(name) ? name : null;
}

function text(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : undefined;
}
