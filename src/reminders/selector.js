/**
 * Terminselektion.
 *
 * Nur explizit markierte Termine werden verschickt. Beide Wege sind einzeln
 * oder kombiniert aktivierbar (ODER-Verknüpfung – ein Treffer genügt):
 *   1. Kategorie/Tag im Kalendereintrag (SELECT_BY_CATEGORY / SELECT_CATEGORY)
 *   2. Präfix im Titel               (SELECT_BY_PREFIX  / SELECT_PREFIX)
 *
 * Sind BEIDE Wege abgeschaltet, ist die Selektion deaktiviert: dann gilt
 * jeder Termin des Kalenders als markiert. Das ist für einen dedizierten
 * Kalender sinnvoll, in dem ohnehin nur Termine für die Gruppe stehen.
 */

/** Kategorie-Vergleich case-insensitiv und ohne Randleerzeichen. */
function hasCategory(event, category) {
  const wanted = category.trim().toLowerCase();
  return event.kategorien.some((entry) => entry.trim().toLowerCase() === wanted);
}

/** Präfix-Vergleich case-insensitiv, führende Leerzeichen werden ignoriert. */
function hasPrefix(event, prefix) {
  return event.titel.trimStart().toLowerCase().startsWith(prefix.trim().toLowerCase());
}

/** Präfix aus dem Titel entfernen, damit es nicht in der Nachricht landet. */
function stripPrefixFromTitle(title, prefix) {
  const trimmed = title.trimStart();
  if (!trimmed.toLowerCase().startsWith(prefix.trim().toLowerCase())) return title;
  return trimmed.slice(prefix.trim().length).trim();
}

/**
 * Prüft einen einzelnen Termin.
 *
 * @returns {{selected: boolean, reasons: string[]}}
 */
export function isSelected(event, config) {
  // Kein Filter aktiv -> alle Termine zählen als markiert.
  if (!config.selectByCategory && !config.selectByPrefix) {
    return { selected: true, reasons: ['Selektion deaktiviert'] };
  }

  const reasons = [];
  if (config.selectByCategory && hasCategory(event, config.selectCategory)) {
    reasons.push(`Kategorie "${config.selectCategory}"`);
  }
  if (config.selectByPrefix && hasPrefix(event, config.selectPrefix)) {
    reasons.push(`Titel-Präfix "${config.selectPrefix}"`);
  }
  return { selected: reasons.length > 0, reasons };
}

/**
 * Termine in ausgewählte und verworfene aufteilen.
 *
 * Ausgewählte Termine werden – falls STRIP_PREFIX aktiv ist – mit bereinigtem
 * Titel zurückgegeben. Das Original bleibt unverändert (keine Mutation).
 *
 * @returns {{selected: Array<object>, rejected: Array<object>}}
 */
export function selectEvents(events, config) {
  const selected = [];
  const rejected = [];

  for (const event of events) {
    const result = isSelected(event, config);
    if (!result.selected) {
      rejected.push(event);
      continue;
    }

    let prepared = { ...event, selectionReasons: result.reasons };
    if (config.stripPrefix && config.selectByPrefix && hasPrefix(event, config.selectPrefix)) {
      prepared.titel = stripPrefixFromTitle(event.titel, config.selectPrefix);
    }
    selected.push(prepared);
  }

  return { selected, rejected };
}
