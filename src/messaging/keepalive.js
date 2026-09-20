/**
 * Keepalive: WhatsApp-Verbindung öffnen und wieder schließen, ohne etwas zu senden.
 *
 * Seit der Client nur noch bei Bedarf verbindet, kann zwischen zwei Versandläufen viel
 * Zeit vergehen. Der Heartbeat hält die Sitzung in Benutzung, arbeitet die auf dem
 * Server wartende Offline-Queue ab und meldet eine Abmeldung (loggedOut) schon
 * beim nächsten Lauf über den Exit-Code, statt erst beim nächsten Versand.
 */

import { log } from '../logger.js';
import { createWhatsAppClient, hasSession } from './whatsappClient.js';
import { isKeepaliveDue, readSessionMeta, recordKeepaliveAttempt } from './sessionMaintenance.js';

/** So lange maximal auf das Ende der Offline-Synchronisation warten. */
const SYNC_WAIT_MS = 15000;

/**
 * @param {object[]} profiles aktivierte Profile
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {boolean} [options.force] true = jede Session verbinden (ignoriert Fälligkeit und Dry-Run)
 * @param {Function} [options.createClient] für Tests austauschbar
 * @returns {Promise<number>} Exit-Code (0 = alles gut)
 */
export async function runKeepalives(
  profiles,
  { now = new Date(), force = false, createClient = createWhatsAppClient } = {},
) {
  const handled = new Set();
  let exitCode = 0;

  for (const profile of profiles) {
    const { authDir } = profile;
    // Automatisch nur für Profile, die wirklich senden dürfen und bei denen es nicht abgeschaltet ist.
    if (!force && (profile.dryRun || !(profile.keepaliveDays > 0))) continue;
    if (handled.has(authDir)) continue;
    handled.add(authDir);

    if (!hasSession(authDir)) {
      if (force) {
        exitCode = 1;
        log.error(`Keepalive nicht möglich: keine WhatsApp-Session in "${authDir}" (bitte "npm run pair").`);
      } else {
        log.warn(`Keine WhatsApp-Session in "${authDir}" – Keepalive übersprungen (bitte "npm run pair").`);
      }
      continue;
    }

    if (!force && !isKeepaliveDue(readSessionMeta(authDir), now, profile.keepaliveDays)) {
      log.debug(`Keepalive für "${authDir}" nicht fällig`);
      continue;
    }

    // Vor dem Verbindungsversuch vermerken, damit ein Dauerfehler den Cron nicht im Takt anklopfen lässt.
    try {
      recordKeepaliveAttempt(authDir, now);
    } catch (error) {
      log.warn(`Keepalive-Zeitpunkt konnte nicht gespeichert werden: ${error.message}`);
    }

    log.info(`Keepalive: verbinde mit WhatsApp (Session "${authDir}")`);
    let client = null;
    try {
      client = await createClient(profile);
      const synced = await client.waitUntilSynced(SYNC_WAIT_MS);
      log.info(
        synced
          ? 'Keepalive erfolgreich: Verbindung aufgebaut, ausstehende Nachrichten abgearbeitet.'
          : 'Keepalive erfolgreich: Verbindung aufgebaut (Synchronisation nicht abgewartet).',
      );
    } catch (error) {
      exitCode = 1;
      log.error(`Keepalive fehlgeschlagen (Session "${authDir}"): ${error.message}`);
    } finally {
      if (client) {
        try {
          await client.close();
        } catch (error) {
          log.warn(`Verbindung konnte nicht sauber geschlossen werden: ${error.message}`);
        }
      }
    }
  }

  return exitCode;
}
