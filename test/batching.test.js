import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupReminders } from '../src/reminders/batching.js';
import { buildReminders, evaluateReminders } from '../src/reminders/scheduler.js';
import { makeEvent, testConfig } from './helpers.js';

const config = testConfig();

describe('groupReminders', () => {
  it('fasst gleiche Vorlaufzeit-Stufen zu einer Gruppe zusammen', () => {
    const a = makeEvent({ id: 'a', titel: 'A', start: new Date('2026-09-20T16:30:00Z') });
    const b = makeEvent({ id: 'b', titel: 'B', start: new Date('2026-09-20T17:00:00Z') });
    const due = [...buildReminders(a, config), ...buildReminders(b, config)];

    const groups = groupReminders(due);
    assert.equal(groups.length, 2); // 1d und 2h
    assert.equal(groups[0].offsetKey, '1d');
    assert.equal(groups[0].reminders.length, 2);
    assert.equal(groups[1].offsetKey, '2h');
  });

  it('sortiert Gruppen nach längstem Vorlauf zuerst', () => {
    const event = makeEvent({ customProps: { 'X-WA-REMIND': '30m,1w' } });
    const groups = groupReminders(buildReminders(event, config));
    assert.deepEqual(groups.map((g) => g.offsetKey), ['1w', '30m']);
  });

  it('sortiert Termine innerhalb einer Gruppe chronologisch', () => {
    const spaet = makeEvent({ id: 'spaet', titel: 'Spät', start: new Date('2026-09-20T18:00:00Z') });
    const frueh = makeEvent({ id: 'frueh', titel: 'Früh', start: new Date('2026-09-20T16:00:00Z') });
    const due = [...buildReminders(spaet, config), ...buildReminders(frueh, config)];

    const erste = groupReminders(due)[0];
    assert.deepEqual(erste.reminders.map((r) => r.event.titel), ['Früh', 'Spät']);
  });

  it('liefert bei leerer Eingabe keine Gruppen', () => {
    assert.deepEqual(groupReminders([]), []);
  });

  it('bündelt genau das, was in einem Lauf fällig ist', () => {
    // Beide Termine starten so, dass die 1d-Stufe im selben Lauf fällig wird.
    const now = new Date('2026-09-19T17:00:00Z');
    const events = [
      makeEvent({ id: 'a', titel: 'A', start: new Date('2026-09-20T16:30:00Z') }),
      makeEvent({ id: 'b', titel: 'B', start: new Date('2026-09-20T17:00:00Z') }),
      makeEvent({ id: 'c', titel: 'C', start: new Date('2026-09-25T10:00:00Z') }), // noch lange hin
    ];
    const { due } = evaluateReminders(events, config, { now });
    const groups = groupReminders(due);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].offsetKey, '1d');
    assert.deepEqual(groups[0].reminders.map((r) => r.event.titel), ['A', 'B']);
  });
});
