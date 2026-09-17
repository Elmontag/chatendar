/**
 * WhatsApp-Anbindung über Baileys (Multi-Device, kein Headless-Browser).
 *
 * Verantwortlichkeiten:
 *  - Session aus AUTH_DIR laden bzw. beim ersten Start per QR-Code koppeln
 *  - Verbindung aufbauen und auf "open" warten, bevor gesendet wird
 *  - Textnachrichten geschützt an Gruppen und Einzelpersonen senden
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
import { classifyDisconnect } from 'baileys-antiban';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

import { log } from '../logger.js';
import { createSendGuard } from './sendGuard.js';
import { targetAddress, targetJid, WHATSAPP_TARGET_TYPES } from './whatsappTarget.js';

/** Baileys ist sehr gesprächig – eigenes Logging reicht uns. */
const silentLogger = pino({ level: 'silent' });

/** Disconnect-Gründe, bei denen ein erneuter Verbindungsversuch sinnvoll ist. */
const RETRYABLE = new Set([
  DisconnectReason.connectionClosed,
  DisconnectReason.connectionLost,
  DisconnectReason.restartRequired,
  DisconnectReason.timedOut,
  DisconnectReason.unavailableService,
]);

const FATAL = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.forbidden,
  DisconnectReason.badSession,
  DisconnectReason.multideviceMismatch,
  DisconnectReason.connectionReplaced,
]);

export function disconnectPolicy(code) {
  if (FATAL.has(code)) {
    return { shouldReconnect: false, retryAfterMs: 0, reason: 'WhatsApp-Session muss geprüft oder neu gekoppelt werden' };
  }
  const classified = Number.isInteger(code) ? classifyDisconnect(code) : null;
  if (RETRYABLE.has(code)) {
    return {
      shouldReconnect: true,
      retryAfterMs: code === DisconnectReason.restartRequired ? 2000 : (classified?.backoffMs ?? 2000),
      reason: classified?.message,
    };
  }
  return {
    shouldReconnect: classified?.category !== 'unknown' && (classified?.shouldReconnect ?? false),
    retryAfterMs: classified?.backoffMs ?? 0,
    reason: classified?.message,
  };
}

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
    await delay(outcome.retryAfterMs ?? 2000 * attempt);
  }

  throw new Error(
    `WhatsApp-Verbindung nach ${maxAttempts} Versuchen fehlgeschlagen: ${lastError?.message ?? 'unbekannter Grund'}`,
  );
}

/**
 * Wartet auf "connection: open" bzw. einen endgültigen Abbruch.
 *
 * @returns {Promise<{connected: boolean, error?: Error, reasonText?: string, retryAfterMs?: number}>}
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

        const policy = disconnectPolicy(code);
        if (policy.shouldReconnect) {
          // restartRequired tritt regulär direkt nach dem Scannen auf.
          finish(() =>
            resolve({
              connected: false,
              error,
              reasonText:
                `Code ${code}${code === DisconnectReason.restartRequired ? ' (Neustart nach Kopplung)' : ''}` +
                (policy.reason ? ` – ${policy.reason}` : ''),
              retryAfterMs: policy.retryAfterMs,
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
export function buildClient(socket, config) {
  const sendGuard = createSendGuard(config);
  const verifiedPeople = new Map();

  sendGuard.onReconnect();

  const onConnectionUpdate = ({ connection, lastDisconnect }) => {
    if (connection === 'close') sendGuard.onDisconnect(statusCodeOf(lastDisconnect?.error));
    if (connection === 'open') sendGuard.onReconnect();
  };
  socket.ev.on('connection.update', onConnectionUpdate);

  async function resolveRecipient(target) {
    const jid = targetJid(target);
    if (target?.type !== WHATSAPP_TARGET_TYPES.PERSON) return jid;
    if (verifiedPeople.has(jid)) return verifiedPeople.get(jid);
    if (typeof socket.onWhatsApp !== 'function') {
      throw new Error('Die WhatsApp-Erreichbarkeit der Telefonnummer kann nicht geprüft werden');
    }

    const result = await socket.onWhatsApp(jid.slice(0, jid.indexOf('@')));
    const match = result?.find((entry) => entry?.exists);
    if (!match?.jid) {
      throw new Error(`Telefonnummer "${target.phone}" ist nicht bei WhatsApp registriert`);
    }
    verifiedPeople.set(jid, match.jid);
    return match.jid;
  }

  return {
    user: socket.user,

    /**
     * Textnachricht senden.
     * @param {object|string} target Kanonisches Ziel oder bestehende JID
     * @param {string} text
     */
    async sendText(target, text) {
      const address = typeof target === 'string' ? target : targetAddress(target);
      try {
        const jid = typeof target === 'string' ? target : await resolveRecipient(target);
        const result = await sendGuard.send(jid, text, () => socket.sendMessage(jid, { text }));
        return result?.key?.id ?? null;
      } catch (error) {
        throw new Error(
          `Nachricht an "${address}" konnte nicht gesendet werden: ${error.message}\n` +
            '   Gruppen-ID bzw. Telefonnummer und WhatsApp-Kopplung prüfen.',
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
      socket.ev.off('connection.update', onConnectionUpdate);
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
