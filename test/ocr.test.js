'use strict';
// Feld-Erkennung auf Beispieltexten (erfundene Firmen und Beträge)
const { test } = require('node:test');
const assert = require('node:assert');
const ocr = require('../ocr');

test('Rechnung mit Netto, MwSt und Zahlungsziel', () => {
  const p = ocr.parseDocument(`Elektro Beispiel GmbH
Elektro Beispiel GmbH · Am Markt 3 · 60311 Frankfurt
Rechnung
Rechnungs-Nr.: 2026-117
Datum: 05.11.2026
Leistung: Leerrohre und Hausanschlusskasten
Nettobetrag                  10.000,00 €
MwSt. 19 %                    1.900,00 €
Gesamtbetrag brutto          11.900,00 €
Zahlungsziel: 30 Tage netto`);
  assert.equal(p.type, 'rechnung');
  assert.equal(p.status, 'beauftragt');
  assert.equal(p.amount, 11900);
  assert.equal(p.date, '2026-11-05');
  assert.equal(p.due, '2026-12-05');
  assert.equal(p.vendor, 'Elektro Beispiel GmbH');
  assert.equal(p.number, '2026-117');
  assert.equal(p.title, 'Leerrohre und Hausanschlusskasten');
});

test('Angebot, ausgeschriebenes Datum, Fälligkeit wird ignoriert', () => {
  const p = ocr.parseDocument(`Gartenbau Grün KG
Angebot Nr. 4711
Langen, 3. Dezember 2026
Terrasse 35 m² inkl. Unterbau
Summe netto 10.924,37
Angebotssumme inkl. MwSt 13.000,00 EUR`);
  assert.equal(p.type, 'angebot');
  assert.equal(p.status, 'angebot');
  assert.equal(p.amount, 13000);
  assert.equal(p.date, '2026-12-03');
  assert.equal(p.due, null);
});

test('Beträge in verschiedenen Schreibweisen', () => {
  const a = (s) => ocr._internal.amountsIn(s).map((x) => x.n);
  assert.deepEqual(a('1.234,56 €'), [1234.56]);
  assert.deepEqual(a('1 234,56'), [1234.56]);
  assert.deepEqual(a('Pauschal 1.500,-'), [1500]);
  assert.deepEqual(a('Total 99.90 EUR'), [99.9]);
});

test('fällig am, Kassenbon ohne Fälligkeit', () => {
  let p = ocr.parseDocument('Gemeinde Beispielstadt\nGebührenbescheid\nBescheid vom 01.10.2026\nZu zahlender Betrag: 1.200,00 €\nfällig am 15.11.2026');
  assert.equal(p.type, 'rechnung'); assert.equal(p.amount, 1200); assert.equal(p.due, '2026-11-15');
  p = ocr.parseDocument('BAUMARKT\nSchrauben 3,49\nSUMME EUR 12,40\nBar 20,00\nRückgeld 7,60\n14.11.2026');
  assert.equal(p.status, 'bezahlt'); assert.equal(p.amount, 12.4); assert.equal(p.due, null);
});

test('passende Position wird gefunden', () => {
  const parsed = { title: 'Absteckung Gebäude', vendor: 'Vermessung Test GmbH', amount: 1800 };
  const m = ocr.matchPositions(parsed, 'Rechnung Absteckung des Gebäudes durch Vermessungsbüro', [
    { id: 1, title: 'Vermessung: Absteckung und amtliche Gebäudeeinmessung', hint: '', estimate: 4000 },
    { id: 2, title: 'Einbauküche inkl. Geräte', hint: '', estimate: 40000 },
  ], []);
  assert.equal(m[0].id, 1);
  assert.equal(m.length, 1);
});
