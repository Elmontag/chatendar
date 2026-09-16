import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupReminders } from '../src/reminders/batching.js';
import { buildReminders } from '../src/reminders/scheduler.js';
import { buildEventValues, buildGroupMessage, render } from '../src/messaging/templateRenderer.js';
import { makeEvent, testConfig } from './helpers.js';

const config = testConfig();

describe('render', () => {
  it('ersetzt Platzhalter', () => {
    assert.equal(render('Hallo {name}!', { name: 'Welt' }), 'Hallo Welt!');
  });

  it('ersetzt unbekannte Platzhalter durch einen leeren String', () => {
    assert.equal(render('A{fehlt}B', {}), 'AB');
  });

  it('gibt bedingte Abschnitte nur bei gefülltem Wert aus', () => {
    assert.equal(render('X{?ort} in {ort}{/ort}', { ort: 'Aula' }), 'X in Aula');
    assert.equal(render('X{?ort} in {ort}{/ort}', { ort: '' }), 'X');
    assert.equal(render('X{?ort} in {ort}{/ort}', {}), 'X');
  });

  it('behandelt reine Leerzeichen als leer', () => {
    assert.equal(render('{?ort}[{ort}]{/ort}', { ort: '   ' }), '');
  });
});

describe('buildEventValues', () => {
  it('formatiert Datum und Uhrzeit in der konfigurierten Zeitzone', () => {
    const reminder = buildReminders(makeEvent({ start: new Date('2026-09-20T16:30:00Z') }), config)[0];
    const values = buildEventValues(reminder, config);
    assert.equal(values.datum, 'So., 20.09.2026');
    assert.equal(values.uhrzeit, '18:30');
    assert.equal(values.wochentag, 'Sonntag');
    assert.equal(values.vorlauf, '1 Tag');
  });

  it('lässt die Uhrzeit bei ganztägigen Terminen leer', () => {
    const reminder = buildReminders(makeEvent({ ganztags: true }), config)[0];
    const values = buildEventValues(reminder, config);
    assert.equal(values.uhrzeit, '');
    assert.equal(values.ganztag, 'ganztägig');
  });

  it('nutzt LOCATION_FALLBACK, wenn kein Ort gesetzt ist', () => {
    const mitFallback = testConfig({ env: { LOCATION_FALLBACK: 'Ort folgt' } });
    const reminder = buildReminders(makeEvent({ ort: null }), mitFallback)[0];
    assert.equal(buildEventValues(reminder, mitFallback).ort, 'Ort folgt');
  });
});

describe('buildGroupMessage', () => {
  it('nutzt bei einem Termin das Einzel-Template', () => {
    const event = makeEvent({ titel: 'Elternabend', ort: 'Aula', start: new Date('2026-09-20T16:30:00Z') });
    const group = groupReminders(buildReminders(event, config))[0];
    const text = buildGroupMessage(group, config);

    assert.match(text, /Elternabend/);
    assert.match(text, /So\., 20\.09\.2026/);
    assert.match(text, /18:30 Uhr/);
    assert.match(text, /Aula/);
    assert.doesNotMatch(text, /Termine:/);
  });

  it('lässt die Ortszeile weg, wenn kein Ort vorhanden ist', () => {
    const group = groupReminders(buildReminders(makeEvent({ ort: null }), config))[0];
    assert.doesNotMatch(buildGroupMessage(group, config), /📍/);
  });

  it('nutzt bei mehreren Terminen das Sammel-Template', () => {
    const due = [
      ...buildReminders(makeEvent({ id: 'a', titel: 'Elternabend', start: new Date('2026-09-20T16:30:00Z') }), config),
      ...buildReminders(makeEvent({ id: 'b', titel: 'Vereinssitzung', start: new Date('2026-09-20T17:00:00Z') }), config),
    ];
    const group = groupReminders(due)[0];
    const text = buildGroupMessage(group, config);

    assert.match(text, /2 Termine:/);
    assert.match(text, /Elternabend/);
    assert.match(text, /Vereinssitzung/);
    // Reihenfolge: chronologisch
    assert.ok(text.indexOf('Elternabend') < text.indexOf('Vereinssitzung'));
  });

  it('respektiert eigene Templates aus der Config', () => {
    const eigenes = testConfig({
      env: { TEMPLATE_SINGLE: 'Achtung: {titel} am {datum_kurz}' },
    });
    const group = groupReminders(buildReminders(makeEvent({ titel: 'Test' }), eigenes))[0];
    assert.equal(buildGroupMessage(group, eigenes), 'Achtung: Test am 20.09.2026');
  });
});
