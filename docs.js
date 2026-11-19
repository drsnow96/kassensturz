'use strict';
/*
 * Bau- und Leistungsbeschreibungen / Angebote prüfen.
 * Für jede Kostenposition werden passende Textstellen gesucht und eingeordnet:
 *   enthalten · nicht enthalten · unklar · nicht erwähnt
 * Zusätzlich werden „Kostenfallen“ gesammelt: Sätze mit bauseits, Eigenleistung,
 * gegen Aufpreis, nicht enthalten … die zu keiner Position passen.
 * Reine Heuristik – Ergebnis ist ein Vorschlag mit Fundstelle, keine Rechtsauskunft.
 */

const norm = (s) => String(s || '').toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
const STOP = new Set(('und oder der die das den dem des ein eine einer eines einem mit von fuer zum zur bei inkl inklusive bzw sowie ueber nach auf aus ohne '
  + 'pro rund kosten preis betrag angebot rechnung sofern ggf etc alle allen werden wird sind ist nicht kein keine auch dass dies diese dieser '
  + 'haus hauses gebaeude gebaeudes leistung leistungen ausfuehrung inkl standard laut durch einen einem eines unter muss kann soll vom beim '
  + 'hauspreis festpreis leistungsumfang lieferumfang bauherr bauherrn bauherren bauseits enthalten inklusive erfolgt erfolgen sowie '
  + 'jeweils ggfs moeglich bitte gemaess nach entsprechend').split(' '));
const words = (s) => [...new Set(tokens(s))];
// Kurze Fachbegriffe behalten, gängige Abkürzungen ausschreiben
const SHORT = new Set(['knx', 'wc', 'kfw', 'led', 'usv', 'dsl', 'tv', 'sat', 'fbh']);
const SYN = { pv: ['photovoltaik'], wp: ['waermepumpe'], kwl: ['lueftung', 'wohnraumlueftung'], fbh: ['fussbodenheizung'], ww: ['warmwasser'] };
const tokens = (s) => norm(s).split(/[^a-z0-9]+/).flatMap((w) => (SYN[w] ? [w, ...SYN[w]] : [w]))
  .filter((w) => (w.length >= 4 || SHORT.has(w)) && !STOP.has(w));
const stems = (s) => [...new Set(tokens(s).map((w) => w.slice(0, 7)))];

// Hinweise, dass etwas NICHT im Preis ist (haben Vorrang)
const NEG = [
  /nicht\s+(?:im\s+(?:leistungsumfang|preis|festpreis|angebot)\s+)?(?:enthalten|inbegriffen|eingeschlossen|bestandteil)/i,
  /nicht\s+im\s+(?:leistungsumfang|lieferumfang|festpreis|hauspreis|kaufpreis)/i,
  /\bbauseit(?:s|ig)\b/i, /\beigenleistung\b/i, /durch\s+den\s+bauherr/i, /vom\s+bauherr/i, /(?:obliegt|übernimmt|uebernimmt)\s+(?:dem|der)\s+bauherr/i,
  /\bgegen\s+(?:aufpreis|mehrpreis|berechnung)\b/i, /\bmehrpreis\b/i, /\baufpreis\b/i, /\bsonderwunsch\b/i, /\bzusatzleistung\b/i,
  /\bentf(?:ä|ae)llt\b/i, /\bexklusive?\b/i, /\bausgenommen\b/i, /\bnicht\s+vorgesehen\b/i, /\bseparat\s+(?:zu\s+)?(?:beauftragen|berechnet|vergütet)\b/i,
  /\bzus(?:ä|ae)tzlich\s+(?:zu\s+)?(?:beauftragen|berechnet|bezahlen)\b/i, /\bwahlweise\s+gegen\b/i, /\boptional\b/i, /\bnach\s+aufwand\b/i,
];
// Hinweise, dass etwas im Preis IST
const POS = [
  /\b(?:im\s+(?:leistungsumfang|lieferumfang|festpreis|hauspreis|preis))\s+(?:enthalten|inbegriffen)/i,
  /\b(?:sind|ist|wird|werden)\s+(?:im\s+\w+\s+)?(?:enthalten|inbegriffen|eingeschlossen|mitgeliefert|ausgeführt|ausgefuehrt|eingebaut|montiert|geliefert|erstellt|hergestellt)\b/i,
  /\benthalten\b/i, /\binklusive\b/i, /\binkl\.?\s/i, /\blieferung\s+und\s+montage\b/i, /\bbestandteil\s+(?:des|der)\b/i,
  /\bwir\s+(?:liefern|montieren|übernehmen|uebernehmen|erstellen)\b/i, /\bim\s+lieferumfang\b/i, /\bserienm(?:ä|ae)(?:ss|ß)ig\b/i,
];
const isNeg = (t) => NEG.some((re) => re.test(t));
// Verneinte Formulierungen („nicht im Preis enthalten“) zählen nicht als „enthalten“
const NEG_PHRASE = /(?:nicht|kein(?:e|en)?)\s+(?:\S+\s+){0,4}?(?:enthalten|inbegriffen|eingeschlossen|bestandteil|vorgesehen|inklusive)/gi;
const isPos = (t) => { const rest = String(t).replace(NEG_PHRASE, ' '); return POS.some((re) => re.test(rest)); };

/** Text in Sätze mit Seitenzahl zerlegen (pdftotext trennt Seiten mit \f) */
function segments(text) {
  const out = [];
  String(text || '').split('\f').forEach((page, pi) => {
    // Silbentrennung am Zeilenende zusammenführen, Zeilen zu Absätzen
    const clean = page.replace(/(\w)-\n\s*(\w)/g, '$1$2').replace(/[ \t]+/g, ' ');
    const paras = clean.split(/\n\s*\n/);
    for (const para of paras) {
      const joined = para.replace(/\n/g, ' ').trim();
      if (!joined) continue;
      // in Sätze bzw. Aufzählungspunkte teilen
      // Abkürzungen schützen, damit „inkl.“ oder „z. B.“ keinen Satz beendet
      const guarded = joined.replace(/\b(inkl|ggf|ggfs|bzw|ca|zzgl|evtl|etc|Nr|Pos|Str|max|min|mind|lt|gem|bspw|usw|u\.a|z\.\s?B|d\.\s?h|o\.\s?ä)\./gi, '$1\u2024');
      guarded.split(/(?<=[.!?;])\s+(?=[A-ZÄÖÜ•\-–\d])|\s+(?=[•▪◦]\s)/).forEach((sent) => {
        const t = sent.replace(/\u2024/g, '.').trim();
        if (t.length >= 12 && t.length <= 900) out.push({ page: pi + 1, text: t, stems: new Set(stems(t)), words: new Set(words(t)) });
      });
    }
  });
  return out;
}

function snippetOf(t) { return t.length > 320 ? t.slice(0, 317) + '…' : t; }

/**
 * Ein Dokument gegen alle Positionen prüfen.
 * expenses: [{id, title, hint, code}] · Rückgabe: {byExpense: {id: {verdict, page, snippet, score, more}}, traps: [...]}
 */
function analyze(text, expenses) {
  const segs = segments(text);
  const used = new Set();
  const byExpense = {};
  for (const e of expenses) {
    const key = stems(e.title);
    const full = words(e.title);
    const keyHint = stems(e.hint || '').filter((w) => !key.includes(w));
    if (!key.length) continue;
    const scored = [];
    segs.forEach((sg, idx) => {
      let hit = 0; const hits = [];
      key.forEach((w) => { if (sg.stems.has(w)) { hit += 1; hits.push(w); } });
      // Wortteile in zusammengesetzten Wörtern („Anlage“ in „Photovoltaikanlage“)
      full.forEach((w) => {
        if (w.length < 5 || hits.includes(w.slice(0, 7))) return;
        for (const dw of sg.words) if (dw !== w && dw.length > w.length && dw.includes(w)) { hit += 1; hits.push(w.slice(0, 7)); break; }
      });
      if (!hit) return;
      let exact = 0; full.forEach((w) => { if (sg.words.has(w)) exact += 1; });
      let score = (hit + 0.5 * exact) / Math.sqrt(Math.min(key.length, 3));
      keyHint.forEach((w) => { if (sg.stems.has(w)) score += 0.15; });
      // ein einzelnes kurzes Allerweltswort reicht nicht
      if (hit === 1 && key.length > 1 && hits[0].length < 6 && !SHORT.has(hits[0])) score *= 0.6;
      scored.push({ idx, score, hits });
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored.filter((x) => x.score >= 0.75).slice(0, 3);
    if (!best.length) { byExpense[e.id] = { verdict: 'fehlt' }; continue; }
    // Urteil: Satz selbst, sonst Nachbarsatz
    let verdict = 'unklar'; let pick = best[0];
    for (const b of best) {
      const t = segs[b.idx].text;
      const near = [segs[b.idx - 1], segs[b.idx + 1]].filter(Boolean).map((x) => x.text).join(' ');
      if (isNeg(t) && isPos(t)) { verdict = 'teils'; pick = b; break; }
      if (isNeg(t)) { verdict = 'nein'; pick = b; break; }
      if (isPos(t)) { if (verdict !== 'ja') { verdict = 'ja'; pick = b; } continue; }
      if (verdict === 'unklar' && isNeg(near) && b === best[0]) { verdict = 'nein?'; pick = b; }
    }
    if (verdict === 'unklar' && best[0].score >= 1) verdict = 'erwaehnt';
    best.forEach((b) => used.add(b.idx));
    byExpense[e.id] = {
      verdict, page: segs[pick.idx].page, snippet: snippetOf(segs[pick.idx].text), score: Math.round(pick.score * 100) / 100,
      more: best.filter((b) => b !== pick).map((b) => ({ page: segs[b.idx].page, snippet: snippetOf(segs[b.idx].text) })),
    };
  }
  // Kostenfallen: „nicht enthalten / bauseits …“, die keiner Position zugeordnet sind
  const traps = [];
  const seen = new Set();
  segs.forEach((sg, idx) => {
    if (used.has(idx) || !isNeg(sg.text)) return;
    const k = norm(sg.text).slice(0, 80);
    if (seen.has(k)) return; seen.add(k);
    traps.push({ page: sg.page, snippet: snippetOf(sg.text) });
  });
  return { byExpense, traps: traps.slice(0, 80), segments: segs.length };
}

/** Vorschlag für „Im Hauspreis?“ aus dem Urteil */
function suggestion(verdict) {
  return { ja: 'ja', nein: 'nein', 'nein?': 'nein', teils: 'pruefen', erwaehnt: 'pruefen', unklar: 'pruefen', fehlt: 'nein' }[verdict] || null;
}

module.exports = { analyze, suggestion, segments, _internal: { isNeg, isPos, stems } };
