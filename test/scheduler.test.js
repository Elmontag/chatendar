import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildReminders, evaluateReminders, resolveOffsets, SKIP_REASONS } from '../src/reminders/scheduler.js';
import { makeEvent, testConfig } from './helpers.js';

const config = testConfig();
const START = new Date('2026-09-20T16:30:00Z'); // 18:30 Uhr Berlin

describe('resolveOffsets', () => {
  it('nutzt die Default-Vorlaufzeiten', () => {
    const offsets = resolveOffsets(makeEvent(), config);
    assert.deepEqual(offsets.map((o) => o.minutes), [1440, 120]);
  });

  it('bevorzugt die Termin-Property X-WA-REMIND', () => {
    const event = makeEvent({ customProps: { 'X-WA-REMIND': '3h,30m' } });
    assert.deepEqual(resolveOffsets(event, config).map((o) => o.minutes), [180, 30]);
  });

  it('findet die Property auch ohne X-Präfix (so liefert sie node-ical)', () => {
    const event = makeEvent({ customProps: { 'WA-REMIND': '45m' } });
    assert.deepEqual(resolveOffsets(event, config).map((o) => o.minutes), [45]);
  });

  it('begrenzt auf MAX_REMINDERS und behält die zuerst genannten', () => {
    const event = makeEvent({ customProps: { 'X-WA-REMIND': '1w,1d,2h,30m' } });
    assert.deepEqual(resolveOffsets(event, config).map((o) => o.raw), ['1w', '1d']);
  });

  it('entfernt doppelte Vorlaufzeiten', () => {
    const event = makeEvent({ customProps: { 'X-WA-REMIND': '2h,120m' } });
    assert.equal(resolveOffsets(event, config).length, 1);
  });

  it('fällt bei ungültiger Property auf die Defaults zurück', () => {
    const event = makeEvent({ customProps: { 'X-WA-REMIND': 'morgen früh' } });
    assert.deepEqual(resolveOffsets(event, config).map((o) => o.minutes), [1440, 120]);
  });

  it('sortiert absteigend (längster Vorlauf zuerst)', () => {
    const event = makeEvent({ customProps: { 'X-WA-REMIND': '2h,1d' } });
    assert.deepEqual(resolveOffsets(event, config).map((o) => o.minutes), [1440, 120]);
  });
});

describe('buildReminders', () => {
  it('berechnet den Versandzeitpunkt als Start minus Vorlauf', () => {
    const reminders = buildReminders(makeEvent({ start: START }), config);
    assert.equal(reminders[0].sendAt.toISOString(), '2026-09-19T16:30:00.000Z');
    assert.equal(reminders[1].sendAt.toISOString(), '2026-09-20T14:30:00.000Z');
  });

  it('liefert stabile Stufen-Schlüssel', () => {
    const reminders = buildReminders(makeEvent({ start: START }), config);
    assert.deepEqual(reminders.map((r) => r.offsetKey), ['1d', '2h']);
    assert.equal(reminders[0].offsetLabel, '1 Tag');
  });
});

describe('evaluateReminders', () => {
  const event = makeEvent({ start: START });

  it('meldet eine Erinnerung im Prüffenster als fällig', () => {
    const now = new Date('2026-09-19T16:45:00Z'); // 15 min nach dem 1d-Versandzeitpunkt
    const { due } = evaluateReminders([event], config, { now });
    assert.equal(due.length, 1);
    assert.equal(due[0].offsetKey, '1d');
  });

  it('überspringt noch nicht fällige Erinnerungen', () => {
    const now = new Date('2026-09-19T10:00:00Z');
    const { due, skipped } = evaluateReminders([event], config, { now });
    assert.equal(due.length, 0);
    assert.ok(skipped.every((entry) => entry.reason === SKIP_REASONS.NOT_DUE_YET));
  });

  it('überspringt bereits versendete Erinnerungen', () => {
    const now = new Date('2026-09-19T16:45:00Z');
    const { due, skipped } = evaluateReminders([event], config, {
      now,
      isSent: (id, minutes) => minutes === 1440,
    });
    assert.equal(due.length, 0);
    assert.equal(skipped[0].reason, SKIP_REASONS.ALREADY_SENT);
  });

  it('sendet nichts mehr, wenn der Termin bereits läuft', () => {
    const now = new Date('2026-09-20T17:00:00Z');
    const { due, skipped } = evaluateReminders([event], config, { now });
    assert.equal(due.length, 0);
    assert.ok(skipped.some((entry) => entry.reason === SKIP_REASONS.EVENT_STARTED));
  });

  it('holt Erinnerungen vor dem Prüffenster nicht nach', () => {
    const now = new Date('2026-09-19T20:00:00Z'); // 3,5 h nach dem 1d-Versandzeitpunkt
    const { due, skipped } = evaluateReminders([event], config, { now });
    assert.equal(due.length, 0);
    assert.ok(skipped.some((entry) => entry.reason === SKIP_REASONS.WINDOW_MISSED));
  });

  it('holt sie mit CATCH_UP=true doch nach', () => {
    const now = new Date('2026-09-19T20:00:00Z');
    const catchUp = testConfig({ env: { CATCH_UP: 'true' } });
    const { due } = evaluateReminders([event], catchUp, { now });
    assert.equal(due.length, 1);
    assert.equal(due[0].offsetKey, '1d');
  });

  it('respektiert ein größeres Prüffenster', () => {
    const now = new Date('2026-09-19T20:00:00Z');
    const wide = testConfig({ env: { CHECK_WINDOW_MINUTES: '300' } });
    const { due } = evaluateReminders([event], wide, { now });
    assert.equal(due.length, 1);
  });
});
