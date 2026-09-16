/**
 * Abstraktionsschicht Kalenderquelle.
 *
 * Jede Implementierung liefert Termine in genau dieser internen Struktur:
 *
 *   {
 *     id:          string,                  // eindeutig, inkl. Instanz bei Serien
 *     uid:         string,                  // UID des Kalendereintrags
 *     titel:       string,
 *     start:       Date,
 *     ende:        Date | null,
 *     ort:         string | null,
 *     kategorien:  string[],
 *     customProps: Record<string, string>,  // X-WA-* Properties (Key inkl. "X-"-Präfix)
 *     ganztags:    boolean,
 *     serie:       boolean                  // stammt aus einer Wiederholungsregel
 *   }
 *
 * Eine Quelle implementiert die Funktion:
 *   fetchEvents(config, { from, to }) => Promise<Event[]>
 *
 * Neue Quellen werden unten in SOURCES registriert; am übrigen Code muss
 * dafür nichts geändert werden.
 */

import { fetchEvents as fetchFromIcs } from './icsSource.js';
import { fetchEvents as fetchFromCalDav } from './caldavSource.js';

/** Registry der verfügbaren Quellen (Config-Wert SOURCE -> Implementierung). */
const SOURCES = {
  file: { name: 'ICS-Datei', fetchEvents: fetchFromIcs },
  caldav: { name: 'CalDAV', fetchEvents: fetchFromCalDav },
};

/**
 * Liefert die konfigurierte Quelle.
 * @param {object} config
 * @returns {{name: string, fetchEvents: Function}}
 */
export function getCalendarSource(config) {
  const source = SOURCES[config.source];
  if (!source) {
    throw new Error(
      `Unbekannte Kalenderquelle "${config.source}". Verfügbar: ${Object.keys(SOURCES).join(', ')}`,
    );
  }
  return source;
}

/**
 * Termine aus der konfigurierten Quelle laden.
 *
 * @param {object} config
 * @param {{from: Date, to: Date}} range Zeitfenster, das geladen werden soll
 * @returns {Promise<Array<object>>} Termine in der internen Struktur
 */
export async function fetchEvents(config, range) {
  const source = getCalendarSource(config);
  const events = await source.fetchEvents(config, range);
  // Stabile Sortierung nach Startzeit – vereinfacht Logs und Sammelnachrichten.
  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Hilfsfunktion für Implementierungen: baut einen internen Termin und stellt
 * sicher, dass alle Felder vorhanden und richtig typisiert sind.
 */
export function createEvent({
  id,
  uid,
  titel,
  start,
  ende = null,
  ort = null,
  kategorien = [],
  customProps = {},
  ganztags = false,
  serie = false,
}) {
  if (!id) throw new Error('Termin ohne id');
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new Error(`Termin "${id}" hat kein gültiges Startdatum`);
  }
  return {
    id: String(id),
    uid: String(uid ?? id),
    titel: String(titel ?? '(ohne Titel)'),
    start,
    ende: ende instanceof Date && !Number.isNaN(ende.getTime()) ? ende : null,
    ort: ort ? String(ort) : null,
    kategorien: Array.isArray(kategorien) ? kategorien.map(String) : [],
    customProps,
    ganztags: Boolean(ganztags),
    serie: Boolean(serie),
  };
}
