'use strict';
/*
 * Belege lesen – komplett lokal, ohne Cloud-Dienst.
 *  - PDF mit Text:            pdftotext (Poppler)
 *  - gescanntes PDF:          pdftoppm → Tesseract (deutsch)
 *  - Foto / Bild:             Tesseract (deutsch)
 * Danach werden aus dem Text die wichtigsten Felder geschätzt.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_PAGES = 3;
const TIMEOUT = 5 * 60 * 1000;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT, maxBuffer: 20 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') { const e = new Error(`${cmd} ist nicht installiert`); e.code = 'ENOENT'; return reject(e); }
        err.stderr = String(stderr || '');
        return reject(err);
      }
      resolve(String(stdout));
    });
  });
}

async function available() {
  const out = { pdftotext: false, tesseract: false, deu: false };
  try { await run('pdftotext', ['-v']); out.pdftotext = true; } catch (e) { out.pdftotext = e.code !== 'ENOENT'; }
  try { const l = await run('tesseract', ['--list-langs']); out.tesseract = true; out.deu = /\bdeu\b/.test(l); } catch { /* fehlt */ }
  return out;
}

function isPdf(buf, mime) { return mime === 'application/pdf' || buf.slice(0, 5).toString() === '%PDF-'; }

/** Text aus einem Beleg holen. Liefert {text, method}. */
async function extractText(buf, mime, opts = {}) {
  const maxPages = opts.maxPages || MAX_PAGES, maxOcr = opts.maxOcrPages || MAX_PAGES;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-ocr-'));
  try {
    if (isPdf(buf, mime)) {
      const pdf = path.join(dir, 'in.pdf');
      fs.writeFileSync(pdf, buf);
      let text = '';
      try { text = await run('pdftotext', ['-layout', '-l', String(maxPages), pdf, '-']); } catch (e) { if (e.code === 'ENOENT') throw e; }
      if (text.replace(/\s/g, '').length >= 40) return { text, method: 'pdf-text' };
      // gescanntes PDF: Seiten als Bild rendern und erkennen
      await run('pdftoppm', ['-r', '300', '-gray', '-png', '-f', '1', '-l', String(maxOcr), pdf, path.join(dir, 'p')]);
      const pages = fs.readdirSync(dir).filter((n) => /^p-?\d+\.png$/.test(n)).sort();
      const parts = [];
      for (const p of pages) parts.push(await tesseract(path.join(dir, p)));
      return { text: parts.join('\n\f\n'), method: 'pdf-ocr' };
    }
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/tiff': '.tif', 'image/gif': '.gif' }[mime] || '.img';
    const img = path.join(dir, 'in' + ext);
    fs.writeFileSync(img, buf);
    return { text: await tesseract(img), method: 'image-ocr' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function tesseract(file) {
  try { return await run('tesseract', [file, 'stdout', '-l', 'deu+eng', '--psm', '3']); }
  catch (e) {
    if (e.code === 'ENOENT') throw e;
    return run('tesseract', [file, 'stdout', '-l', 'deu', '--psm', '3']); // falls eng fehlt
  }
}

// ---------------------------------------------------------------------------
// Feld-Erkennung (deutsche Rechnungen, Angebote, Auftragsbestätigungen)
// ---------------------------------------------------------------------------
const MONTHS = { januar: 1, jan: 1, februar: 2, feb: 2, märz: 3, maerz: 3, mär: 3, mrz: 3, april: 4, apr: 4, mai: 5, juni: 6, jun: 6, juli: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12, dez: 12 };
const pad = (n) => String(n).padStart(2, '0');
function isoDate(d, m, y) {
  y = Number(y); if (y < 100) y += 2000;
  d = Number(d); m = Number(m);
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
const DATE_RE = /(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]\s*(\d{4}|\d{2})(?!\d)|(\d{1,2})\.\s*(Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember|Jan|Feb|Mär|Mrz|Apr|Jun|Jul|Aug|Sept?|Okt|Nov|Dez)\.?\s+(\d{4})|(\d{4})-(\d{2})-(\d{2})/gi;
function datesIn(s) {
  const out = []; let m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(s))) {
    let v = null;
    if (m[1]) v = isoDate(m[1], m[2], m[3]);
    else if (m[4]) v = isoDate(m[4], MONTHS[m[5].toLowerCase().replace('.', '')], m[6]);
    else if (m[7]) v = isoDate(m[9], m[8], m[7]);
    if (v) out.push({ v, i: m.index });
  }
  return out;
}

// Beträge: 1.234,56 · 1 234,56 · 1234,56 · 1.234,- · 1234.56 (selten)
const AMOUNT_RE = /(?<![\d,.])(-?\d{1,3}(?:[.\s'’]\d{3})+|-?\d+)(?:,(\d{2}|-{1,2}))(?![\d])|(?<![\d,.])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?![\d.,])/g;
function amountsIn(s) {
  const out = []; let m;
  AMOUNT_RE.lastIndex = 0;
  while ((m = AMOUNT_RE.exec(s))) {
    let n;
    if (m[1] !== undefined) {
      const cents = m[2] && /^\d{2}$/.test(m[2]) ? m[2] : '00';
      n = Number(m[1].replace(/[.\s'’]/g, '') + '.' + cents);
    } else n = Number(m[3].replace(/,/g, '') + '.' + m[4]);
    if (Number.isFinite(n) && Math.abs(n) >= 1 && Math.abs(n) < 1e8) out.push({ n, i: m.index });
  }
  return out;
}

const TOTAL_KEYS = [
  [/zahlbetrag|zu\s*zahlender\s*betrag|zu\s*zahlen|offener\s*betrag|rechnungsbetrag|endbetrag|gesamtbetrag\s*(?:brutto|inkl)|gesamtsumme\s*(?:brutto|inkl)/i, 10],
  [/gesamt\s*brutto|brutto\s*gesamt|bruttobetrag|summe\s*brutto|brutto\s*summe|angebotssumme|auftragssumme|gesamtpreis/i, 9],
  [/gesamtbetrag|gesamtsumme|endsumme|total|betrag\s*inkl|inkl\.?\s*(?:\d{1,2}\s*%\s*)?(?:mwst|ust)/i, 7],
  [/\bsumme\b|\bbetrag\b|\bbrutto\b/i, 4],
];
const NOT_TOTAL = /netto|zwischensumme|mwst\.?\s*\d|ust\.?\s*\d|umsatzsteuer\s*\d|mehrwertsteuer\s*\d|steuer\s*\d|rabatt|skonto|abschlag\s*bereits|bereits\s*(?:gezahlt|bezahlt)|anzahlung\s*erhalten|stückpreis|einzelpreis|e-?preis|menge/i;

function findTotal(lines) {
  let best = null;
  lines.forEach((line, idx) => {
    for (const [re, w] of TOTAL_KEYS) {
      if (!re.test(line)) continue;
      if (NOT_TOTAL.test(line) && w < 9) continue;
      let cands = amountsIn(line.slice(line.search(re)));
      if (!cands.length && lines[idx + 1]) cands = amountsIn(lines[idx + 1]);
      if (!cands.length) continue;
      const n = cands[cands.length - 1].n;
      const score = w + idx / lines.length; // weiter unten = eher Endsumme
      if (!best || score > best.score || (Math.abs(score - best.score) < 0.5 && n > best.n)) best = { n, score, line: line.trim() };
      break;
    }
  });
  if (best) return { value: Math.abs(best.n), confidence: best.score >= 9 ? 'hoch' : 'mittel', source: best.line };
  const all = lines.flatMap((l) => (/€|eur/i.test(l) ? amountsIn(l) : []));
  if (all.length) {
    const max = all.reduce((a, b) => (Math.abs(b.n) > Math.abs(a.n) ? b : a));
    return { value: Math.abs(max.n), confidence: 'niedrig', source: 'größter €-Betrag' };
  }
  return null;
}

function findDate(lines, keyRe) {
  for (const l of lines) {
    if (!keyRe.test(l)) continue;
    const after = l.slice(l.search(keyRe));
    const d = datesIn(after);
    if (d.length) return d[0].v;
  }
  return null;
}

const COMPANY_RE = /\b(GmbH|AG|KG|OHG|GbR|UG|e\.\s?K\.|e\.\s?V\.|mbH|Ltd\.?|SE|Co\.\s*KG|Ingenieurbüro|Ingenieure|Architekt|Vermessung|Notar|Rechtsanw|Stadtwerke|Netz|Gemeinde|Stadt\s+\w+|Kreis|Landkreis|Amt\b|Verband|Bank|Sparkasse|Versicherung|Handwerk|Elektro|Sanitär|Heizung|Bau\w*|Küchen?|Tischlerei|Schreinerei|Dach\w*|Garten\w*|Malerbetrieb|Fliesen\w*)\b/i;
const NOT_VENDOR = /rechnung|angebot|datum|seite|kunde|kd\.?-?nr|tel|fax|e-?mail|www\.|ust|steuer|iban|bic|bankverbindung|an\s|herrn?|frau\b|familie|lieferadresse|bauvorhaben|betreff|^\d|straße|str\.|weg\b|platz\b|allee\b/i;

function findVendor(lines, text) {
  const head = lines.slice(0, 25);
  // 1. Zeile mit Rechtsform/Branche im Kopf
  for (const l of head) {
    const t = l.trim().replace(/\s{2,}.*/, ''); // bei Layout-Text nur die linke Spalte
    if (t.length >= 3 && t.length <= 70 && COMPANY_RE.test(t) && !/rechnung an|empfänger/i.test(t)) {
      const m = t.match(/^[^·|•]+/); return m ? m[0].trim().replace(/[,;:]$/, '') : t;
    }
  }
  // 2. Absenderzeile im Fensterumschlag: „Firma · Straße · PLZ Ort“
  const sender = head.find((l) => /[·|•]/.test(l) && /\b\d{5}\b/.test(l));
  if (sender) return sender.split(/[·|•]/)[0].trim();
  // 3. aus E-Mail- oder Web-Domain
  const dm = text.match(/(?:@|www\.)([a-z0-9-]{3,})\.(?:de|com|eu|net|info|at|ch)\b/i);
  if (dm) return dm[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  // 4. erste plausible Zeile
  const first = head.map((l) => l.trim()).find((l) => l.length >= 3 && l.length <= 60 && /[A-Za-zÄÖÜäöü]{3}/.test(l) && !NOT_VENDOR.test(l));
  return first || null;
}

function findDocNumber(text) {
  const m = text.match(/(Rechnung|Angebot|Auftrag|Beleg|Gutschrift|Abschlag)s?\s*-?\s*(?:nr|nummer|no)\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/._]{2,24})/i)
    || text.match(/\b(?:Nr|No)\.?\s*[:#]\s*([A-Z0-9][A-Z0-9\-/._]{2,24})/i);
  return m ? m[m.length - 1] : null;
}

function findType(text) {
  const t = text.slice(0, 3000);
  if (/schlussrechnung/i.test(t)) return 'rechnung';
  if (/abschlags(?:zahlungs)?rechnung|teilrechnung|zahlungsaufforderung|abschlagszahlung/i.test(t)) return 'rechnung';
  if (/\brechnung\b|\binvoice\b|\bquittung\b|\bbeitragsbescheid|\bgebührenbescheid|\bbescheid\b|kostenrechnung|kostennote/i.test(t)) return 'rechnung';
  if (/auftragsbestätigung|auftragsbestaetigung|bestellbestätigung/i.test(t)) return 'auftrag';
  if (/\bangebot\b|kostenvoranschlag|kostenschätzung|\bofferte\b|preisangebot/i.test(t)) return 'angebot';
  if (/kassenbon|\bbon\b|rückgeld|rueckgeld|\bbar\b|kartenzahlung|ec-?karte|girocard|visa|mastercard|gegeben/i.test(t)) return 'quittung';
  return null;
}

function findSubject(lines, type) {
  for (const l of lines.slice(0, 60)) {
    const m = l.match(/^\s*(?:betreff|betr\.|leistung|gegenstand|bauvorhaben|projekt|für|über)\s*[:\-–]?\s*(.{4,90})$/i);
    if (m && !/^\d+$/.test(m[1].trim())) return m[1].trim().replace(/\s{2,}.*/, '');
  }
  // erste Zeile nach dem Wort Rechnung/Angebot, die nach Leistung klingt
  const idx = lines.findIndex((l) => /\b(rechnung|angebot|auftragsbestätigung)\b/i.test(l));
  if (idx >= 0) {
    for (const l of lines.slice(idx + 1, idx + 8)) {
      const t = l.trim().replace(/\s{2,}.*/, '');
      if (t.length >= 6 && t.length <= 80 && /[a-zäöü]{4}/i.test(t) && !NOT_VENDOR.test(t) && !amountsIn(t).length && !datesIn(t).length) return t;
    }
  }
  return null;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Aus dem erkannten Text die Felder einer Kostenposition schätzen. */
function parseDocument(rawText) {
  const text = String(rawText || '').replace(/\r/g, '').replace(/\f/g, '\n');
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const type = findType(text);
  const total = findTotal(lines);
  const date = findDate(lines, /(rechnungs|angebots|beleg|auftrags|leistungs)?datum|\bdatum\b|\bvom\b|ausgestellt/i)
    || (datesIn(lines.slice(0, 30).join('\n'))[0] || {}).v || null;
  let due = findDate(lines, /zahlbar\s*bis|fällig\s*(?:am|bis|zum)?|faellig|zahlung\s*bis|spätestens|bis\s*zum|zahlungsziel/i);
  if (!due && date) {
    const m = text.match(/(?:innerhalb|binnen|zahlungsziel)[^\d\n]{0,25}(\d{1,3})\s*(?:kalender|werk)?tag/i) || text.match(/(\d{1,3})\s*tage\s*(?:netto|ohne\s*abzug|nach\s*rechnungs)/i);
    if (m && Number(m[1]) <= 120) due = addDays(date, Number(m[1]));
  }
  if (due && date && due < date) due = null;
  const vendor = findVendor(lines, text);
  const number = findDocNumber(text);
  const subject = findSubject(lines, type);
  const typeLabel = { rechnung: 'Rechnung', angebot: 'Angebot', auftrag: 'Auftrag', quittung: 'Kassenbon' }[type] || 'Beleg';
  const title = subject || (vendor ? `${typeLabel} ${vendor}` : null);
  const status = type === 'angebot' ? 'angebot' : type === 'quittung' ? 'bezahlt' : type === 'rechnung' || type === 'auftrag' ? 'beauftragt' : null;
  const noteParts = [];
  const nrLabel = { rechnung: 'Rechnungsnr.', angebot: 'Angebotsnr.', auftrag: 'Auftragsnr.', quittung: 'Bon-Nr.' }[type] || 'Belegnr.';
  if (number) noteParts.push(`${nrLabel} ${number}`);
  return {
    type, status, amount: total ? total.value : null, amount_confidence: total ? total.confidence : null, amount_source: total ? total.source : null,
    date, due: status === 'angebot' || status === 'bezahlt' ? null : due, vendor, number, title, note: noteParts.join(' · '),
  };
}

// ---------------------------------------------------------------------------
// Passende vorhandene Position finden (Stichwörter aus Kostenpunkt + Hinweis)
// ---------------------------------------------------------------------------
const STOP = new Set('und oder der die das den dem des ein eine einer eines mit von für fuer zum zur bei inkl inklusive bzw sowie über ueber nach auf aus ohne pro rund kosten preis betrag angebot rechnung sofern ggf etc'.split(' '));
const norm = (s) => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
const stems = (s) => [...new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.slice(0, 7)))];

function matchPositions(parsed, text, expenses, categories, limit = 3) {
  const docStems = new Set(stems(text));
  const head = new Set(stems([parsed.title, parsed.vendor].filter(Boolean).join(' ')));
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const scored = expenses.map((e) => {
    const ws = stems(`${e.title} ${e.vendor || ''}`);
    const hs = stems(e.hint || '');
    let score = 0; const hits = [];
    ws.forEach((w) => { if (head.has(w)) { score += 3; hits.push(w); } else if (docStems.has(w)) { score += 2; hits.push(w); } });
    hs.forEach((w) => { if (docStems.has(w)) score += 0.5; });
    if (e.vendor && parsed.vendor && norm(e.vendor).slice(0, 6) === norm(parsed.vendor).slice(0, 6)) score += 4;
    if (parsed.amount && e.estimate && Math.abs(e.estimate - parsed.amount) / Math.max(e.estimate, 1) < 0.15) score += 1;
    if (ws.length) score = score / Math.sqrt(ws.length);
    return { id: e.id, code: e.code, title: e.title, category: catName.get(e.category_id) || '', score: Math.round(score * 100) / 100, hits };
  }).filter((x) => x.score >= 1.2).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

module.exports = { available, extractText, parseDocument, matchPositions, _internal: { amountsIn, datesIn, findTotal } };
