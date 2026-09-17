import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { DisconnectReason } from '@whiskeysockets/baileys';

import { buildClient, disconnectPolicy } from '../src/messaging/whatsappClient.js';

function makeSocket({ registered = true } = {}) {
  const sent = [];
  const lookups = [];
  const ev = new EventEmitter();
  return {
    sent,
    lookups,
    ev,
    user: { id: 'bot@s.whatsapp.net' },
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      return { key: { id: `message-${sent.length}` } };
    },
    async onWhatsApp(phone) {
      lookups.push(phone);
      return registered ? [{ exists: true, jid: `${phone}@s.whatsapp.net` }] : [];
    },
    async groupFetchAllParticipating() {
      return {};
    },
    end() {},
  };
}

function config() {
  return {
    antibanEnabled: false,
    authDir: 'unused',
    sendDelayMs: 0,
    sendDelayMaxMs: 0,
    whatsappTargets: [],
  };
}

describe('WhatsApp-Client', () => {
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
});
