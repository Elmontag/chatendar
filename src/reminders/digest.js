/**
 * Wochenübersicht ("Digest").
 *
 * Unabhängig von den Einzel-Erinnerungen kann zu einem festen Wochentermin
 * (z. B. freitags 18:00) eine Liste aller Termine der kommenden Woche
 * verschickt werden.
 *
 * Fälligkeit funktioniert wie bei den Erinnerungen über das Prüffenster:
 * Der geplante Versandzeitpunkt der laufenden Woche muss zwischen
 * "jetzt - CHECK_WINDOW_MINUTES" und "jetzt" liegen. Über den State wird
 * sichergestellt, dass die Übersicht pro Woche nur einmal rausgeht.
 */

import { getWallClockParts, zonedTimeToInstant } from '../util/datetime.js';
import { parseDurationToMinutes } from './duration.js';

/** Wochentage in deutscher und englischer Kurz-/Langform sowie als Zahl. */
const WEEKDAYS = {
  so: 0, son: 0, sonntag: 0, sun: 0, sunday: 0, 0: 0, 7: 0,
  mo: 1, mon: 1, montag: 1, monday: 1, 1: 1,
  di: 2, die: 2, dienstag: 2, tue: 2, tuesday: 2, 2: 2,
  mi: 3, mit: 3, mittwoch: 3, wed: 3, wednesday: 3, 3: 3,
  do: 4, don: 4, donnerstag: 4, thu: 4, thursday: 4, 4: 4,
  fr: 5, fre: 5, freitag: 5, fri: 5, friday: 5, 5: 5,
  sa: 6, sam: 6, samstag: 6, sat: 6, saturday: 6, 6: 6,
};

/**
 * Wochentag-Angabe in 0..6 (0 = Sonntag) umwandeln.
 * @param {string|number} value z. B. "fr", "Freitag", "friday", 5
 */
export function parseWeekday(value) {
  const key = String(value).trim().toLowerCase();
  const day = WEEKDAYS[key];
  if (day === undefined) {
    throw new Error(
      `Unbekannter Wochentag: "${value}" (erlaubt z. B. mo, di, mi, do, fr, sa, so oder 0-6)`,
    );
  }
  return day;
}

/**
 * Uhrzeit "HH:MM" parsen.
 * @returns {{hour: number, minute: number}}
 */
export function parseTimeOfDay(value) {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(value).trim());
  if (!match) throw new Error(`Ungültige Uhrzeit: "${value}" (erwartet HH:MM, z. B. 18:00)`);
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  if (hour > 23 || minute > 59) throw new Error(`Ungültige Uhrzeit: "${value}"`);
  return { hour, minute };
}

/** Wochentag (0 = Sonntag) eines Zeitpunkts in der konfigurierten Zeitzone. */
function localWeekday(date, timezone) {
  const { year, month, day } = getWallClockParts(date, timezone);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Lokales Kalenderdatum um `days` verschieben. */
function shiftLocalDate({ year, month, day }, days) {
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Der letzte geplante Versandzeitpunkt, der nicht in der Zukunft liegt.
 * Beispiel: Config "freitags 18:00", jetzt ist Samstag -> gestern 18:00.
 *
 * @param {Date} now
 * @param {object} config
 * @returns {Date}
 */
export function lastScheduledInstant(now, config) {
  const { timezone } = config;
  const targetDay = parseWeekday(config.digestDay);
  const { hour, minute } = parseTimeOfDay(config.digestTime);

  const parts = getWallClockParts(now, timezone);
  const currentDay = localWeekday(now, timezone);

  // Tage zurück bis zum jüngsten Vorkommen des Zieltags (0 = heute).
  const daysBack = (currentDay - targetDay + 7) % 7;
  let date = shiftLocalDate(parts, -daysBack);
  let instant = zonedTimeToInstant({ ...date, hour, minute }, timezone);

  // Heute ist zwar der richtige Tag, die Uhrzeit aber noch nicht erreicht.
  if (instant > now) {
    date = shiftLocalDate(date, -7);
    instant = zonedTimeToInstant({ ...date, hour, minute }, timezone);
  }
  return instant;
}

/**
 * Der nächste geplante Versandzeitpunkt in der Zukunft – nur für die Vorschau.
 * @returns {Date}
 */
export function nextScheduledInstant(now, config) {
  const previous = lastScheduledInstant(now, config);
  const parts = getWallClockParts(previous, config.timezone);
  const { hour, minute } = parseTimeOfDay(config.digestTime);
  return zonedTimeToInstant({ ...shiftLocalDate(parts, 7), hour, minute }, config.timezone);
}

/**
 * Zeitraum, den die Übersicht abdeckt.
 *
 * DIGEST_RANGE:
 *   "7d" (o. ä.) – rollierend ab dem Versandzeitpunkt
 *   "next-week"  – die nächste volle Kalenderwoche (Montag bis Sonntag)
 *
 * @param {Date} scheduledAt Versandzeitpunkt der Übersicht
 * @param {object} config
 * @returns {{from: Date, to: Date}}
 */
export function digestRange(scheduledAt, config) {
  const { timezone } = config;
  const mode = String(config.digestRange).trim().toLowerCase();

  if (mode === 'next-week' || mode === 'kalenderwoche') {
    const parts = getWallClockParts(scheduledAt, timezone);
    const currentDay = localWeekday(scheduledAt, timezone);
    // Immer der nächste echte Montag (bei Versand am Montag: der übernächste).
    const daysUntilMonday = ((1 - currentDay + 7) % 7) || 7;
    const monday = shiftLocalDate(parts, daysUntilMonday);
    const from = zonedTimeToInstant({ ...monday, hour: 0, minute: 0 }, timezone);
    const to = zonedTimeToInstant({ ...shiftLocalDate(monday, 7), hour: 0, minute: 0 }, timezone);
    return { from, to };
  }

  const minutes = parseDurationToMinutes(mode);
  return { from: scheduledAt, to: new Date(scheduledAt.getTime() + minutes * 60000) };
}

/** Stabiler State-Schlüssel – eine Übersicht pro geplantem Zeitpunkt. */
export function digestStateKey(scheduledAt) {
  return `__digest__#${scheduledAt.toISOString()}`;
}

/**
 * Ist die Wochenübersicht in diesem Lauf fällig?
 *
 * @param {object} config
 * @param {object} options
 * @param {Date} options.now
 * @param {(eventId: string, offsetMinutes: number) => boolean} [options.isSent]
 * @returns {{due: boolean, reason: string, scheduledAt: Date, stateKey: string, range: object}}
 */
export function evaluateDigest(config, { now, isSent = () => false }) {
  const scheduledAt = lastScheduledInstant(now, config);
  const stateKey = digestStateKey(scheduledAt);
  const range = digestRange(scheduledAt, config);
  const base = { scheduledAt, stateKey, range };

  if (!config.digestEnabled) return { ...base, due: false, reason: 'deaktiviert' };
  if (isSent(stateKey, 0)) return { ...base, due: false, reason: 'bereits-versendet' };

  const windowStart = new Date(now.getTime() - config.checkWindowMinutes * 60000);
  if (scheduledAt < windowStart && !config.catchUp) {
    return { ...base, due: false, reason: 'prueffenster-verpasst' };
  }

  return { ...base, due: true, reason: 'faellig' };
}

/**
 * Termine für die Übersicht auswählen.
 * @param {Array<object>} events bereits selektierte Termine
 * @param {{from: Date, to: Date}} range
 */
export function eventsInRange(events, { from, to }) {
  return events
    .filter((event) => event.start >= from && event.start < to)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}
