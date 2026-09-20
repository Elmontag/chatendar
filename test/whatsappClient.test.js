import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DisconnectReason, WAMessageStatus } from '@whiskeysockets/baileys';

import {
  acquireSessionLock,
  buildClient,
  createBaileysLogger,
  createMessageStore,
  disconnectPolicy,
  restoreCredsBackup,
  writeCredsAtomically,
} from '../src/messaging/whatsappClient.js';

function makeSocket({ registered = true } = {}) {
  const sent = [];
  const lookups = [];
  const ev = new EventEmitter();
  return {
    sent,
    lookups,
    ev,
    ended: false,
    user: { id: 'bot@s.whatsapp.net' },
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      return { key: { id: `message-${sent.length}` }, message: { conversation: content.text } };
    },
    async onWhatsApp(phone) {
      lookups.push(phone);
      return registered ? [{ exists: true, jid: `${phone}@s.whatsapp.net` }] : [];
    },
    async groupFetchAllParticipating() {
      return {};
    },
    end() {
      this.ended = true;
    },
  };
}

function config() {
  return {
    antibanEnabled: false,
    authDir: 'unused',
    sendDelayMs: 0,
    sendDelayMaxMs: 0,
    sendSettleMs: 0,
    whatsappTargets: [],
  };
}

const GROUP = { type: 'group', id: '120363000000000001@g.us', name: 'Klasse' };
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('WhatsApp-Client', () => {
  it('verhindert die parallele Verwendung eines Session-Ordners', () => {
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-auth-'));
    const release = acquireSessionLock(authDir);

    try {
      assert.throws(() => acquireSessionLock(authDir), /wird bereits von Prozess/);
      release();
      const releaseAgain = acquireSessionLock(authDir);
      releaseAgain();
    } finally {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  });

  it('wartet beim Schließen auf Session-Schreibvorgänge und gibt die Sperre einmalig frei', async () => {
    const socket = makeSocket();
    const calls = [];
    const client = buildClient(socket, config(), {
      persistCredentials: () => {},
      flushCredentials: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        calls.push('flush');
      },
      releaseLock: () => calls.push('release'),
    });

    await client.close();
    await client.close();

    assert.deepEqual(calls, ['flush', 'release']);
  });

  it('behält regulären Pairing-Neustart bei und übernimmt Rate-Limit-Backoff', () => {
    assert.deepEqual(disconnectPolicy(DisconnectReason.restartRequired).shouldReconnect, true);
    assert.equal(disconnectPolicy(DisconnectReason.restartRequired).retryAfterMs, 2000);
    assert.equal(disconnectPolicy(429).retryAfterMs, 300000);
    assert.equal(disconnectPolicy(DisconnectReason.loggedOut).shouldReconnect, false);
    assert.equal(disconnectPolicy(DisconnectReason.forbidden).shouldReconnect, false);
    assert.equal(disconnectPolicy(DisconnectReason.badSession).shouldReconnect, false);
    assert.equal(disconnectPolicy(DisconnectReason.connectionReplaced).shouldReconnect, false);
    assert.equal(disconnectPolicy(999).shouldReconnect, false);
  });

  it('sendet Gruppen unverändert an ihre JID', async () => {
    const socket = makeSocket();
    const client = buildClient(socket, config());

    const id = await client.sendText(
      { type: 'group', id: '120363000000000001@g.us', name: 'Klasse' },
      'Unveränderter Text',
    );

    assert.equal(id, 'message-1');
    assert.deepEqual(socket.sent, [{
      jid: '120363000000000001@g.us',
      content: { text: 'Unveränderter Text' },
    }]);
    assert.deepEqual(socket.lookups, []);
  });

  it('prüft Personen einmalig und sendet an die bestätigte JID', async () => {
    const socket = makeSocket();
    const client = buildClient(socket, config());
    const target = { type: 'person', phone: '+49 151 12345678', name: 'Ada' };

    await client.sendText(target, 'Erste Nachricht');
    await client.sendText(target, 'Zweite Nachricht');

    assert.deepEqual(socket.lookups, ['4915112345678']);
    assert.deepEqual(socket.sent.map((entry) => entry.jid), [
      '4915112345678@s.whatsapp.net',
      '4915112345678@s.whatsapp.net',
    ]);
  });

  it('sendet nicht an eine unregistrierte Telefonnummer', async () => {
    const socket = makeSocket({ registered: false });
    const client = buildClient(socket, config());

    await assert.rejects(
      client.sendText({ type: 'person', phone: '+4915112345678', name: 'Ada' }, 'Hallo'),
      /nicht bei WhatsApp registriert/,
    );
    assert.deepEqual(socket.sent, []);
  });
  it('speichert gesendete Nachrichten für Retry-Anfragen', async () => {
    const socket = makeSocket();
    const messageStore = createMessageStore();
    const client = buildClient(socket, config(), { messageStore });

    await client.sendText(GROUP, 'Hallo Klasse');

    assert.deepEqual(messageStore.get('message-1'), { conversation: 'Hallo Klasse' });
    assert.equal(messageStore.get('unbekannt'), undefined);
  });

  it('begrenzt den Nachrichtenspeicher und verwirft die ältesten Einträge', () => {
    const store = createMessageStore(2);
    store.remember('a', { conversation: 'a' });
    store.remember('b', { conversation: 'b' });
    store.remember('c', { conversation: 'c' });

    assert.equal(store.get('a'), undefined);
    assert.ok(store.get('b'));
    assert.ok(store.get('c'));
  });

  it('wartet beim Schließen auf die Zustellbestätigung eines Einzelchats', async () => {
    const socket = makeSocket();
    const client = buildClient(socket, { ...config(), sendSettleMs: 5000 });
    await client.sendText({ type: 'person', phone: '+4915112345678', name: 'Ada' }, 'Hallo');

    let closed = false;
    const closing = client.close().then(() => {
      closed = true;
    });
    await tick();
    assert.equal(socket.ended, false, 'Socket darf vor der Bestätigung nicht geschlossen sein');

    socket.ev.emit('messages.update', [
      { key: { id: 'message-1', fromMe: true }, update: { status: WAMessageStatus.DELIVERY_ACK } },
    ]);
    await closing;

    assert.equal(closed, true);
    assert.equal(socket.ended, true);
  });

  it('wartet bei Gruppen auf eine Zustellbestätigung eines Mitglieds', async () => {
    const socket = makeSocket();
    const client = buildClient(socket, { ...config(), sendSettleMs: 5000 });
    await client.sendText(GROUP, 'Hallo');

    const closing = client.close();
    await tick();
    assert.equal(socket.ended, false);

    socket.ev.emit('message-receipt.update', [
      { key: { id: 'message-1' }, receipt: { userJid: 'x@s.whatsapp.net', receiptTimestamp: 1 } },
    ]);
    await closing;

    assert.equal(socket.ended, true);
  });

  it('erkennt eine Bestätigung, die vor der Rückkehr von sendMessage eintrifft', async () => {
    const socket = makeSocket();
    const send = socket.sendMessage.bind(socket);
    socket.sendMessage = async (jid, content) => {
      const result = await send(jid, content);
      socket.ev.emit('messages.update', [
        { key: { id: result.key.id }, update: { status: WAMessageStatus.READ } },
      ]);
      return result;
    };
    const client = buildClient(socket, { ...config(), sendSettleMs: 60000 });
    await client.sendText(GROUP, 'Hallo');

    const started = Date.now();
    await client.close();

    assert.ok(Date.now() - started < 5000);
  });

  it('schließt nach sendSettleMs auch ohne Bestätigung', async () => {
    const socket = makeSocket();
    const client = buildClient(socket, { ...config(), sendSettleMs: 30 });
    await client.sendText(GROUP, 'Hallo');

    const started = Date.now();
    await client.close();

    assert.equal(socket.ended, true);
    assert.ok(Date.now() - started < 1000);
  });

  it('bricht das Warten ab, wenn die Verbindung wegbricht', async () => {
    const socket = makeSocket();
    const client = buildClient(socket, { ...config(), sendSettleMs: 60000 });
    await client.sendText(GROUP, 'Hallo');

    const closing = client.close();
    await tick();
    socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
    await closing;

    assert.equal(socket.ended, true);
  });

  it('wartet nicht, wenn nichts gesendet wurde oder sendSettleMs 0 ist', async () => {
    const idle = makeSocket();
    await buildClient(idle, { ...config(), sendSettleMs: 60000 }).close();
    assert.equal(idle.ended, true);

    const immediate = makeSocket();
    const client = buildClient(immediate, config());
    await client.sendText(GROUP, 'Hallo');
    await client.close();
    assert.equal(immediate.ended, true);
  });

  it('schreibt das Baileys-Protokoll nur bei gesetztem BAILEYS_LOG_LEVEL', () => {
    assert.equal(createBaileysLogger({}).level, 'silent');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-baileys-log-'));
    try {
      const file = path.join(dir, 'unterordner', 'baileys.log');
      const logger = createBaileysLogger({ BAILEYS_LOG_LEVEL: 'debug', BAILEYS_LOG_FILE: file });
      logger.debug('Probe');
      assert.equal(logger.level, 'debug');
      assert.match(fs.readFileSync(file, 'utf8'), /Probe/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('kehrt nach verlorener Verbindung sofort zurück statt zu warten', async () => {
    const socket = makeSocket();
    const client = buildClient(socket, { ...config(), sendSettleMs: 60000 });
    await client.sendText(GROUP, 'Hallo');
    socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });

    const started = Date.now();
    await client.close();

    assert.ok(Date.now() - started < 1000);
    assert.equal(socket.ended, true);
  });

  describe('creds.json-Schutz', () => {
    const creds = () => ({
      noiseKey: { private: Buffer.from('a'), public: Buffer.from('b') },
      signedIdentityKey: { private: Buffer.from('c'), public: Buffer.from('d') },
      me: { id: '491600000000:1@s.whatsapp.net' },
    });
    const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-creds-'));

    it('schreibt atomar, hält die letzte gültige Fassung vor und liest sie wie Baileys', () => {
      const dir = tempDir();
      try {
        writeCredsAtomically(dir, creds());
        assert.equal(fs.existsSync(path.join(dir, 'creds.json.bak')), false);
        writeCredsAtomically(dir, { ...creds(), me: { id: 'neu@s.whatsapp.net' } });

        const current = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'));
        const backup = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json.bak'), 'utf8'));
        assert.equal(current.me.id, 'neu@s.whatsapp.net');
        assert.equal(backup.me.id, '491600000000:1@s.whatsapp.net');
        assert.equal(current.noiseKey.private.type, 'Buffer');
        assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('stellt eine beschädigte creds.json aus der Sicherung wieder her', () => {
      const dir = tempDir();
      try {
        writeCredsAtomically(dir, creds());
        writeCredsAtomically(dir, creds());
        fs.writeFileSync(path.join(dir, 'creds.json'), '{"noiseKey":{"priv');

        assert.equal(restoreCredsBackup(dir), true);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')).me.id, '491600000000:1@s.whatsapp.net');
        assert.ok(fs.existsSync(path.join(dir, 'creds.json.corrupt')));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('stellt nichts wieder her, wenn creds.json fehlt, intakt ist oder keine gültige Sicherung existiert', () => {
      const dir = tempDir();
      try {
        assert.equal(restoreCredsBackup(dir), false);

        writeCredsAtomically(dir, creds());
        writeCredsAtomically(dir, creds());
        assert.equal(restoreCredsBackup(dir), false, 'intakte Datei bleibt unberührt');

        fs.rmSync(path.join(dir, 'creds.json'));
        assert.equal(restoreCredsBackup(dir), false, 'bewusst gelöschte Datei bleibt gelöscht');
        assert.equal(fs.existsSync(path.join(dir, 'creds.json')), false);

        fs.writeFileSync(path.join(dir, 'creds.json'), 'kaputt');
        fs.writeFileSync(path.join(dir, 'creds.json.bak'), 'auch kaputt');
        assert.equal(restoreCredsBackup(dir), false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
  it('führt afterClose nach dem Flush und vor der Lock-Freigabe aus', async () => {
    const socket = makeSocket();
    const calls = [];
    const client = buildClient(socket, config(), {
      flushCredentials: async () => calls.push('flush'),
      releaseLock: () => calls.push('release'),
      afterClose: async () => calls.push('afterClose'),
    });

    await client.close();

    assert.deepEqual(calls, ['flush', 'afterClose', 'release']);
  });

  it('gibt die Sperre auch frei, wenn afterClose fehlschlägt, und überspringt es bei Flush-Fehlern', async () => {
    const failing = [];
    const client = buildClient(makeSocket(), config(), {
      releaseLock: () => failing.push('release'),
      afterClose: async () => {
        throw new Error('Platte voll');
      },
    });
    await client.close();
    assert.deepEqual(failing, ['release']);

    const calls = [];
    const broken = buildClient(makeSocket(), config(), {
      flushCredentials: async () => {
        throw new Error('nicht gespeichert');
      },
      releaseLock: () => calls.push('release'),
      afterClose: () => calls.push('afterClose'),
    });
    await assert.rejects(broken.close(), /nicht gespeichert/);
    assert.deepEqual(calls, ['release'], 'ohne gültige Zugangsdaten keine Sicherung');
  });

  it('waitUntilSynced kehrt bei Ereignis, Zeitüberschreitung oder Verbindungsabbruch zurück', async () => {
    const socket = makeSocket();
    const client = buildClient(socket, config());

    const waiting = client.waitUntilSynced(5000);
    socket.ev.emit('connection.update', { receivedPendingNotifications: true });
    assert.equal(await waiting, true);
    assert.equal(await client.waitUntilSynced(5000), true, 'bleibt wahr, sobald synchronisiert');

    const timeoutClient = buildClient(makeSocket(), config());
    assert.equal(await timeoutClient.waitUntilSynced(20), false);

    const droppedSocket = makeSocket();
    const droppedClient = buildClient(droppedSocket, config());
    const dropped = droppedClient.waitUntilSynced(5000);
    droppedSocket.ev.emit('connection.update', { connection: 'close', lastDisconnect: {} });
    assert.equal(await dropped, false);
    assert.equal(await droppedClient.waitUntilSynced(5000), false);

    const early = buildClient(makeSocket(), config(), { alreadySynced: true });
    assert.equal(await early.waitUntilSynced(5000), true);
  });
});
