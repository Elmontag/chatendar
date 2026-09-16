/**
 * Kalenderquelle: lokale ICS-Datei (SOURCE=file).
 *
 * Besonderheiten, die hier abgefangen werden:
 *  - node-ical entfernt beim Parsen das "X-"-Präfix von Custom-Properties
 *    (aus X-WA-REMIND wird der Key WA-REMIND). Wir legen beide Schreibweisen ab.
 *  - Serientermine (RRULE) werden auf einzelne Instanzen im Abfragefenster
 *    expandiert, inklusive EXDATE-Ausnahmen und RECURRENCE-ID-Overrides.
 *  - Ganztägige Termine liefert node-ical als Mitternacht UTC; gemeint ist
 *    Mitternacht in der konfigurierten Zeitzone.
 */

import fs from 'node:fs';

import ical from 'node-ical';

import { createEvent } from './calendarSource.js';
import { localMidnightForUtcDate } from '../util/datetime.js';
import { log } from '../logger.js';

/** Keys, die node-ical für Custom-Properties vergibt: GROSSBUCHSTABEN mit Bindestrichen. */
const CUSTOM_PROP_KEY = /^[A-Z][A-Z0-9-]*$/;

/** node-ical liefert Property-Werte mal als String, mal als {params, val}. */
function propValue(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && typeof raw.val === 'string') return raw.val;
  return null;
}

/**
 * Custom-Properties einsammeln.
 * Jeder Wert wird unter dem Originalschlüssel UND mit "X-"-Präfix abgelegt,
 * damit die Config den Namen so schreiben kann, wie er im ICS steht.
 */
function collectCustomProps(component) {
  const props = {};
  for (const [key, raw] of Object.entries(component)) {
    if (!CUSTOM_PROP_KEY.test(key)) continue;
    const value = propValue(raw);
    if (value === null) continue;
    props[key] = value;
    if (!key.startsWith('X-')) props[`X-${key}`] = value;
  }
  return props;
}

/** CATEGORIES kann Array, kommaseparierter String oder {val} sein. */
function collectCategories(component) {
  const raw = component.categories;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(propValue(raw) ?? '').split(',');
  return list.map((entry) => String(entry).trim()).filter(Boolean);
}

/** Ganztägige Termine auf lokale Mitternacht umrechnen. */
function normalizeStart(date, isAllDay, timezone) {
  if (!isAllDay) return date;
  return localMidnightForUtcDate(date, timezone);
}

/** Interner Termin aus einem VEVENT (bzw. einer Serieninstanz). */
function toEvent(component, { id, start, end, serie, timezone }) {
  const isAllDay = component.datetype === 'date';
  return createEvent({
    id,
    uid: component.uid,
    titel: propValue(component.summary) ?? '(ohne Titel)',
    start: normalizeStart(start, isAllDay, timezone),
    ende: end ? normalizeStart(end, isAllDay, timezone) : null,
    ort: propValue(component.location),
    kategorien: collectCategories(component),
    customProps: collectCustomProps(component),
    ganztags: isAllDay,
    serie,
  });
}

/**
 * Serientermin auf Einzelinstanzen im Zeitfenster expandieren.
 *
 * node-ical korrigiert Sommer-/Winterzeit bereits in `rrule.between()`,
 * daher können die zurückgegebenen Zeitpunkte direkt verwendet werden.
 */
function expandRecurrence(component, { from, to, timezone }) {
  const events = [];
  const masterStart = component.start;
  const masterEnd = component.end;
  const durationMs =
    masterEnd instanceof Date && masterStart instanceof Date ? masterEnd.getTime() - masterStart.getTime() : 0;

  let occurrences;
  try {
    occurrences = component.rrule.between(from, to, true);
  } catch (error) {
    log.warn(`Serientermin "${component.uid}" konnte nicht expandiert werden: ${error.message}`);
    return events;
  }

  for (const occurrence of occurrences) {
    // node-ical schlüsselt EXDATE/RECURRENCE-ID über das UTC-Datum (YYYY-MM-DD).
    const key = occurrence.toISOString().slice(0, 10);

    if (component.exdate && component.exdate[key]) continue; // Ausnahme: findet nicht statt

    const override = component.recurrences ? component.recurrences[key] : undefined;
    if (override) {
      // Verschobene/geänderte Einzelinstanz: eigene Daten verwenden.
      events.push(
        toEvent(override, {
          id: `${component.uid}#${override.start.toISOString()}`,
          start: override.start,
          end: override.end ?? null,
          serie: true,
          timezone,
        }),
      );
      continue;
    }

    events.push(
      toEvent(component, {
        id: `${component.uid}#${occurrence.toISOString()}`,
        start: occurrence,
        end: durationMs > 0 ? new Date(occurrence.getTime() + durationMs) : null,
        serie: true,
        timezone,
      }),
    );
  }
  return events;
}

/**
 * Termine aus der ICS-Datei laden.
 *
 * @param {object} config
 * @param {{from: Date, to: Date}} range
 * @returns {Promise<Array<object>>}
 */
export async function fetchEvents(config, { from, to }) {
  const { icsPath, timezone } = config;

  if (!fs.existsSync(icsPath)) {
    throw new Error(`ICS-Datei nicht gefunden: ${icsPath} (Config: ICS_PATH)`);
  }

  let parsed;
  try {
    parsed = await ical.async.parseFile(icsPath);
  } catch (error) {
    throw new Error(`ICS-Datei konnte nicht geparst werden (${icsPath}): ${error.message}`);
  }

  const events = [];
  let recurringCount = 0;

  for (const component of Object.values(parsed)) {
    if (!component || component.type !== 'VEVENT') continue;
    if (!(component.start instanceof Date) || Number.isNaN(component.start.getTime())) {
      log.warn(`Termin "${component.uid ?? '?'}" ohne gültiges DTSTART – wird übersprungen`);
      continue;
    }

    if (component.rrule) {
      recurringCount += 1;
      events.push(...expandRecurrence(component, { from, to, timezone }));
      continue;
    }

    const event = toEvent(component, {
      id: component.uid,
      start: component.start,
      end: component.end ?? null,
      serie: false,
      timezone,
    });

    // Einzeltermine außerhalb des Fensters interessieren uns nicht.
    if (event.start >= from && event.start <= to) events.push(event);
  }

  log.debug(
    `ICS gelesen: ${icsPath} – ${events.length} Termin(e) im Fenster, davon aus ${recurringCount} Serie(n) expandiert`,
  );
  return events;
}
