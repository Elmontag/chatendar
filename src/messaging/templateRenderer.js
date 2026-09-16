/**
 * Rendering der Nachrichten aus konfigurierbaren Templates.
 *
 * Platzhalter:
 *   {titel} {datum} {datum_kurz} {wochentag} {uhrzeit} {ort} {vorlauf}
 *   {vorlauf_kurz} {anzahl} {items}
 *
 * Bedingte Abschnitte:
 *   {?ort} ... {/ort}   wird nur ausgegeben, wenn {ort} einen Wert hat.
 *   Das funktioniert für jeden Platzhalter, z. B. {?uhrzeit}, {?ganztag}.
 *
 * So bleibt z. B. die Ortszeile weg, wenn der Termin keinen Ort hat, ohne
 * dass dafür etwas hart codiert werden müsste.
 */

import { formatForMessage } from '../util/datetime.js';

const CONDITIONAL = /\{\?([a-z0-9_]+)\}([\s\S]*?)\{\/\1\}/gi;
const PLACEHOLDER = /\{([a-z0-9_]+)\}/gi;

function isEmpty(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * Template mit Werten füllen.
 *
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function render(template, values) {
  let output = String(template ?? '');

  // Bedingte Abschnitte zuerst – mehrfach, damit auch Verschachtelung aufgeht.
  for (let pass = 0; pass < 5; pass += 1) {
    const before = output;
    output = output.replace(CONDITIONAL, (_match, key, body) =>
      isEmpty(values[key.toLowerCase()]) ? '' : body,
    );
    if (output === before) break;
  }

  // Unbekannte Platzhalter werden zu einem leeren String – niemals "undefined"
  // in einer WhatsApp-Nachricht.
  output = output.replace(PLACEHOLDER, (_match, key) => {
    const value = values[key.toLowerCase()];
    return isEmpty(value) ? '' : String(value);
  });

  return output;
}

/**
 * Platzhalter-Werte eines Termins – gemeinsame Basis für Erinnerungen und
 * für die Wochenübersicht.
 *
 * @param {object} event Termin in der internen Struktur
 * @param {object} config
 */
export function buildBaseValues(event, config) {
  const { datum, datumKurz, wochentag, uhrzeit } = formatForMessage(event.start, config);

  return {
    titel: event.titel,
    datum,
    datum_kurz: datumKurz,
    wochentag,
    // Bei ganztägigen Terminen ist eine Uhrzeit irreführend -> leer lassen,
    // damit {?uhrzeit}-Abschnitte automatisch verschwinden.
    uhrzeit: event.ganztags ? '' : uhrzeit,
    ganztag: event.ganztags ? 'ganztägig' : '',
    ort: isEmpty(event.ort) ? config.locationFallback : event.ort,
  };
}

/**
 * Platzhalter-Werte für eine fällige Erinnerung (Termin + Vorlaufzeit).
 *
 * @param {object} reminder Eintrag aus evaluateReminders().due
 * @param {object} config
 */
export function buildEventValues(reminder, config) {
  return {
    ...buildBaseValues(reminder.event, config),
    vorlauf: reminder.offsetLabel,
    vorlauf_kurz: reminder.offsetKey,
  };
}

/**
 * Nachricht für eine Vorlaufzeit-Gruppe bauen.
 *
 * Eine einzelne fällige Erinnerung nutzt das Einzeltermin-Template, mehrere
 * das Sammel-Template mit dem Item-Template pro Termin.
 *
 * @param {object} group Eintrag aus groupReminders()
 * @param {object} config
 * @returns {string}
 */
export function buildGroupMessage(group, config) {
  const { reminders } = group;

  if (reminders.length === 1) {
    return render(config.templateSingle, buildEventValues(reminders[0], config)).trim();
  }

  const items = reminders
    .map((reminder) => render(config.templateCollectionItem, buildEventValues(reminder, config)).trim())
    .join(config.collectionSeparator);

  return render(config.templateCollection, {
    items,
    anzahl: String(reminders.length),
    vorlauf: group.offsetLabel,
    vorlauf_kurz: group.offsetKey,
  }).trim();
}

/**
 * Zeitraum-Label für die Wochenübersicht, z. B. "21.09. – 27.09.2026".
 *
 * `to` ist exklusiv, deshalb wird für die Anzeige der letzte enthaltene Tag
 * verwendet.
 */
export function formatRangeLabel({ from, to }, config) {
  const letzterTag = new Date(to.getTime() - 1);
  const start = formatForMessage(from, config).datumKurz;
  const ende = formatForMessage(letzterTag, config).datumKurz;
  // Gleiches Jahr -> beim Startdatum das Jahr weglassen.
  const kurz = start.slice(0, 6);
  return start.slice(6) === ende.slice(6) ? `${kurz} – ${ende}` : `${start} – ${ende}`;
}

/**
 * Nachricht für die Wochenübersicht bauen.
 *
 * @param {Array<object>} events Termine im Zeitraum (chronologisch)
 * @param {{from: Date, to: Date}} range
 * @param {object} config
 * @returns {string}
 */
export function buildDigestMessage(events, range, config) {
  const zeitraum = formatRangeLabel(range, config);

  if (events.length === 0) {
    return render(config.templateDigestEmpty, { zeitraum, anzahl: '0' }).trim();
  }

  const items = events
    .map((event) => render(config.templateDigestItem, buildBaseValues(event, config)).trim())
    .join(config.digestSeparator);

  return render(config.templateDigest, {
    items,
    zeitraum,
    anzahl: String(events.length),
  }).trim();
}
