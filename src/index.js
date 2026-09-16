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
 *   7. Senden (oder im Dry-Run nur loggen) und State fortschreiben
 */

import { loadConfig } from './config.js';
import { parseArgs, USAGE } from './cli.js';
import { fetchEvents, getCalendarSource } from './calendar/calendarSource.js';
import { selectEvents } from './reminders/selector.js';
import { evaluateReminders, SKIP_REASONS } from './reminders/scheduler.js';
import { groupReminders } from './reminders/batching.js';
import { buildGroupMessage } from './messaging/templateRenderer.js';
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

  log.section('Lauf gestartet');
  log.info(
    `Zeitpunkt: ${formatForLog(now, config.timezone)} (${config.timezone}) | ` +
      `Quelle: ${source.name} | Modus: ${config.dryRun ? 'DRY-RUN (es wird nichts gesendet)' : 'LIVE'}`,
  );
  if (config.configFile) log.debug(`config.json verwendet: ${config.configFile}`);

  const db = openDatabase(config.dbPath);
  let exitCode = 0;
  let client = null;

  try {
    db.prune(config.pruneAfterDays, now);

    // ── 1. Termine laden ────────────────────────────────────────────────
    // Das Fenster reicht vom Beginn des Prüffensters bis zum Vorschau-Horizont.
    const range = {
      from: new Date(now.getTime() - config.checkWindowMinutes * 60000),
      to: new Date(now.getTime() + config.lookaheadDays * 24 * 60 * 60 * 1000),
    };
    const events = await fetchEvents(config, range);
    log.info(`${events.length} Termin(e) im Zeitfenster bis ${formatForLog(range.to, config.timezone)} geladen`);

    // ── 2. Selektion ────────────────────────────────────────────────────
    const { selected, rejected } = selectEvents(events, config);
    const criteria = [
      config.selectByCategory ? `Kategorie "${config.selectCategory}"` : null,
      config.selectByPrefix ? `Präfix "${config.selectPrefix}"` : null,
    ].filter(Boolean);
    log.info(
      `${selected.length} Termin(e) für WhatsApp markiert (${criteria.join(' oder ')}), ` +
        `${rejected.length} nicht markiert`,
    );
    for (const event of selected) {
      log.debug(`  markiert: "${event.titel}" am ${formatForLog(event.start, config.timezone)}`);
    }

    // ── 3. Fälligkeit prüfen ────────────────────────────────────────────
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

    if (due.length === 0) {
      log.info('Nichts zu senden.');
      log.section('Lauf beendet');
      return 0;
    }

    // ── 4. Bündeln und Nachrichten bauen ────────────────────────────────
    const groups = groupReminders(due);
    log.info(`${groups.length} Sammelnachricht(en) aus ${due.length} Erinnerung(en) gebaut`);

    const messages = groups.map((group) => ({
      group,
      text: buildGroupMessage(group, config),
    }));

    // ── 5. Versand ──────────────────────────────────────────────────────
    if (!config.dryRun) {
      client = await createWhatsAppClient(config);
    }

    for (const { group, text } of messages) {
      const label = `${group.reminders.length} Termin(e), ${group.offsetKey} vorher`;

      if (config.dryRun) {
        log.info(`[DRY-RUN] Nachricht an ${config.whatsappGroupId || '(keine Gruppen-ID gesetzt)'} – ${label}:`);
        console.log(indent(text));
        if (config.recordDryRun) {
          db.markManyProcessed(group.reminders, SENT_STATUS.DRY_RUN, now);
        }
        continue;
      }

      try {
        const messageId = await client.sendText(config.whatsappGroupId, text);
        // Erst nach erfolgreichem Versand persistieren – ein Fehler darf nicht
        // dazu führen, dass die Erinnerung als erledigt gilt.
        db.markManyProcessed(group.reminders, SENT_STATUS.SENT, now);
        log.info(`Gesendet (${label}), Message-ID: ${messageId ?? 'unbekannt'}`);
        for (const reminder of group.reminders) {
          log.debug(`  enthalten: "${reminder.event.titel}" am ${formatForLog(reminder.event.start, config.timezone)}`);
        }
      } catch (error) {
        exitCode = 1;
        log.error(`Versand fehlgeschlagen (${label}): ${error.message}`);
        log.error('Diese Erinnerung wird beim nächsten Lauf erneut versucht (kein State-Eintrag geschrieben).');
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
