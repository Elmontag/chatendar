import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizePhoneNumber,
  phoneToJid,
  targetAddress,
  targetJid,
} from '../src/messaging/whatsappTarget.js';

describe('WhatsApp-Ziele', () => {
  it('normalisiert internationale Telefonnummern', () => {
    assert.equal(normalizePhoneNumber('+49 151 123-45-678'), '+4915112345678');
    assert.equal(normalizePhoneNumber('0049 (151) 12345678'), '+4915112345678');
    assert.equal(normalizePhoneNumber('4915112345678'), '+4915112345678');
  });

  it('erzeugt Personen- und Gruppen-JIDs', () => {
    assert.equal(phoneToJid('+49 151 12345678'), '4915112345678@s.whatsapp.net');
    assert.equal(targetJid({ type: 'person', phone: '+49 151 12345678' }), '4915112345678@s.whatsapp.net');
    assert.equal(targetJid({ type: 'group', id: '120363000000000001@g.us' }), '120363000000000001@g.us');
    assert.equal(targetAddress({ type: 'person', phone: '004915112345678' }), '+4915112345678');
  });

  it('lehnt nationale oder syntaktisch ungültige Nummern ab', () => {
    assert.throws(() => normalizePhoneNumber('0151 12345678'), /international/);
    assert.throws(() => normalizePhoneNumber('+49abc'), /ungültige Zeichen/);
    assert.throws(() => normalizePhoneNumber('+49+15112345678'), /international/);
    assert.throws(() => normalizePhoneNumber('+123'), /international/);
  });
});
