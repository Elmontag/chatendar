/**
 * Zeitzonen-Helfer.
 *
 * Bewusst ohne Luxon/Moment: alles, was gebraucht wird, lässt sich mit
 * Intl.DateTimeFormat erledigen – das spart eine Abhängigkeit und die
 * IANA-Datenbank bringt Node ohnehin mit.
 */

const formatterCache = new Map();

function partsFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Wanduhr-Bestandteile eines Zeitpunkts in einer Zeitzone. */
export function getWallClockParts(date, timeZone) {
  const map = {};
  for (const part of partsFormatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Mitternacht wird je nach ICU als 24 ausgegeben.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * UTC-Offset einer Zeitzone zu einem bestimmten Zeitpunkt, in Minuten.
 * Östlich von UTC positiv (Europe/Berlin: +60 bzw. +120 in der Sommerzeit).
 */
export function getTimeZoneOffsetMinutes(date, timeZone) {
  const parts = getWallClockParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}

/**
 * Wandelt eine Wanduhrzeit in einer Zeitzone in einen echten Zeitpunkt um.
 * Zwei Iterationen, damit auch Zeitumstellungstage korrekt getroffen werden.
 */
export function zonedTimeToInstant({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = new Date(naive);
  for (let i = 0; i < 2; i += 1) {
    const offset = getTimeZoneOffsetMinutes(instant, timeZone);
    instant = new Date(naive - offset * 60000);
  }
  return instant;
}

/**
 * Mitternacht eines Kalendertages (aus den UTC-Anteilen von `date`) in der
 * angegebenen Zeitzone. Wird für ganztägige Termine gebraucht: node-ical
 * liefert dafür Mitternacht UTC, gemeint ist aber Mitternacht lokal.
 */
export function localMidnightForUtcDate(date, timeZone) {
  return zonedTimeToInstant(
    { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
    timeZone,
  );
}

const displayCache = new Map();

function displayFormatter(key, locale, options) {
  let formatter = displayCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    displayCache.set(key, formatter);
  }
  return formatter;
}

/**
 * Datum und Uhrzeit für die Nachrichten-Templates aufbereiten.
 *
 * @param {Date} date
 * @param {{timezone: string, locale: string}} config
 * @returns {{datum: string, datumKurz: string, wochentag: string, uhrzeit: string}}
 */
export function formatForMessage(date, { timezone, locale }) {
  const datum = displayFormatter(`full:${locale}:${timezone}`, locale, {
    timeZone: timezone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);

  const datumKurz = displayFormatter(`short:${locale}:${timezone}`, locale, {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);

  const wochentag = displayFormatter(`weekday:${locale}:${timezone}`, locale, {
    timeZone: timezone,
    weekday: 'long',
  }).format(date);

  const uhrzeit = displayFormatter(`time:${locale}:${timezone}`, locale, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);

  return { datum, datumKurz, wochentag, uhrzeit };
}

/** Kompakte ISO-ähnliche Ausgabe in lokaler Zeitzone – nur für Logs. */
export function formatForLog(date, timezone) {
  const p = getWallClockParts(date, timezone);
  const pad = (value) => String(value).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
