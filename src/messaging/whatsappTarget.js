export const WHATSAPP_TARGET_TYPES = Object.freeze({
  GROUP: 'group',
  PERSON: 'person',
});

export function normalizePhoneNumber(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Telefonnummer darf nicht leer sein');
  if (!/^[+\d\s()./-]+$/.test(raw)) {
    throw new Error(`Telefonnummer "${raw}" enthält ungültige Zeichen`);
  }

  const compact = raw.replace(/[\s()./-]/g, '');
  if (!/^(?:\+|00)?[1-9]\d{7,14}$/.test(compact)) {
    throw new Error(
      `Telefonnummer "${raw}" muss international mit Ländervorwahl angegeben werden (z. B. +4915112345678)`,
    );
  }
  const digits = compact.startsWith('00') ? compact.slice(2) : compact.startsWith('+') ? compact.slice(1) : compact;
  return `+${digits}`;
}

export function phoneToJid(value) {
  return `${normalizePhoneNumber(value).slice(1)}@s.whatsapp.net`;
}

export function targetJid(target) {
  if (target?.type === WHATSAPP_TARGET_TYPES.PERSON) return phoneToJid(target.phone);
  return String(target?.id ?? '').trim();
}

export function targetAddress(target) {
  if (target?.type === WHATSAPP_TARGET_TYPES.PERSON) return normalizePhoneNumber(target.phone);
  return String(target?.id ?? '').trim();
}

export function targetKindLabel(target) {
  return target?.type === WHATSAPP_TARGET_TYPES.PERSON ? 'Person' : 'Gruppe';
}
