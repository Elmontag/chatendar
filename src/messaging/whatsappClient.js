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
  BufferJSON,
  default as makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  WAMessageStatus,
} from '@whiskeysockets/baileys';
import { classifyDisconnect } from 'baileys-antiban';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

import { log } from '../logger.js';
import { createSendGuard } from './sendGuard.js';
import { maintainSession, recordConnection } from './sessionMaintenance.js';
import { targetAddress, targetJid, WHATSAPP_TARGET_TYPES } from './whatsappTarget.js';

/** Kurze Nachlaufzeit nach der letzten Zustellbestätigung (späte Retry-Anfragen einzelner Gruppenmitglieder). */
const SETTLE_TAIL_MS = 1500;

/** Wie viele gesendete Nachrichten für Retry-Anfragen im Speicher bleiben. */
const SENT_MESSAGE_LIMIT = 256;

/**
 * Baileys ist sehr gesprächig – eigenes Logging reicht uns.
 *
 * Zur Fehlersuche (z. B. "Warte auf diese Nachricht" beim Empfänger) lässt sich das
 * Baileys-Protokoll mit BAILEYS_LOG_LEVEL=debug in BAILEYS_LOG_FILE
 * (Standard ./data/baileys.log) mitschreiben. Die Datei enthält Rufnummern und
 * gehört nicht ins Repo (data/ ist in .gitignore).
 */
export function createBaileysLogger(env = process.env) {
  const level = env.BAILEYS_LOG_LEVEL?.trim();
  if (!level || level === 'silent') return pino({ level: 'silent' });
  const dest = path.resolve(env.BAILEYS_LOG_FILE?.trim() || './data/baileys.log');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return pino({ level }, pino.destination({ dest, sync: true }));
}

/**
 * Merkt sich zuletzt gesendete Nachrichten. Baileys braucht sie über `getMessage`,
 * um Retry-Anfragen eines Empfängers zu beantworten, der die Nachricht nicht
 * entschlüsseln konnte (sonst bleibt dort "Warte auf diese Nachricht" stehen).
 */
export function createMessageStore(limit = SENT_MESSAGE_LIMIT) {
  const messages = new Map();
  return {
    remember(id, message) {
      if (!id || !message) return;
      messages.delete(id);
      messages.set(id, message);
      while (messages.size > limit) messages.delete(messages.keys().next().value);
    },
    get(id) {
      return messages.get(id);
    },
  };
}

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

/** Verhindert, dass zwei Prozesse dieselbe Baileys-Session gleichzeitig verwenden. */
export function acquireSessionLock(authDir) {
  fs.mkdirSync(authDir, { recursive: true });
  const lockPath = path.join(authDir, '.chatendar.lock');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(descriptor, `${process.pid}\n`);
      fs.closeSync(descriptor);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.unlinkSync(lockPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      const lockStat = fs.statSync(lockPath);
      const ownerPid = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
      let ownerRunning = Number.isInteger(ownerPid);
      if (ownerRunning) {
        try {
          process.kill(ownerPid, 0);
        } catch (probeError) {
          ownerRunning = probeError.code === 'EPERM';
        }
      }
      const lockIsBeingCreated = !Number.isInteger(ownerPid) && Date.now() - lockStat.mtimeMs < 5000;
      if (ownerRunning || lockIsBeingCreated) {
        throw new Error(
          `WhatsApp-Session "${authDir}" wird bereits${ownerRunning ? ` von Prozess ${ownerPid}` : ''} verwendet. ` +
            'Überlappende Cron-Läufe sind nicht zulässig.',
        );
      }
      fs.unlinkSync(lockPath);
    }
  }

  throw new Error(`Sperre für WhatsApp-Session "${authDir}" konnte nicht angelegt werden`);
}

const CREDS_FILE = 'creds.json';

/** Ist die Datei lesbares JSON mit den Grundschlüsseln einer Baileys-Session? */
function isValidCredsFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Boolean(parsed && typeof parsed === 'object' && parsed.noiseKey && parsed.signedIdentityKey);
  } catch {
    return false;
  }
}

/**
 * Baileys schreibt creds.json mit einem einfachen writeFile (erst leeren, dann
 * schreiben). Bricht der Prozess dabei ab (SIGKILL, Stromausfall, Speicher voll),
 * bleibt eine unlesbare Datei zurück, Baileys legt stillschweigend neue
 * Zugangsdaten an, und es muss neu gekoppelt werden. Deshalb: temporäre Datei
 * schreiben, auf Platte sichern, dann atomar umbenennen – und die letzte gültige
 * Fassung als creds.json.bak aufheben.
 */
export function writeCredsAtomically(authDir, creds) {
  const file = path.join(authDir, CREDS_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(creds, BufferJSON.replacer));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (isValidCredsFile(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(temporary, file);
}

/**
 * Ist creds.json vorhanden, aber unlesbar, wird die letzte gültige Sicherung
 * wiederhergestellt. Eine fehlende Datei (bewusst gelöscht = neu koppeln) bleibt fehlend.
 * @returns {boolean} true, wenn wiederhergestellt wurde
 */
export function restoreCredsBackup(authDir) {
  const file = path.join(authDir, CREDS_FILE);
  const backup = `${file}.bak`;
  if (!fs.existsSync(file) || isValidCredsFile(file) || !isValidCredsFile(backup)) return false;
  fs.copyFileSync(file, `${file}.corrupt`);
  fs.copyFileSync(backup, file);
  return true;
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
  const releaseLock = acquireSessionLock(authDir);

  try {
    if (restoreCredsBackup(authDir)) {
      log.warn(
        `creds.json in "${authDir}" war beschädigt und wurde aus creds.json.bak wiederhergestellt ` +
          '(die defekte Datei liegt als creds.json.corrupt daneben).',
      );
    }

    if (!hasSession(authDir) && !allowQr) {
      throw new Error(
        `Keine WhatsApp-Session in "${authDir}" gefunden.\n` +
          '   Bitte einmalig "npm run pair" ausführen und den QR-Code mit WhatsApp scannen\n' +
          '   (WhatsApp > Einstellungen > Verknüpfte Geräte > Gerät verknüpfen).',
      );
    }

    const { state } = await useMultiFileAuthState(authDir);
    const saveCreds = async () => writeCredsAtomically(authDir, state.creds);
    const baileysLogger = createBaileysLogger();
    const messageStore = createMessageStore();
    let credentialWrites = Promise.resolve();
    let credentialWriteError = null;

    function persistCredentials() {
      credentialWrites = credentialWrites
        .then(() => saveCreds())
        .catch((error) => {
          credentialWriteError ??= error;
        });
    }

    async function flushCredentials() {
      await credentialWrites;
      if (credentialWriteError) {
        throw new Error(`WhatsApp-Session konnte nicht gespeichert werden: ${credentialWriteError.message}`);
      }
    }

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
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        logger: baileysLogger,
        getMessage: async (key) => messageStore.get(key?.id),
        printQRInTerminal: false, // wir rendern den QR-Code selbst
        browser: ['chatendar', 'Chrome', '1.0.0'],
        markOnlineOnConnect: false, // Push-Benachrichtigungen auf dem Handy nicht unterdrücken
        syncFullHistory: false,
      });

      socket.ev.on('creds.update', persistCredentials);

      let outcome;
      try {
        outcome = await waitForConnection(socket, { connectTimeoutMs, allowQr });
      } catch (error) {
        safeEnd(socket);
        socket.ev.off('creds.update', persistCredentials);
        await flushCredentials();
        throw error; // nicht behebbar (z. B. ausgeloggt, Timeout)
      }

      if (outcome.connected) {
        log.info(`WhatsApp verbunden als "${socket.user?.name ?? socket.user?.id ?? 'unbekannt'}"`);
        try {
          recordConnection(authDir);
        } catch (error) {
          log.warn(`Verbindungszeitpunkt konnte nicht gespeichert werden: ${error.message}`);
        }
        return buildClient(socket, config, {
          persistCredentials,
          flushCredentials,
          releaseLock,
          messageStore,
          alreadySynced: outcome.synced,
          // Nach erfolgreichem Pairing immer sichern, sonst höchstens einmal täglich.
          afterClose: () => maintainSession(config, { force: allowQr }),
        });
      }

      // Verbindung wurde geschlossen, ein neuer Versuch ist aber sinnvoll.
      safeEnd(socket);
      socket.ev.off('creds.update', persistCredentials);
      await flushCredentials();
      lastError = outcome.error;
      log.warn(
        `Verbindungsversuch ${attempt}/${maxAttempts} fehlgeschlagen (${outcome.reasonText}) – neuer Versuch`,
      );
      await delay(outcome.retryAfterMs ?? 2000 * attempt);
    }

    throw new Error(
      `WhatsApp-Verbindung nach ${maxAttempts} Versuchen fehlgeschlagen: ${lastError?.message ?? 'unbekannter Grund'}`,
    );
  } catch (error) {
    releaseLock();
    throw error;
  }
}

/**
 * Wartet auf "connection: open" bzw. einen endgültigen Abbruch.
 *
 * @returns {Promise<{connected: boolean, synced?: boolean, error?: Error, reasonText?: string, retryAfterMs?: number}>}
 *          Auflösung mit connected=false bedeutet "erneut versuchen".
 *          Endgültige Fehler werden geworfen.
 */
function waitForConnection(socket, { connectTimeoutMs, allowQr }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let qrShown = false;
    let synced = false;

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
      if (update.receivedPendingNotifications) synced = true;

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
        finish(() => resolve({ connected: true, synced }));
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
export function buildClient(
  socket,
  config,
  {
    persistCredentials = null,
    flushCredentials = async () => {},
    releaseLock = () => {},
    messageStore = createMessageStore(),
    alreadySynced = false,
    afterClose = null,
  } = {},
) {
  const sendGuard = createSendGuard(config);
  const verifiedPeople = new Map();
  const settleMs = config.sendSettleMs ?? 0;
  const awaitingDelivery = new Set();
  const delivered = new Set();
  let sentCount = 0;
  let onAllDelivered = null;
  let connectionLost = false;
  let synced = alreadySynced;
  let onSynced = null;
  let closed = false;

  sendGuard.onReconnect();

  function markDelivered(id) {
    if (!id) return;
    delivered.add(id);
    if (awaitingDelivery.delete(id) && awaitingDelivery.size === 0) onAllDelivered?.();
  }

  const onConnectionUpdate = ({ connection, lastDisconnect, receivedPendingNotifications }) => {
    if (receivedPendingNotifications) {
      synced = true;
      onSynced?.(true);
    }
    if (connection === 'close') {
      connectionLost = true;
      sendGuard.onDisconnect(statusCodeOf(lastDisconnect?.error));
      onAllDelivered?.(); // ohne Verbindung kommt keine Bestätigung mehr
      onSynced?.(false);
    }
    if (connection === 'open') {
      connectionLost = false;
      sendGuard.onReconnect();
    }
  };
  // Einzelchats melden Zustellung über messages.update, Gruppen pro Mitglied über message-receipt.update.
  const onMessagesUpdate = (updates) => {
    for (const { key, update } of updates) {
      if (update?.status >= WAMessageStatus.DELIVERY_ACK) markDelivered(key?.id);
    }
  };
  const onReceiptUpdate = (updates) => {
    for (const { key, receipt } of updates) {
      if (receipt?.receiptTimestamp || receipt?.readTimestamp) markDelivered(key?.id);
    }
  };
  socket.ev.on('connection.update', onConnectionUpdate);
  socket.ev.on('messages.update', onMessagesUpdate);
  socket.ev.on('message-receipt.update', onReceiptUpdate);

  /**
   * Vor dem Schließen auf die Zustellbestätigung warten. `sendMessage` kehrt zurück,
   * sobald die Nachricht auf dem Websocket liegt – Retry-Anfragen eines Empfängers,
   * der nicht entschlüsseln konnte, treffen erst danach ein und lassen sich nur bei
   * offener Verbindung beantworten. Zeitüberschreitung ist kein Fehler.
   */
  async function settle() {
    if (settleMs <= 0 || sentCount === 0) return;
    if (connectionLost) {
      if (awaitingDelivery.size > 0) {
        log.warn(`Verbindung vor der Zustellbestätigung von ${awaitingDelivery.size} Nachricht(en) verloren`);
      }
      return;
    }
    const deadline = Date.now() + settleMs;

    if (awaitingDelivery.size > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, settleMs);
        onAllDelivered = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      onAllDelivered = null;
    }

    if (awaitingDelivery.size > 0) {
      log.warn(
        `Zustellung von ${awaitingDelivery.size} Nachricht(en) nicht bestätigt (nach ${settleMs} ms) – ` +
          'ist das Gerät des Empfängers offline?',
      );
      return;
    }
    await delay(Math.max(0, Math.min(SETTLE_TAIL_MS, deadline - Date.now())));
  }

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
    if (match.jid !== jid) log.debug(`WhatsApp-Adresse aufgelöst: ${jid} -> ${match.jid}`);
    verifiedPeople.set(jid, match.jid);
    return match.jid;
  }

  return {
    user: socket.user,

    /**
     * Wartet, bis WhatsApp die aufgelaufenen Offline-Nachrichten zugestellt hat.
     * @returns {Promise<boolean>} true = abgeschlossen; false = Zeitüberschreitung oder Verbindung weg
     */
    waitUntilSynced(timeoutMs) {
      if (synced) return Promise.resolve(true);
      if (connectionLost) return Promise.resolve(false);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          onSynced = null;
          resolve(false);
        }, timeoutMs);
        onSynced = (result) => {
          clearTimeout(timer);
          onSynced = null;
          resolve(result);
        };
      });
    },

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
        const id = result?.key?.id ?? null;
        if (id) {
          messageStore.remember(id, result.message);
          sentCount += 1;
          if (!delivered.has(id)) awaitingDelivery.add(id);
        }
        return id;
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
      if (closed) return;
      closed = true;
      try {
        await settle();
      } catch (error) {
        log.warn(`Warten auf Zustellbestätigung fehlgeschlagen: ${error.message}`);
      }
      socket.ev.off('connection.update', onConnectionUpdate);
      socket.ev.off('messages.update', onMessagesUpdate);
      socket.ev.off('message-receipt.update', onReceiptUpdate);
      try {
        safeEnd(socket);
        if (persistCredentials) socket.ev.off('creds.update', persistCredentials);
        await flushCredentials();
        // Erst nach erfolgreichem Schreiben der Zugangsdaten und noch unter der Sperre.
        if (afterClose) {
          try {
            await afterClose();
          } catch (error) {
            log.warn(`Nachbereitung der Session fehlgeschlagen: ${error.message}`);
          }
        }
      } finally {
        releaseLock();
      }
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
