import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupReminders } from '../src/reminders/batching.js';
import { buildReminders } from '../src/reminders/scheduler.js';
import {
  buildEventValues,
  buildGroupMessage,
  eventRangeValues,
  relativeDayLabel,
  render,
} from '../src/messaging/templateRenderer.js';
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
  it('liefert dynamische Tagesangaben relativ zum Laufzeitpunkt', () => {
    assert.equal(relativeDayLabel(new Date('2026-09-19T10:00:00Z'), new Date('2026-09-19T08:00:00Z'), 'Europe/Berlin'), 'Heute');
    assert.equal(relativeDayLabel(new Date('2026-09-20T10:00:00Z'), new Date('2026-09-19T08:00:00Z'), 'Europe/Berlin'), 'Morgen');
    assert.equal(relativeDayLabel(new Date('2026-09-21T10:00:00Z'), new Date('2026-09-19T08:00:00Z'), 'Europe/Berlin'), 'Übermorgen');
    assert.equal(relativeDayLabel(new Date('2026-09-23T10:00:00Z'), new Date('2026-09-19T08:00:00Z'), 'Europe/Berlin'), 'In 4 Tagen');
  });

  it('formatiert Datum und Uhrzeit in der konfigurierten Zeitzone', () => {
    const reminder = buildReminders(makeEvent({ start: new Date('2026-09-20T16:30:00Z') }), config)[0];
    const values = buildEventValues(reminder, config);
    assert.equal(values.datum, 'So., 20.09.2026');
    assert.equal(values.uhrzeit, '18:30');
    assert.equal(values.wochentag, 'Sonntag');
    assert.equal(values.wochentag_kurz, 'So.');
    assert.equal(values.datum_ohne_wochentag, '20.09.2026');
    assert.equal(values.datum_mit_wochentag, 'Sonntag, 20.09.2026');
    assert.equal(values.datum_mit_wochentag_kurz, 'So., 20.09.2026');
    assert.equal(values.vorlauf, '1 Tag');
  });

  it('liefert date-only und Wochentagsvarianten für eintägige Termine', () => {
    const values = eventRangeValues(
      makeEvent({ start: new Date('2026-09-20T16:30:00Z'), ende: new Date('2026-09-20T18:00:00Z') }),
      config,
      new Date('2026-09-19T08:00:00Z'),
    );

    assert.equal(values.tag_relativ, 'Morgen');
    assert.equal(values.tagesbereich_relativ, 'Morgen');
    assert.equal(values.datumsbereich, '20.09.2026');
    assert.equal(values.datumsbereich_mit_wochentag, 'Sonntag, 20.09.2026');
    assert.equal(values.datumsbereich_mit_wochentag_kurz, 'So., 20.09.2026');
    assert.equal(values.termin_zeit, '18:30–20:00 Uhr');
  });

  it('lässt die Uhrzeit bei ganztägigen Terminen leer', () => {
    const reminder = buildReminders(makeEvent({ ganztags: true }), config)[0];
    const values = buildEventValues(reminder, config);
    assert.equal(values.uhrzeit, '');
    assert.equal(values.ganztag, '');
    assert.doesNotMatch(values.termin_zeitraum, /ganztägig|Uhr/);
  });

  it('fasst mehrtägige Termine zu einem Zeitraum zusammen', () => {
    const values = eventRangeValues(
      makeEvent({
        titel: 'Klassenfahrt',
        start: new Date('2026-09-20T08:00:00Z'),
        ende: new Date('2026-09-22T14:00:00Z'),
      }),
      config,
      new Date('2026-09-19T08:00:00Z'),
    );

    assert.equal(values.tag_relativ, 'Morgen');
    assert.equal(values.tag_relativ_ende, 'In 3 Tagen');
    assert.equal(values.tagesbereich_relativ, 'Morgen bis In 3 Tagen');
    assert.equal(values.datumsbereich, '20.09.2026–22.09.2026');
    assert.equal(values.datumsbereich_mit_wochentag, 'Sonntag, 20.09.2026 – Dienstag, 22.09.2026');
    assert.equal(values.datumsbereich_mit_wochentag_kurz, 'So., 20.09.2026 – Di., 22.09.2026');
    assert.equal(values.datum_ende_ohne_wochentag, '22.09.2026');
    assert.equal(values.datum_ende_mit_wochentag, 'Dienstag, 22.09.2026');
    assert.match(values.termin_zeitraum, /Morgen bis In 3 Tagen/);
    assert.match(values.termin_zeitraum, /10:00 Uhr bis In 3 Tagen/);
    assert.match(values.termin_zeitraum, /16:00 Uhr/);
  });

  it('zeigt ganztägige Mehrtagestermine ohne Ganztags-Indikator als Zeitraum', () => {
    const values = eventRangeValues(
      makeEvent({
        titel: 'Ferien',
        ganztags: true,
        start: new Date('2026-09-19T22:00:00Z'),
        ende: new Date('2026-09-22T22:00:00Z'),
      }),
      config,
      new Date('2026-09-19T08:00:00Z'),
    );

    assert.match(values.termin_zeitraum, /Morgen bis In 3 Tagen/);
    assert.doesNotMatch(values.termin_zeitraum, /ganztägig|Uhr/);
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
    assert.match(text, /In 3 Tagen, 20\.09\.2026/);
    assert.match(text, /18:30–20:00 Uhr/);
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

  it('kann relative Tagesangaben in Templates verwenden', () => {
    const eigenes = testConfig({
      env: { TEMPLATE_SINGLE: '{tag_relativ}: {titel} ({datum})' },
    });
    const event = makeEvent({ titel: 'Ausflug', start: new Date('2026-09-20T10:00:00Z') });
    const group = groupReminders(buildReminders(event, eigenes))[0];
    assert.equal(buildGroupMessage(group, eigenes, new Date('2026-09-19T08:00:00Z')), 'Morgen: Ausflug (So., 20.09.2026)');
  });

  it('kann Datum, Zeitraum und Wochentag unabhängig kombinieren', () => {
    const eigenes = testConfig({
      env: { TEMPLATE_SINGLE: '{tag_relativ}: {titel} — {datumsbereich}{?termin_zeit} um {termin_zeit}{/termin_zeit} ({wochentag_kurz})' },
    });
    const event = makeEvent({
      titel: 'Klassenfest',
      start: new Date('2026-09-20T16:30:00Z'),
      ende: new Date('2026-09-20T18:00:00Z'),
    });
    const group = groupReminders(buildReminders(event, eigenes))[0];

    assert.equal(
      buildGroupMessage(group, eigenes, new Date('2026-09-19T08:00:00Z')),
      'Morgen: Klassenfest — 20.09.2026 um 18:30–20:00 Uhr (So.)',
    );
  });
});
