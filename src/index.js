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

import { fileURLToPath } from 'node:url';

import { loadRuntimeConfig } from './config.js';
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
async function runPreview(config, now, tage, db, target) {
  const source = getCalendarSource(config);
  const previewTarget = target ?? { id: 'default', name: '(keine Gruppen-ID gesetzt)' };
  const previewScope = { profileId: config.profileId ?? 'default', targetId: previewTarget.id };
  log.section(
    `Vorschau: die nächsten ${tage} Tage` +
      (config.profileId ? ` – Zielgruppe "${previewTarget.name || previewTarget.id}"` : ''),
  );
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
      const bereitsVersendet = db.isSent(reminder.eventId, reminder.offsetMinutes, previewScope);
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
    const digest = evaluateDigest(config, { now, isSent: (id, off) => db.isSent(id, off, previewScope) });
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

function enabledTargets(profile) {
  const groups = (profile.whatsappGroups ?? []).filter((group) => group.enabled);
  if (groups.length > 0) return groups;
  return profile.dryRun ? [{ id: 'default', name: '(keine Gruppen-ID gesetzt)', enabled: true }] : [];
}

async function runProfilePreview(profile, now, tage) {
  const db = openDatabase(profile.dbPath);
  try {
    const groups = enabledTargets(profile);
    log.section(`Profil "${profile.profileName}" – Vorschau`);
    log.info(
      `Profil-ID: ${profile.profileId} | Zielgruppen: ` +
        (groups.length > 0 ? groups.map((group) => group.name || group.id).join(', ') : '(keine)'),
    );
    for (const group of groups) {
      await runPreview(profile, now, tage, db, group);
    }
    return 0;
  } finally {
    db.close();
  }
}

function scopedEntries(entries, profile, group) {
  return entries.map((entry) => ({ ...entry, profileId: profile.profileId, targetId: group.id }));
}

async function runProfile(profile, now) {
  const source = getCalendarSource(profile);
  const db = openDatabase(profile.dbPath);
  let client = null;
  let exitCode = 0;

  log.section(`Profil "${profile.profileName}" gestartet`);
  log.info(
    `Zeitpunkt: ${formatForLog(now, profile.timezone)} (${profile.timezone}) | ` +
      `Quelle: ${source.name} | Modus: ${profile.dryRun ? 'DRY-RUN (es wird nichts gesendet)' : 'LIVE'}`,
  );
  log.info(`Profil-ID: ${profile.profileId}`);
  if (profile.configFile) log.debug(`config.json verwendet: ${profile.configFile}`);

  try {
    db.prune(profile.pruneAfterDays, now);

    const { range, events, selected, rejected } = await ladeUndSelektiere(profile, now, profile.lookaheadDays);
    log.info(`${events.length} Termin(e) im Zeitfenster bis ${formatForLog(range.to, profile.timezone)} geladen`);

    if (!profile.selectByCategory && !profile.selectByPrefix) {
      log.warn('Selektion ist deaktiviert – ALLE Termine des Kalenders werden verschickt.');
    }
    log.info(
      `${selected.length} Termin(e) für WhatsApp markiert (${describeSelection(profile)}), ` +
        `${rejected.length} nicht markiert`,
    );
    for (const event of selected) {
      log.debug(`  markiert: "${event.titel}" am ${formatForLog(event.start, profile.timezone)}`);
    }
    if (events.length > 0 && selected.length === 0) {
      log.warn('Kein Termin ist markiert – mit "--preview" lässt sich prüfen, woran es liegt.');
    }

    const targets = enabledTargets(profile);
    if (!profile.dryRun) client = await createWhatsAppClient(profile);

    for (const group of targets) {
      try {
        const targetScope = { profileId: profile.profileId, targetId: group.id };
        log.section(`Zielgruppe "${group.name || group.id}"`);
        const { due, skipped } = evaluateReminders(selected, profile, {
          now,
          isSent: (eventId, offsetMinutes) => db.isSent(eventId, offsetMinutes, targetScope),
        });
        log.info(
          `${due.length} Erinnerung(en) fällig, ${skipped.length} übersprungen` +
            (skipped.length > 0 ? ` (${summarizeSkips(skipped)})` : ''),
        );
        for (const entry of skipped) {
          log.debug(
            `  übersprungen [${entry.reason}]: "${entry.event.titel}" – ${entry.offsetKey} vorher, ` +
              `Versand wäre ${formatForLog(entry.sendAt, profile.timezone)}`,
          );
        }

        const missed = skipped.filter((entry) => entry.reason === SKIP_REASONS.WINDOW_MISSED);
        if (missed.length > 0) {
          if (!profile.dryRun) db.markManyProcessed(scopedEntries(missed, profile, group), SENT_STATUS.MISSED, now);
          log.warn(
            `${missed.length} Erinnerung(en) lagen vor dem Prüffenster (${profile.checkWindowMinutes} min) ` +
              (profile.dryRun
                ? 'und würden im Live-Modus nicht nachgeholt. Dry-Run: State bleibt unverändert. '
                : 'und werden nicht nachgeholt. ') +
              'Mit CATCH_UP=true würden sie nachgeholt.',
          );
        }

        const messages = [];
        for (const reminderGroup of groupReminders(due)) {
          messages.push({
            label: `${reminderGroup.reminders.length} Termin(e), ${reminderGroup.offsetKey} vorher`,
            text: buildGroupMessage(reminderGroup, profile, now),
            stateEntries: scopedEntries(reminderGroup.reminders, profile, group),
          });
        }
        if (messages.length > 0) {
          log.info(`${messages.length} Sammelnachricht(en) aus ${due.length} Erinnerung(en) gebaut`);
        }

        if (profile.digestEnabled) {
          const digest = evaluateDigest(profile, { now, isSent: (id, off) => db.isSent(id, off, targetScope) });
          const enthalten = eventsInRange(selected, digest.range);
          const zeitraum = formatRangeLabel(digest.range, profile);
          if (digest.due && (enthalten.length > 0 || profile.digestSendWhenEmpty)) {
            messages.push({
              label: `Wochenübersicht ${zeitraum}, ${enthalten.length} Termin(e)`,
              text: buildDigestMessage(enthalten, digest.range, profile, now),
              stateEntries: scopedEntries([
                {
                  eventId: digest.stateKey,
                  offsetMinutes: 0,
                  event: { titel: `Wochenübersicht ${zeitraum}`, start: digest.scheduledAt },
                  sendAt: digest.scheduledAt,
                },
              ], profile, group),
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
                `${formatForLog(digest.scheduledAt, profile.timezone)}`,
            );
          }
        }

        if (messages.length === 0) {
          log.info('Nichts zu senden.');
          continue;
        }

        for (const { label, text, stateEntries } of messages) {
          if (profile.dryRun) {
            log.info(
              `[DRY-RUN] Nachricht an ${group.name || '(unbenannte Gruppe)'} ` +
                `(${group.id || 'keine Gruppen-ID gesetzt'}) – ${label}:`,
            );
            console.log(indent(text));
            if (profile.recordDryRun) db.markManyProcessed(stateEntries, SENT_STATUS.DRY_RUN, now);
            continue;
          }

          try {
            const messageId = await client.sendText(group.id, text);
            db.markManyProcessed(stateEntries, SENT_STATUS.SENT, now);
            log.info(`Gesendet an ${group.name || group.id} (${label}), Message-ID: ${messageId ?? 'unbekannt'}`);
          } catch (error) {
            exitCode = 1;
            log.error(`Versand fehlgeschlagen an ${group.name || group.id} (${label}): ${error.message}`);
            log.error('Diese Nachricht wird beim nächsten Lauf erneut versucht (kein State-Eintrag geschrieben).');
          }
        }
      } catch (error) {
        exitCode = 1;
        log.error(
          `Zielgruppe ${group.name || group.id} in Profil "${profile.profileName}" fehlgeschlagen: ${error.message}`,
        );
      }
    }

    if (profile.dryRun && !profile.recordDryRun) {
      log.info('Dry-Run: State wurde NICHT verändert (RECORD_DRY_RUN=false) – der Lauf ist beliebig wiederholbar.');
    }

    log.debug(`State enthält jetzt ${db.count()} Eintrag/Einträge`);
    log.section(`Profil "${profile.profileName}" beendet`);
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

  const runtime = loadRuntimeConfig({ configFile: args.configFile, overrides: args.overrides });
  setLevel(args.logLevel ?? runtime.logLevel);

  const now = args.now ?? new Date();

  if (args.preview !== null) {
    let exitCode = 0;
    for (const profile of runtime.enabledProfiles) {
      try {
        await runProfilePreview(profile, now, args.preview);
      } catch (error) {
        exitCode = 1;
        log.error(`Vorschau für Profil "${profile.profileName}" fehlgeschlagen: ${error.message}`);
      }
    }
    return exitCode;
  }

  let exitCode = 0;
  for (const profile of runtime.enabledProfiles) {
    let profileExit = 1;
    try {
      profileExit = await runProfile(profile, now);
    } catch (error) {
      log.error(`Profil "${profile.profileName}" fehlgeschlagen: ${error.message}`);
    }
    if (profileExit !== 0) exitCode = profileExit;
  }
  log.section('Lauf beendet');
  return exitCode;
}

// Direktaufruf (nicht beim Import in Tests).
if (fileURLToPath(import.meta.url) === process.argv[1]) {
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
