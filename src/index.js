#!/usr/bin/env node
/**
 * Einstiegspunkt für EINEN Durchlauf.
 *
 * Das Tool bringt bewusst keinen eigenen Scheduler mit: die Wiederholung
 * übernimmt ein systemd-Timer oder ein Cronjob (siehe README).
 *
 * Ablauf eines Laufs:
 *   1. Konfiguration laden und validieren
 *   2. State-Datenbank öffnen
 *   3. Termine aus der Kalenderquelle lesen
 *   4. Markierte Termine selektieren
 *   5. Fällige Vorlaufzeiten bestimmen (State verhindert Doppelversand)
 *   6. Fällige Erinnerungen je Vorlaufzeit-Stufe zu einer Nachricht bündeln
 *   7. Wochenübersicht prüfen, falls aktiviert
 *   8. Senden (oder im Dry-Run nur loggen) und State fortschreiben
 */

import { loadConfig } from './config.js';
import { parseArgs, USAGE } from './cli.js';
import { fetchEvents, getCalendarSource } from './calendar/calendarSource.js';
import { selectEvents } from './reminders/selector.js';
import { buildReminders, evaluateReminders, SKIP_REASONS } from './reminders/scheduler.js';
import { groupReminders } from './reminders/batching.js';
import { evaluateDigest, eventsInRange, nextScheduledInstant } from './reminders/digest.js';
import { buildDigestMessage, buildGroupMessage, formatRangeLabel } from './messaging/templateRenderer.js';
import { createWhatsAppClient } from './messaging/whatsappClient.js';
import { openDatabase, SENT_STATUS } from './state/db.js';
import { formatForLog } from './util/datetime.js';
import { log, setLevel } from './logger.js';

/** Übersprungene Erinnerungen kompakt zusammenfassen statt zeilenweise zu spammen. */
function summarizeSkips(skipped) {
  const counts = new Map();
  for (const entry of skipped) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => `${reason}: ${count}`).join(', ');
}

/** Nachricht eingerückt ausgeben, damit sie im Log als Block erkennbar ist. */
function indent(text) {
  return text
    .split('\n')
    .map((line) => `    │ ${line}`)
    .join('\n');
}

/** Beschreibung der aktiven Selektionskriterien – auch für den Fall "kein Filter". */
function describeSelection(config) {
  const criteria = [
    config.selectByCategory ? `Kategorie "${config.selectCategory}"` : null,
    config.selectByPrefix ? `Präfix "${config.selectPrefix}"` : null,
  ].filter(Boolean);
  return criteria.length === 0 ? 'Selektion deaktiviert – ALLE Termine' : criteria.join(' oder ');
}

/** Termine laden und selektieren – gemeinsam für Lauf und Vorschau. */
async function ladeUndSelektiere(config, now, horizontTage) {
  const range = {
    from: new Date(now.getTime() - config.checkWindowMinutes * 60000),
    to: new Date(now.getTime() + horizontTage * 24 * 60 * 60 * 1000),
  };
  const events = await fetchEvents(config, range);
  const { selected, rejected } = selectEvents(events, config);
  return { range, events, selected, rejected };
}

/**
 * Vorschau: zeigt, welche Termine erkannt wurden und wann ihre Erinnerungen
 * rausgehen würden. Sendet nichts und verändert den State nicht.
 *
 * Gedacht für genau die Frage "warum passiert nichts?" – das Prüffenster ist
 * im Normalbetrieb nur Minuten breit, ein einzelner Testlauf trifft also
 * fast nie eine fällige Erinnerung.
 */
async function runPreview(config, now, tage, db) {
  const source = getCalendarSource(config);
  log.section(`Vorschau: die nächsten ${tage} Tage`);
  log.info(
    `Zeitpunkt: ${formatForLog(now, config.timezone)} (${config.timezone}) | ` +
      `Quelle: ${source.name} | Datei/Ziel: ${config.source === 'file' ? config.icsPath : config.caldav.url}`,
  );

  const { events, selected, rejected } = await ladeUndSelektiere(config, now, tage);
  log.info(`${events.length} Termin(e) im Zeitraum geladen`);
  log.info(`Selektion: ${describeSelection(config)}`);
  log.info(`${selected.length} Termin(e) markiert, ${rejected.length} nicht markiert`);

  if (events.length === 0) {
    log.warn(
      'Der Kalender enthält im Zeitraum keine Termine. Prüfen: Stimmt ICS_PATH? ' +
        'Liegen die Termine in der Zukunft? Ggf. mit --preview 365 weiter nach vorn schauen.',
    );
  } else if (selected.length === 0) {
    log.warn(
      'Es sind Termine vorhanden, aber keiner ist markiert. Entweder die Termine im Kalender ' +
        `mit ${describeSelection(config)} markieren – oder SELECT_BY_CATEGORY=false und ` +
        'SELECT_BY_PREFIX=false setzen, dann gelten alle Termine.',
    );
    for (const event of rejected.slice(0, 10)) {
      log.info(
        `  nicht markiert: "${event.titel}" am ${formatForLog(event.start, config.timezone)}` +
          (event.kategorien.length > 0 ? ` (Kategorien: ${event.kategorien.join(', ')})` : ' (ohne Kategorien)'),
      );
    }
  }

  // Geplante Erinnerungen je Termin auflisten.
  for (const event of selected) {
    console.log(
      `\n    ${formatForLog(event.start, config.timezone)}  ${event.titel}` +
        (event.ort ? `  (${event.ort})` : ''),
    );
    for (const reminder of buildReminders(event, config)) {
      const bereitsVersendet = db.isSent(reminder.eventId, reminder.offsetMinutes);
      const status = bereitsVersendet
        ? 'bereits versendet'
        : reminder.sendAt > now
          ? 'geplant'
          : reminder.sendAt >= new Date(now.getTime() - config.checkWindowMinutes * 60000)
            ? '>>> JETZT fällig'
            : 'Prüffenster verpasst';
      console.log(
        `        ${reminder.offsetKey.padEnd(5)} vorher → ` +
          `${formatForLog(reminder.sendAt, config.timezone)}   ${status}`,
      );
    }
  }

  // Wochenübersicht.
  console.log('');
  if (config.digestEnabled) {
    const naechste = nextScheduledInstant(now, config);
    const digest = evaluateDigest(config, { now, isSent: (id, off) => db.isSent(id, off) });
    const enthalten = eventsInRange(selected, digest.range);
    log.info(
      `Wochenübersicht: nächster Versand ${formatForLog(naechste, config.timezone)} ` +
        `(${config.digestDay} ${config.digestTime}, Zeitraum ${config.digestRange})`,
    );
    log.info(
      `  letzter geplanter Versand war ${formatForLog(digest.scheduledAt, config.timezone)} – ` +
        `Status: ${digest.reason}, Inhalt wären ${enthalten.length} Termin(e)`,
    );
  } else {
    log.info('Wochenübersicht: deaktiviert (DIGEST_ENABLED=false)');
  }

  log.section('Vorschau beendet');
  return 0;
}

/**
 * Einen kompletten Durchlauf ausführen.
 * @returns {Promise<number>} Exit-Code
 */
export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const config = loadConfig({ configFile: args.configFile, overrides: args.overrides });
  setLevel(args.logLevel ?? config.logLevel);

  const now = args.now ?? new Date();
  const source = getCalendarSource(config);
  const db = openDatabase(config.dbPath);

  // Vorschau ist ein reiner Lesevorgang – kein Versand, kein State-Schreiben.
  if (args.preview !== null) {
    try {
      return await runPreview(config, now, args.preview, db);
    } finally {
      db.close();
    }
  }

  log.section('Lauf gestartet');
  log.info(
    `Zeitpunkt: ${formatForLog(now, config.timezone)} (${config.timezone}) | ` +
      `Quelle: ${source.name} | Modus: ${config.dryRun ? 'DRY-RUN (es wird nichts gesendet)' : 'LIVE'}`,
  );
  if (config.configFile) log.debug(`config.json verwendet: ${config.configFile}`);

  let exitCode = 0;
  let client = null;

  try {
    db.prune(config.pruneAfterDays, now);

    // ── 1. Termine laden und selektieren ────────────────────────────────
    const { range, events, selected, rejected } = await ladeUndSelektiere(config, now, config.lookaheadDays);
    log.info(`${events.length} Termin(e) im Zeitfenster bis ${formatForLog(range.to, config.timezone)} geladen`);

    if (!config.selectByCategory && !config.selectByPrefix) {
      log.warn('Selektion ist deaktiviert – ALLE Termine des Kalenders werden verschickt.');
    }
    log.info(
      `${selected.length} Termin(e) für WhatsApp markiert (${describeSelection(config)}), ` +
        `${rejected.length} nicht markiert`,
    );
    for (const event of selected) {
      log.debug(`  markiert: "${event.titel}" am ${formatForLog(event.start, config.timezone)}`);
    }
    if (events.length > 0 && selected.length === 0) {
      log.warn('Kein Termin ist markiert – mit "--preview" lässt sich prüfen, woran es liegt.');
    }

    // ── 2. Fälligkeit der Erinnerungen prüfen ───────────────────────────
    const { due, skipped } = evaluateReminders(selected, config, {
      now,
      isSent: (eventId, offsetMinutes) => db.isSent(eventId, offsetMinutes),
    });
    log.info(
      `${due.length} Erinnerung(en) fällig, ${skipped.length} übersprungen` +
        (skipped.length > 0 ? ` (${summarizeSkips(skipped)})` : ''),
    );
    for (const entry of skipped) {
      log.debug(
        `  übersprungen [${entry.reason}]: "${entry.event.titel}" – ${entry.offsetKey} vorher, ` +
          `Versand wäre ${formatForLog(entry.sendAt, config.timezone)}`,
      );
    }

    // Verpasste Erinnerungen als erledigt vermerken, damit sie nicht bei jedem
    // weiteren Lauf erneut geprüft und geloggt werden.
    const missed = skipped.filter((entry) => entry.reason === SKIP_REASONS.WINDOW_MISSED);
    if (missed.length > 0 && !config.dryRun) {
      db.markManyProcessed(missed, SENT_STATUS.MISSED, now);
      log.warn(
        `${missed.length} Erinnerung(en) lagen vor dem Prüffenster (${config.checkWindowMinutes} min) ` +
          'und werden nicht nachgeholt. Mit CATCH_UP=true würden sie nachgeholt.',
      );
    }

    // ── 3. Nachrichten bauen ────────────────────────────────────────────
    // Jeder Eintrag: eine Nachricht plus die zugehörigen State-Einträge.
    const messages = [];

    for (const group of groupReminders(due)) {
      messages.push({
        label: `${group.reminders.length} Termin(e), ${group.offsetKey} vorher`,
        text: buildGroupMessage(group, config),
        stateEntries: group.reminders,
      });
    }
    if (messages.length > 0) {
      log.info(`${messages.length} Sammelnachricht(en) aus ${due.length} Erinnerung(en) gebaut`);
    }

    // ── 4. Wochenübersicht ──────────────────────────────────────────────
    if (config.digestEnabled) {
      const digest = evaluateDigest(config, { now, isSent: (id, off) => db.isSent(id, off) });
      const enthalten = eventsInRange(selected, digest.range);
      const zeitraum = formatRangeLabel(digest.range, config);

      if (digest.due && (enthalten.length > 0 || config.digestSendWhenEmpty)) {
        messages.push({
          label: `Wochenübersicht ${zeitraum}, ${enthalten.length} Termin(e)`,
          text: buildDigestMessage(enthalten, digest.range, config),
          // Pseudo-Erinnerung, damit der State-Schlüssel dieselbe Struktur hat.
          stateEntries: [
            {
              eventId: digest.stateKey,
              offsetMinutes: 0,
              event: { titel: `Wochenübersicht ${zeitraum}`, start: digest.scheduledAt },
              sendAt: digest.scheduledAt,
            },
          ],
        });
        log.info(`Wochenübersicht fällig (${zeitraum}) mit ${enthalten.length} Termin(en)`);
      } else if (digest.due) {
        log.info(
          `Wochenübersicht wäre fällig (${zeitraum}), enthält aber keine Termine – ` +
            'wird übersprungen (DIGEST_SEND_WHEN_EMPTY=false).',
        );
      } else {
        log.debug(
          `Wochenübersicht nicht fällig [${digest.reason}], geplanter Versand war ` +
            `${formatForLog(digest.scheduledAt, config.timezone)}`,
        );
      }
    }

    if (messages.length === 0) {
      log.info('Nichts zu senden.');
      log.section('Lauf beendet');
      return 0;
    }

    // ── 5. Versand ──────────────────────────────────────────────────────
    if (!config.dryRun) {
      client = await createWhatsAppClient(config);
    }

    for (const { label, text, stateEntries } of messages) {
      if (config.dryRun) {
        log.info(`[DRY-RUN] Nachricht an ${config.whatsappGroupId || '(keine Gruppen-ID gesetzt)'} – ${label}:`);
        console.log(indent(text));
        if (config.recordDryRun) {
          db.markManyProcessed(stateEntries, SENT_STATUS.DRY_RUN, now);
        }
        continue;
      }

      try {
        const messageId = await client.sendText(config.whatsappGroupId, text);
        // Erst nach erfolgreichem Versand persistieren – ein Fehler darf nicht
        // dazu führen, dass die Erinnerung als erledigt gilt.
        db.markManyProcessed(stateEntries, SENT_STATUS.SENT, now);
        log.info(`Gesendet (${label}), Message-ID: ${messageId ?? 'unbekannt'}`);
      } catch (error) {
        exitCode = 1;
        log.error(`Versand fehlgeschlagen (${label}): ${error.message}`);
        log.error('Diese Nachricht wird beim nächsten Lauf erneut versucht (kein State-Eintrag geschrieben).');
      }
    }

    if (config.dryRun && !config.recordDryRun) {
      log.info('Dry-Run: State wurde NICHT verändert (RECORD_DRY_RUN=false) – der Lauf ist beliebig wiederholbar.');
    }

    log.debug(`State enthält jetzt ${db.count()} Eintrag/Einträge`);
    log.section('Lauf beendet');
    return exitCode;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch (error) {
        log.warn(`Verbindung konnte nicht sauber geschlossen werden: ${error.message}`);
      }
    }
    db.close();
  }
}

// Direktaufruf (nicht beim Import in Tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const code = await run();
    // Baileys hält u. U. noch Timer offen – deshalb explizit beenden.
    process.exit(code);
  } catch (error) {
    log.error(error.message);
    if (process.env.LOG_LEVEL === 'debug' || process.argv.includes('--verbose')) {
      console.error(error);
    }
    process.exit(1);
  }
}
