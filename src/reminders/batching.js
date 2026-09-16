/**
 * Gruppierung fälliger Erinnerungen.
 *
 * Alle in einem Lauf fälligen Erinnerungen derselben Vorlaufzeit-Stufe
 * (z. B. alle "1 Tag vorher"-Treffer) ergeben EINE Sammelnachricht, statt
 * mehrerer Einzelnachrichten.
 */

/**
 * @param {Array<object>} dueReminders Ergebnis aus evaluateReminders().due
 * @returns {Array<{offsetMinutes: number, offsetKey: string, offsetLabel: string, reminders: Array<object>}>}
 *          Gruppen absteigend nach Vorlaufzeit (längster Vorlauf zuerst),
 *          Termine innerhalb einer Gruppe chronologisch.
 */
export function groupReminders(dueReminders) {
  const groups = new Map();

  for (const reminder of dueReminders) {
    const key = reminder.offsetMinutes;
    if (!groups.has(key)) {
      groups.set(key, {
        offsetMinutes: reminder.offsetMinutes,
        offsetKey: reminder.offsetKey,
        offsetLabel: reminder.offsetLabel,
        reminders: [],
      });
    }
    groups.get(key).reminders.push(reminder);
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.reminders.sort((a, b) => {
      const byStart = a.event.start.getTime() - b.event.start.getTime();
      return byStart !== 0 ? byStart : a.event.titel.localeCompare(b.event.titel);
    });
  }

  return result.sort((a, b) => b.offsetMinutes - a.offsetMinutes);
}
