'use strict';
// Leistungsbeschreibung prüfen (erfundener Text)
const { test } = require('node:test');
const assert = require('node:assert');
const docs = require('../docs');

const text = `Baustelle
Die Baustelleneinrichtung inkl. Kran und Gerüst ist im Festpreis enthalten. Die Bodenplatte ist nicht im Leistungsumfang enthalten und bauseits zu erstellen.
Vermessung und Absteckung erfolgen bauseits.\fTechnik
Die Lüftungsanlage mit Wärmerückgewinnung ist enthalten. Eine KNX-Installation ist gegen Mehrpreis erhältlich.
Die Absteckung ist inklusive, die Gebäudeeinmessung erfolgt bauseits. Malerarbeiten sind Eigenleistung des Bauherrn.`;

test('enthalten / nicht enthalten / teilweise mit Seitenzahl, Kostenfallen', () => {
  const exps = [
    { id: 1, title: 'Bodenplatte inkl. Randdämmung' },
    { id: 2, title: 'Kontrollierte Wohnraumlüftung mit Wärmerückgewinnung' },
    { id: 3, title: 'Baustelleneinrichtung: Kran, Gerüst' },
    { id: 4, title: 'Notar und Grundbuch' },
  ];
  const a = docs.analyze(text, exps);
  assert.equal(a.byExpense[1].verdict, 'nein');
  assert.equal(a.byExpense[1].page, 1);
  assert.equal(a.byExpense[2].verdict, 'ja');
  assert.equal(a.byExpense[2].page, 2);
  assert.equal(a.byExpense[3].verdict, 'ja');
  assert.equal(a.byExpense[4].verdict, 'fehlt');
  assert.ok(a.traps.some((t) => /Malerarbeiten/.test(t.snippet)), 'Eigenleistung als Kostenfalle');
  assert.ok(a.traps.some((t) => /KNX/.test(t.snippet)));
});

test('„nicht … enthalten“ zählt nicht als enthalten, Abkürzungen trennen keine Sätze', () => {
  assert.equal(docs._internal.isPos('Die Küche ist nicht im Hauspreis enthalten.'), false);
  assert.equal(docs._internal.isNeg('Die Küche ist nicht im Hauspreis enthalten.'), true);
  const segs = docs.segments('Die Treppe aus Buche inkl. Geländer wird montiert. Zweiter Satz folgt hier.');
  assert.equal(segs.length, 2);
});
