/**
 * Kalenderquelle: CalDAV / Nextcloud (SOURCE=caldav).
 *
 * CalDAV liefert Kalenderobjekte als iCalendar-Daten. Das Parsing und Mapping
 * in die interne Event-Struktur ist identisch zur lokalen ICS-Datei und wird
 * deshalb aus `icsSource.js` wiederverwendet.
 */

import { createDAVClient } from 'tsdav';

import { eventsFromParsedCalendar, parseIcsString } from './icsSource.js';
import { log } from '../logger.js';

function missingConfig(config) {
  return [
    ['CALDAV_URL', config.caldav?.url],
    ['CALDAV_USERNAME', config.caldav?.username],
    ['CALDAV_PASSWORD', config.caldav?.password],
    ['CALDAV_CALENDAR', config.caldav?.calendar],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

function calendarLabel(calendar) {
  return calendar.displayName ?? calendar.url ?? calendar.href ?? '(ohne Name)';
}

function matchesCalendar(calendar, wanted) {
  const normalized = String(wanted).trim().toLowerCase();
  return [calendar.displayName, calendar.url, calendar.href]
    .filter(Boolean)
    .some((value) => String(value).trim().toLowerCase() === normalized);
}

async function parseCalendarObject(object, config, range) {
  const data = object.data ?? object.calendarData;
  if (!data) return [];
  const label = object.url ?? object.href ?? 'CalDAV-Objekt';
  const parsed = await parseIcsString(String(data), label);
  return eventsFromParsedCalendar(parsed, config, range, label);
}

export async function fetchEvents(config, { from, to }, { createClient = createDAVClient } = {}) {
  const missing = missingConfig(config);
  if (missing.length > 0) {
    throw new Error(`CalDAV-Konfiguration unvollständig: ${missing.join(', ')} muss gesetzt sein`);
  }

  let client;
  try {
    client = await createClient({
      serverUrl: config.caldav.url,
      credentials: {
        username: config.caldav.username,
        password: config.caldav.password,
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
  } catch (error) {
    throw new Error(`CalDAV-Verbindung konnte nicht aufgebaut werden: ${error.message}`);
  }

  let calendars;
  try {
    calendars = await client.fetchCalendars();
  } catch (error) {
    throw new Error(`CalDAV-Kalender konnten nicht geladen werden: ${error.message}`);
  }

  const calendar = calendars.find((candidate) => matchesCalendar(candidate, config.caldav.calendar));
  if (!calendar) {
    const available = calendars.map(calendarLabel).join(', ') || '(keine Kalender gefunden)';
    throw new Error(`CalDAV-Kalender "${config.caldav.calendar}" nicht gefunden. Verfügbar: ${available}`);
  }

  let objects;
  try {
    objects = await client.fetchCalendarObjects({
      calendar,
      timeRange: { start: from.toISOString(), end: to.toISOString() },
    });
  } catch (error) {
    throw new Error(`CalDAV-Termine konnten nicht geladen werden (${calendarLabel(calendar)}): ${error.message}`);
  }

  const events = [];
  for (const object of objects) {
    events.push(...await parseCalendarObject(object, config, { from, to }));
  }

  log.debug(`CalDAV gelesen: ${calendarLabel(calendar)} – ${objects.length} Objekt(e), ${events.length} Termin(e)`);
  return events;
}
