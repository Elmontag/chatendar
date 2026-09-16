/**
 * Vorlaufzeiten-Berechnung.
 *
 * Pro Termin werden bis zu MAX_REMINDERS (Default 2) Vorlaufzeiten bestimmt:
 *   - global aus DEFAULT_REMINDERS (z. B. "1d,2h")
 *   - pro Termin überschreibbar über die ICS-Property REMINDER_PROPERTY
 *     (z. B. X-WA-REMIND:1d,2h)
 *
 * Der Versandzeitpunkt ist `Termin-Start minus Vorlaufzeit`. Fällig ist eine
 * Erinnerung, wenn dieser Zeitpunkt im aktuellen Prüffenster liegt:
 *
 *     now - CHECK_WINDOW_MINUTES  <=  sendAt  <=  now
 *
 * Das Fenster verhindert, dass nach einer längeren Ausfallzeit plötzlich alte
 * Erinnerungen nachgefeuert werden. Mit CATCH_UP=true wird stattdessen alles
 * nachgeholt, solange der Termin noch in der Zukunft liegt.
 */

import { formatDurationHuman, formatDurationShort, parseDurationList } from './duration.js';
import { log } from '../logger.js';

/** Status-Codes für übersprungene Erinnerungen (erscheinen im Log). */
export const SKIP_REASONS = {
  ALREADY_SENT: 'bereits-versendet',
  NOT_DUE_YET: 'noch-nicht-faellig',
  EVENT_STARTED: 'termin-bereits-gestartet',
  WINDOW_MISSED: 'prueffenster-verpasst',
};

/**
 * Vorlaufzeiten eines Termins auflösen (Override vor Default).
 *
 * @returns {Array<{raw: string, minutes: number}>} absteigend sortiert
 */
export function resolveOffsets(event, config) {
  const propertyName = config.reminderProperty;
  // node-ical entfernt das "X-"-Präfix – icsSource legt beide Schreibweisen ab.
  const override =
    event.customProps?.[propertyName] ??
    event.customProps?.[propertyName.replace(/^X-/i, '')] ??
    null;

  let offsets;
  if (override) {
    try {
      offsets = parseDurationList(override);
      if (offsets.length === 0) throw new Error('keine Werte angegeben');
    } catch (error) {
      log.warn(
        `Termin "${event.titel}": ${propertyName}="${override}" ist ungültig (${error.message}) – ` +
          `es gelten die Default-Vorlaufzeiten "${config.defaultReminders}"`,
      );
      offsets = parseDurationList(config.defaultReminders);
    }
  } else {
    offsets = parseDurationList(config.defaultReminders);
  }

  // Duplikate entfernen (z. B. "2h,120m"), Reihenfolge der Angabe beibehalten.
  const unique = [];
  const seen = new Set();
  for (const offset of offsets) {
    if (seen.has(offset.minutes)) continue;
    seen.add(offset.minutes);
    unique.push(offset);
  }

  // Obergrenze durchsetzen: die zuerst genannten Werte gewinnen.
  if (unique.length > config.maxReminders) {
    const dropped = unique.slice(config.maxReminders).map((offset) => offset.raw);
    log.warn(
      `Termin "${event.titel}": mehr als ${config.maxReminders} Vorlaufzeiten angegeben – ` +
        `ignoriert: ${dropped.join(', ')}`,
    );
  }

  return unique
    .slice(0, config.maxReminders)
    .sort((a, b) => b.minutes - a.minutes);
}

/**
 * Alle geplanten Erinnerungen eines Termins (unabhängig von der Fälligkeit).
 *
 * @returns {Array<object>} Erinnerungen mit berechnetem `sendAt`
 */
export function buildReminders(event, config) {
  return resolveOffsets(event, config).map((offset) => ({
    event,
    eventId: event.id,
    offsetMinutes: offset.minutes,
    offsetRaw: offset.raw,
    offsetKey: formatDurationShort(offset.minutes),
    offsetLabel: formatDurationHuman(offset.minutes),
    sendAt: new Date(event.start.getTime() - offset.minutes * 60000),
  }));
}

/**
 * Fällige Erinnerungen für einen Lauf bestimmen.
 *
 * @param {Array<object>} events   bereits selektierte Termine
 * @param {object} config
 * @param {object} options
 * @param {Date} options.now       Referenzzeitpunkt des Laufs
 * @param {(eventId: string, offsetMinutes: number) => boolean} options.isSent
 *        Prüft den persistierten State (Duplikatsvermeidung)
 * @returns {{due: Array<object>, skipped: Array<object>}}
 */
export function evaluateReminders(events, config, { now, isSent = () => false }) {
  const due = [];
  const skipped = [];
  const windowStart = new Date(now.getTime() - config.checkWindowMinutes * 60000);

  for (const event of events) {
    for (const reminder of buildReminders(event, config)) {
      // 1. Bereits verschickt? Dann in keinem Fall erneut.
      if (isSent(reminder.eventId, reminder.offsetMinutes)) {
        skipped.push({ ...reminder, reason: SKIP_REASONS.ALREADY_SENT });
        continue;
      }

      // 2. Termin läuft schon / ist vorbei – eine Erinnerung wäre sinnlos.
      if (event.start <= now) {
        skipped.push({ ...reminder, reason: SKIP_REASONS.EVENT_STARTED });
        continue;
      }

      // 3. Versandzeitpunkt noch nicht erreicht.
      if (reminder.sendAt > now) {
        skipped.push({ ...reminder, reason: SKIP_REASONS.NOT_DUE_YET });
        continue;
      }

      // 4. Versandzeitpunkt liegt vor dem Prüffenster (z. B. Tool lief länger nicht).
      if (reminder.sendAt < windowStart && !config.catchUp) {
        skipped.push({ ...reminder, reason: SKIP_REASONS.WINDOW_MISSED });
        continue;
      }

      due.push(reminder);
    }
  }

  return { due, skipped };
}
