/**
 * Kalenderquelle: CalDAV / Nextcloud (SOURCE=caldav).
 *
 * STUB – bewusst noch nicht implementiert (nicht Teil von v1).
 *
 * Die Schnittstelle steht bereits: Sobald diese Funktion Termine in der
 * internen Struktur (siehe calendarSource.js) zurückgibt, läuft der Rest der
 * Anwendung unverändert weiter. Nichts außerhalb dieser Datei muss angefasst
 * werden – die Registrierung in calendarSource.js existiert schon.
 *
 * Umsetzungsskizze mit `tsdav` (npm i tsdav):
 *
 *   import { createDAVClient } from 'tsdav';
 *
 *   const client = await createDAVClient({
 *     serverUrl: config.caldav.url,
 *     credentials: { username: config.caldav.username, password: config.caldav.password },
 *     authMethod: 'Basic',
 *     defaultAccountType: 'caldav',
 *   });
 *
 *   const calendars = await client.fetchCalendars();
 *   const calendar = calendars.find((c) => c.displayName === config.caldav.calendar);
 *   const objects = await client.fetchCalendarObjects({
 *     calendar,
 *     timeRange: { start: from.toISOString(), end: to.toISOString() },
 *   });
 *
 * Danach jedes `object.data` (ein ICS-Fragment) mit `ical.async.parseICS()`
 * parsen und über dieselben Hilfsfunktionen wie in icsSource.js in die interne
 * Struktur überführen. Sinnvoll wäre, das Mapping aus icsSource.js in ein
 * gemeinsames Modul zu ziehen, sobald beide Quellen es brauchen – Serien-
 * expansion, Custom-Properties und Ganztags-Handling sind identisch.
 */

export async function fetchEvents(config) {
  throw new Error(
    'CalDAV-Quelle ist noch nicht implementiert (SOURCE=caldav). ' +
      'Bitte SOURCE=file verwenden. Siehe src/calendar/caldavSource.js für die vorbereitete Schnittstelle.',
  );
}
