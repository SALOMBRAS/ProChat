export type WhatsAppIdentifierKind = 'direct' | 'lid' | 'group' | 'technical' | 'unknown';

/**
 * Engine-neutral WhatsApp identifier boundary. Adapted from the classification
 * rules documented in OpenWA's `wa-id.ts`; this is deliberately independent of
 * any engine SDK and retains ChatPro's phone validation at the domain boundary.
 */
export function normalizeWhatsAppIdentifier(value: string | null | undefined): string | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  const [local, domain] = raw.split('@', 2);
  if (!local || !domain) return /^\d+$/.test(raw) ? raw : undefined;
  const user = local.split(':', 1)[0]; // WA device suffix, e.g. 5511:12@s.whatsapp.net
  if (!user) return undefined;
  if (domain === 's.whatsapp.net' || domain === 'c.us') return `${user}@c.us`;
  if (domain === 'lid') return `${user}@lid`;
  if (domain === 'g.us') return `${user}@g.us`;
  return `${user}@${domain}`;
}

export function whatsappIdentifierKind(value: string | null | undefined): WhatsAppIdentifierKind {
  const normalized = normalizeWhatsAppIdentifier(value);
  if (!normalized) return 'unknown';
  if (normalized.endsWith('@c.us')) return 'direct';
  if (normalized.endsWith('@lid')) return 'lid';
  if (normalized.endsWith('@g.us')) return 'group';
  if (normalized === 'status@broadcast' || normalized.endsWith('@broadcast') || normalized.endsWith('@newsletter')) return 'technical';
  return 'unknown';
}

export function isDirectWhatsAppIdentifier(value: string | null | undefined): boolean {
  const kind = whatsappIdentifierKind(value);
  return kind === 'direct' || kind === 'lid';
}
