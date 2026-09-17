/**
 * Rendering der Nachrichten aus konfigurierbaren Templates.
 *
 * Platzhalter:
 *   {titel} {datum} {datum_kurz} {tag_relativ} {termin_zeitraum}
 *   {datumsbereich} {wochentag} {wochentag_kurz} {uhrzeit}
 *   {ort} {vorlauf} {vorlauf_kurz} {anzahl} {items}
 *
 * Bedingte Abschnitte:
 *   {?ort} ... {/ort}   wird nur ausgegeben, wenn {ort} einen Wert hat.
 *   Das funktioniert für jeden Platzhalter, z. B. {?uhrzeit}.
 *
 * So bleibt z. B. die Ortszeile weg, wenn der Termin keinen Ort hat, ohne
 * dass dafür etwas hart codiert werden müsste.
 */

import { formatForMessage, getWallClockParts } from '../util/datetime.js';

const CONDITIONAL = /\{\?([a-z0-9_]+)\}([\s\S]*?)\{\/\1\}/gi;
const PLACEHOLDER = /\{([a-z0-9_]+)\}/gi;

function isEmpty(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function localDayNumber(date, timezone) {
  const { year, month, day } = getWallClockParts(date, timezone);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function displayEnd(event) {
  if (!event.ende) return null;
  if (event.ende <= event.start) return null;
  if (event.ganztags) return new Date(event.ende.getTime() - 1);
  return event.ende;
}

function isSameLocalDay(a, b, timezone) {
  return localDayNumber(a, timezone) === localDayNumber(b, timezone);
}

export function relativeDayLabel(date, referenceDate, timezone) {
  const diff = localDayNumber(date, timezone) - localDayNumber(referenceDate, timezone);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Morgen';
  if (diff === 2) return 'Übermorgen';
  if (diff === -1) return 'Gestern';
  if (diff > 2) return `In ${diff} Tagen`;
  return `Vor ${Math.abs(diff)} Tagen`;
}

export function eventRangeValues(event, config, referenceDate = new Date()) {
  const start = formatForMessage(event.start, config);
  const tagRelativ = relativeDayLabel(event.start, referenceDate, config.timezone);
  const endDate = displayEnd(event);
  const sameDay = !endDate || isSameLocalDay(event.start, endDate, config.timezone);

  if (sameDay) {
    const startTime = event.ganztags ? '' : start.uhrzeit;
    const endTime = !event.ganztags && endDate ? formatForMessage(endDate, config).uhrzeit : '';
    const timeLabel = startTime && endTime && endTime !== startTime
      ? `${startTime}–${endTime} Uhr`
      : startTime
        ? `${startTime} Uhr`
        : '';
    const terminDatum = `${tagRelativ}, ${start.wochentag}, ${start.datumKurz}`;
    const terminZeitraum = `${terminDatum}${timeLabel ? ` um ${timeLabel}` : ''}`;

    return {
      tag_relativ: tagRelativ,
      tagesbereich_relativ: tagRelativ,
      wochentag_ende: start.wochentag,
      wochentag_ende_kurz: start.wochentagKurz,
      datum_ende: start.datum,
      datum_ende_kurz: start.datumKurz,
      datum_ende_ohne_wochentag: start.datumKurz,
      datum_ende_mit_wochentag: start.datumMitWochentag,
      datum_ende_mit_wochentag_kurz: start.datumMitWochentagKurz,
      tag_relativ_ende: tagRelativ,
      datum_relativ_ende: `${tagRelativ}, ${start.datum}`,
      datumsbereich: start.datumKurz,
      datumsbereich_mit_wochentag: start.datumMitWochentag,
      datumsbereich_mit_wochentag_kurz: start.datumMitWochentagKurz,
      uhrzeit_ende: endTime,
      termin_datum: terminDatum,
      termin_zeit: timeLabel,
      termin_zeitraum: terminZeitraum,
    };
  }

  const end = formatForMessage(endDate, config);
  const endRel = relativeDayLabel(endDate, referenceDate, config.timezone);
  const startDateLabel = `${tagRelativ}, ${start.wochentag}, ${start.datumKurz}`;
  const endDateLabel = `${endRel}, ${end.wochentag}, ${end.datumKurz}`;
  const startWithTime = event.ganztags ? startDateLabel : `${startDateLabel}, ${start.uhrzeit} Uhr`;
  const endWithTime = event.ganztags ? endDateLabel : `${endDateLabel}, ${end.uhrzeit} Uhr`;

  return {
    tag_relativ: tagRelativ,
    tagesbereich_relativ: `${tagRelativ} bis ${endRel}`,
    wochentag_ende: end.wochentag,
    wochentag_ende_kurz: end.wochentagKurz,
    datum_ende: end.datum,
    datum_ende_kurz: end.datumKurz,
    datum_ende_ohne_wochentag: end.datumKurz,
    datum_ende_mit_wochentag: end.datumMitWochentag,
    datum_ende_mit_wochentag_kurz: end.datumMitWochentagKurz,
    tag_relativ_ende: endRel,
    datum_relativ_ende: `${endRel}, ${end.datum}`,
    datumsbereich: `${start.datumKurz}–${end.datumKurz}`,
    datumsbereich_mit_wochentag: `${start.datumMitWochentag} – ${end.datumMitWochentag}`,
    datumsbereich_mit_wochentag_kurz: `${start.datumMitWochentagKurz} – ${end.datumMitWochentagKurz}`,
    uhrzeit_ende: event.ganztags ? '' : end.uhrzeit,
    termin_datum: `${tagRelativ} bis ${endRel}, ${start.datumKurz}–${end.datumKurz}`,
    termin_zeit: event.ganztags ? '' : `${start.uhrzeit}–${end.uhrzeit} Uhr`,
    termin_zeitraum: `${tagRelativ} bis ${endRel}, ${startWithTime} bis ${endWithTime}`,
  };
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
export function buildBaseValues(event, config, referenceDate = new Date()) {
  const {
    datum,
    datumKurz,
    datumMitWochentag,
    datumMitWochentagKurz,
    wochentag,
    wochentagKurz,
    uhrzeit,
  } = formatForMessage(event.start, config);
  const tagRelativ = relativeDayLabel(event.start, referenceDate, config.timezone);
  const range = eventRangeValues(event, config, referenceDate);

  return {
    titel: event.titel,
    datum,
    datum_kurz: datumKurz,
    datum_ohne_wochentag: datumKurz,
    datum_mit_wochentag: datumMitWochentag,
    datum_mit_wochentag_kurz: datumMitWochentagKurz,
    wochentag,
    wochentag_kurz: wochentagKurz,
    tag_relativ: tagRelativ,
    datum_relativ: `${tagRelativ}, ${datum}`,
    // Bei ganztägigen Terminen ist eine Uhrzeit irreführend -> leer lassen,
    // damit {?uhrzeit}-Abschnitte automatisch verschwinden.
    uhrzeit: event.ganztags ? '' : uhrzeit,
    ganztag: '',
    ort: isEmpty(event.ort) ? config.locationFallback : event.ort,
    ...range,
  };
}

/**
 * Platzhalter-Werte für eine fällige Erinnerung (Termin + Vorlaufzeit).
 *
 * @param {object} reminder Eintrag aus evaluateReminders().due
 * @param {object} config
 */
export function buildEventValues(reminder, config, referenceDate = new Date()) {
  return {
    ...buildBaseValues(reminder.event, config, referenceDate),
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
export function buildGroupMessage(group, config, referenceDate = new Date()) {
  const { reminders } = group;

  if (reminders.length === 1) {
    return render(config.templateSingle, buildEventValues(reminders[0], config, referenceDate)).trim();
  }

  const items = reminders
    .map((reminder) => render(config.templateCollectionItem, buildEventValues(reminder, config, referenceDate)).trim())
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
export function buildDigestMessage(events, range, config, referenceDate = new Date()) {
  const zeitraum = formatRangeLabel(range, config);

  if (events.length === 0) {
    return render(config.templateDigestEmpty, { zeitraum, anzahl: '0' }).trim();
  }

  const items = events
    .map((event) => render(config.templateDigestItem, buildBaseValues(event, config, referenceDate)).trim())
    .join(config.digestSeparator);

  return render(config.templateDigest, {
    items,
    zeitraum,
    anzahl: String(events.length),
  }).trim();
}
