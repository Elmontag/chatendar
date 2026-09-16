/**
 * WhatsApp-Anbindung über Baileys (Multi-Device, kein Headless-Browser).
 *
 * Verantwortlichkeiten:
 *  - Session aus AUTH_DIR laden bzw. beim ersten Start per QR-Code koppeln
 *  - Verbindung aufbauen und auf "open" warten, bevor gesendet wird
 *  - Textnachrichten an eine feste Gruppen-ID senden
 *  - Verbindung sauber schließen (ohne die Session zu löschen!)
 *
 * Wichtig: `close()` beendet nur den Socket. Ein `logout()` würde die
 * Kopplung aufheben und beim nächsten Lauf einen neuen QR-Code erzwingen –
 * das passiert hier bewusst nirgends.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  default as makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

import { log } from '../logger.js';

/** Baileys ist sehr gesprächig – eigenes Logging reicht uns. */
const silentLogger = pino({ level: 'silent' });

/** Disconnect-Gründe, bei denen ein erneuter Verbindungsversuch sinnvoll ist. */
const RETRYABLE = new Set([
  DisconnectReason.connectionClosed,
  DisconnectReason.connectionLost,
  DisconnectReason.restartRequired,
  DisconnectReason.timedOut,
  DisconnectReason.connectionReplaced,
]);

/** Statuscode aus einem Baileys-/Boom-Fehler extrahieren. */
function statusCodeOf(error) {
  return error?.output?.statusCode ?? error?.status ?? null;
}

/** Liegt in AUTH_DIR bereits eine gekoppelte Session? */
export function hasSession(authDir) {
  return fs.existsSync(path.join(authDir, 'creds.json'));
}

/**
 * Verbindung herstellen.
 *
 * @param {object} config
 * @param {object} [options]
 * @param {boolean} [options.allowQr=false]
 *        true  -> QR-Code anzeigen, wenn keine Session existiert (Kopplung)
 *        false -> ohne Session sofort mit klarer Meldung abbrechen (Cron-Betrieb)
 * @returns {Promise<{sendText: Function, listGroups: Function, close: Function, user: object}>}
 */
export async function createWhatsAppClient(config, { allowQr = false } = {}) {
  const { authDir, connectTimeoutMs } = config;

  if (!hasSession(authDir) && !allowQr) {
    throw new Error(
      `Keine WhatsApp-Session in "${authDir}" gefunden.\n` +
        '   Bitte einmalig "npm run pair" ausführen und den QR-Code mit WhatsApp scannen\n' +
        '   (WhatsApp > Einstellungen > Verknüpfte Geräte > Gerät verknüpfen).',
    );
  }

  fs.mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // Protokollversion abfragen; bei Netzproblemen mit der mitgelieferten weitermachen.
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
    log.debug(`Baileys-Protokollversion: ${version.join('.')}`);
  } catch (error) {
    log.warn(`Protokollversion konnte nicht abgefragt werden (${error.message}) – nutze die eingebaute`);
  }

  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      logger: silentLogger,
      printQRInTerminal: false, // wir rendern den QR-Code selbst
      browser: ['chatendar', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false, // Push-Benachrichtigungen auf dem Handy nicht unterdrücken
      syncFullHistory: false,
    });

    socket.ev.on('creds.update', saveCreds);

    let outcome;
    try {
      outcome = await waitForConnection(socket, { connectTimeoutMs, allowQr });
    } catch (error) {
      lastError = error;
      safeEnd(socket);
      throw error; // nicht behebbar (z. B. ausgeloggt, Timeout)
    }

    if (outcome.connected) {
      log.info(`WhatsApp verbunden als "${socket.user?.name ?? socket.user?.id ?? 'unbekannt'}"`);
      return buildClient(socket, config);
    }

    // Verbindung wurde geschlossen, ein neuer Versuch ist aber sinnvoll.
    safeEnd(socket);
    lastError = outcome.error;
    log.warn(
      `Verbindungsversuch ${attempt}/${maxAttempts} fehlgeschlagen (${outcome.reasonText}) – neuer Versuch`,
    );
    await delay(2000 * attempt);
  }

  throw new Error(
    `WhatsApp-Verbindung nach ${maxAttempts} Versuchen fehlgeschlagen: ${lastError?.message ?? 'unbekannter Grund'}`,
  );
}

/**
 * Wartet auf "connection: open" bzw. einen endgültigen Abbruch.
 *
 * @returns {Promise<{connected: boolean, error?: Error, reasonText?: string}>}
 *          Auflösung mit connected=false bedeutet "erneut versuchen".
 *          Endgültige Fehler werden geworfen.
 */
function waitForConnection(socket, { connectTimeoutMs, allowQr }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let qrShown = false;

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Zeitüberschreitung beim Verbindungsaufbau nach ${Math.round(connectTimeoutMs / 1000)}s ` +
              '(CONNECT_TIMEOUT_MS). Besteht eine Internetverbindung? Ist die Session noch gültig?',
          ),
        ),
      );
    }, connectTimeoutMs);

    function finish(action) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.ev.off('connection.update', onUpdate);
      action();
    }

    function onUpdate(update) {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (!allowQr) {
          finish(() =>
            reject(
              new Error(
                'WhatsApp verlangt eine neue Kopplung (QR-Code). Die gespeicherte Session ist ungültig.\n' +
                  '   Bitte "npm run pair" ausführen und neu koppeln.',
              ),
            ),
          );
          return;
        }
        if (!qrShown) {
          qrShown = true;
          log.info('Bitte diesen QR-Code in WhatsApp scannen (Verknüpfte Geräte > Gerät verknüpfen):');
        }
        qrcode.generate(qr, { small: true });
        return;
      }

      if (connection === 'open') {
        finish(() => resolve({ connected: true }));
        return;
      }

      if (connection === 'close') {
        const error = lastDisconnect?.error;
        const code = statusCodeOf(error);

        if (code === DisconnectReason.loggedOut) {
          finish(() =>
            reject(
              new Error(
                'Die WhatsApp-Session wurde abgemeldet (auf dem Handy entkoppelt).\n' +
                  '   Bitte den Ordner AUTH_DIR löschen und mit "npm run pair" neu koppeln.',
              ),
            ),
          );
          return;
        }

        if (RETRYABLE.has(code)) {
          // restartRequired tritt regulär direkt nach dem Scannen auf.
          finish(() =>
            resolve({
              connected: false,
              error,
              reasonText: `Code ${code}${code === DisconnectReason.restartRequired ? ' (Neustart nach Kopplung)' : ''}`,
            }),
          );
          return;
        }

        finish(() =>
          reject(
            new Error(
              `WhatsApp-Verbindung geschlossen (Code ${code ?? 'unbekannt'}): ${error?.message ?? 'kein Grund angegeben'}`,
            ),
          ),
        );
      }
    }

    socket.ev.on('connection.update', onUpdate);
  });
}

/** Öffentliche Client-Schnittstelle um den Socket herum. */
function buildClient(socket, config) {
  return {
    user: socket.user,

    /**
     * Textnachricht senden.
     * @param {string} jid Ziel (Gruppen-ID, endet auf @g.us)
     * @param {string} text
     */
    async sendText(jid, text) {
      try {
        const result = await socket.sendMessage(jid, { text });
        return result?.key?.id ?? null;
      } catch (error) {
        throw new Error(
          `Nachricht an "${jid}" konnte nicht gesendet werden: ${error.message}\n` +
            '   Stimmt WHATSAPP_GROUP_ID? Die ID lässt sich mit "npm run pair" auflisten.',
        );
      }
    },

    /** Alle Gruppen auflisten, in denen der gekoppelte Account Mitglied ist. */
    async listGroups() {
      const groups = await socket.groupFetchAllParticipating();
      return Object.values(groups).map((group) => ({ id: group.id, subject: group.subject }));
    },

    /** Socket schließen – die Session bleibt erhalten. */
    async close() {
      // Kurz warten, damit ausgehende Nachrichten den Server sicher erreichen.
      await delay(config.sendDelayMs);
      safeEnd(socket);
    },
  };
}

function safeEnd(socket) {
  try {
    socket.end(undefined);
  } catch {
    // Socket war bereits geschlossen – nicht weiter tragisch.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
