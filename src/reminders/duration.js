/**
 * Parsen und Formatieren von Vorlaufzeiten ("1d", "2h", "90m", "1w").
 *
 * Bewusst als eigenes Modul, weil sowohl die Config-Validierung als auch der
 * Scheduler darauf zugreifen.
 */

const UNIT_TO_MINUTES = {
  m: 1,
  min: 1,
  h: 60,
  std: 60,
  d: 60 * 24,
  t: 60 * 24, // "t" wie Tag
  w: 60 * 24 * 7,
};

/**
 * Wandelt eine Vorlaufzeit-Angabe in Minuten um.
 *
 * Erlaubt sind Kombinationen aus Zahl + Einheit, z. B. "1d", "2h", "30m",
 * "1w" sowie zusammengesetzte Angaben wie "1d12h". Eine reine Zahl wird als
 * Minuten interpretiert.
 *
 * @param {string} text
 * @returns {number} Minuten (> 0)
 */
export function parseDurationToMinutes(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`Vorlaufzeit muss ein String sein (ist: ${typeof text})`);
  }
  // Leerzeichen komplett entfernen, damit "90 min" wie "90min" behandelt wird.
  const normalized = text.toLowerCase().replace(/\s+/g, '');
  if (normalized === '') throw new Error('Leere Vorlaufzeit');

  // Reine Zahl -> Minuten
  if (/^\d+$/.test(normalized)) {
    const minutes = Number.parseInt(normalized, 10);
    if (minutes <= 0) throw new Error(`Vorlaufzeit muss größer als 0 sein: "${text}"`);
    return minutes;
  }

  const pattern = /(\d+)(min|std|[mhdtw])/g;
  let total = 0;
  let matchedLength = 0;
  let match;
  while ((match = pattern.exec(normalized)) !== null) {
    total += Number.parseInt(match[1], 10) * UNIT_TO_MINUTES[match[2]];
    matchedLength += match[0].length;
  }

  // Alles, was nicht vollständig durch das Muster abgedeckt ist, ist ein Fehler.
  if (total === 0 || matchedLength !== normalized.length) {
    throw new Error(`Unbekanntes Format für Vorlaufzeit: "${text}" (erlaubt z. B. 1d, 2h, 30m, 1w)`);
  }
  return total;
}

/**
 * Normalisierte Kurzschreibweise – dient als stabiler Schlüssel und für Logs.
 * @param {number} minutes
 * @returns {string} z. B. "1d", "2h30m"
 */
export function formatDurationShort(minutes) {
  if (minutes <= 0) return '0m';
  const parts = [];
  let rest = minutes;
  for (const [unit, size] of [
    ['w', UNIT_TO_MINUTES.w],
    ['d', UNIT_TO_MINUTES.d],
    ['h', UNIT_TO_MINUTES.h],
    ['m', 1],
  ]) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count}${unit}`);
      rest -= count * size;
    }
  }
  return parts.join('');
}

/**
 * Menschenlesbare deutsche Schreibweise für die Nachrichten-Templates.
 * @param {number} minutes
 * @returns {string} z. B. "1 Tag", "2 Stunden", "30 Minuten"
 */
export function formatDurationHuman(minutes) {
  const units = [
    ['w', UNIT_TO_MINUTES.w, 'Woche', 'Wochen'],
    ['d', UNIT_TO_MINUTES.d, 'Tag', 'Tage'],
    ['h', UNIT_TO_MINUTES.h, 'Stunde', 'Stunden'],
    ['m', 1, 'Minute', 'Minuten'],
  ];
  const parts = [];
  let rest = minutes;
  for (const [, size, singular, plural] of units) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count} ${count === 1 ? singular : plural}`);
      rest -= count * size;
    }
  }
  if (parts.length === 0) return '0 Minuten';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} und ${parts[parts.length - 1]}`;
}

/**
 * Kommaseparierte Liste von Vorlaufzeiten parsen.
 * @param {string} text z. B. "1d,2h"
 * @returns {Array<{raw: string, minutes: number}>}
 */
export function parseDurationList(text) {
  return String(text)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((raw) => ({ raw, minutes: parseDurationToMinutes(raw) }));
}
