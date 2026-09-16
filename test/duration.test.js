import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatDurationHuman,
  formatDurationShort,
  parseDurationList,
  parseDurationToMinutes,
} from '../src/reminders/duration.js';

describe('parseDurationToMinutes', () => {
  it('erkennt die gängigen Einheiten', () => {
    assert.equal(parseDurationToMinutes('30m'), 30);
    assert.equal(parseDurationToMinutes('2h'), 120);
    assert.equal(parseDurationToMinutes('1d'), 1440);
    assert.equal(parseDurationToMinutes('1w'), 10080);
  });

  it('akzeptiert zusammengesetzte Angaben und Groß-/Kleinschreibung', () => {
    assert.equal(parseDurationToMinutes('1d12h'), 1440 + 720);
    assert.equal(parseDurationToMinutes('2H'), 120);
    assert.equal(parseDurationToMinutes(' 90 min '), 90);
  });

  it('interpretiert eine reine Zahl als Minuten', () => {
    assert.equal(parseDurationToMinutes('45'), 45);
  });

  it('lehnt ungültige Angaben ab', () => {
    assert.throws(() => parseDurationToMinutes('morgen früh'), /Unbekanntes Format/);
    assert.throws(() => parseDurationToMinutes('2x'), /Unbekanntes Format/);
    assert.throws(() => parseDurationToMinutes(''), /Leere Vorlaufzeit/);
    assert.throws(() => parseDurationToMinutes('0'), /größer als 0/);
  });
});

describe('Formatierung', () => {
  it('erzeugt stabile Kurzschlüssel', () => {
    assert.equal(formatDurationShort(1440), '1d');
    assert.equal(formatDurationShort(120), '2h');
    assert.equal(formatDurationShort(150), '2h30m');
  });

  it('erzeugt deutschen Fließtext', () => {
    assert.equal(formatDurationHuman(1440), '1 Tag');
    assert.equal(formatDurationHuman(2880), '2 Tage');
    assert.equal(formatDurationHuman(120), '2 Stunden');
    assert.equal(formatDurationHuman(60), '1 Stunde');
    assert.equal(formatDurationHuman(1500), '1 Tag und 1 Stunde');
  });
});

describe('parseDurationList', () => {
  it('zerlegt kommaseparierte Listen', () => {
    assert.deepEqual(parseDurationList('1d, 2h'), [
      { raw: '1d', minutes: 1440 },
      { raw: '2h', minutes: 120 },
    ]);
  });

  it('ignoriert leere Einträge', () => {
    assert.equal(parseDurationList('1d,,2h,').length, 2);
  });
});
