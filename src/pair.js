#!/usr/bin/env node
/**
 * Einmalige Kopplung mit WhatsApp.
 *
 *   npm run pair
 *
 * Zeigt den QR-Code an, speichert die Session in AUTH_DIR und listet
 * anschließend alle Gruppen mit ihrer ID auf – der Wert für
 * WHATSAPP_GROUP_ID lässt sich dort direkt herauskopieren.
 */

import { loadConfig } from './config.js';
import { createWhatsAppClient, hasSession } from './messaging/whatsappClient.js';
import { log, setLevel } from './logger.js';

async function main() {
  // Für die Kopplung ist noch kein WhatsApp-Ziel nötig -> Validierung entspannen.
  const config = loadConfig({ overrides: { dryRun: true } });
  setLevel(process.argv.includes('--verbose') ? 'debug' : config.logLevel);

  log.section('WhatsApp-Kopplung');
  if (hasSession(config.authDir)) {
    log.info(`Bestehende Session gefunden in ${config.authDir} – es wird nur die Verbindung geprüft.`);
  } else {
    log.info(`Keine Session vorhanden. Der QR-Code wird gleich angezeigt (Ablage: ${config.authDir}).`);
  }

  const client = await createWhatsAppClient(config, { allowQr: true });

  try {
    const groups = await client.listGroups();
    if (groups.length === 0) {
      log.warn('Keine Gruppen gefunden. Ist der gekoppelte Account Mitglied in einer Gruppe?');
    } else {
      log.info(`${groups.length} Gruppe(n) gefunden – ID für WHATSAPP_GROUP_ID:`);
      for (const group of groups) {
        console.log(`    ${group.id}   ${group.subject}`);
      }
    }
    log.info('Einzelpersonen werden in config.json als internationale Telefonnummer konfiguriert.');
    log.info('Kopplung abgeschlossen. Der Ordner mit der Session darf NICHT ins Git-Repo.');
  } finally {
    await client.close();
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  log.error(error.message);
  process.exit(1);
}
