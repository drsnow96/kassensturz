'use strict';
/*
 * Rechnungen aus einem E-Mail-Postfach abholen – minimaler IMAP-Client und
 * MIME-Parser ohne externe Abhängigkeiten.
 *  - IMAP über TLS (Port 993) oder unverschlüsselt (nur im lokalen Netz)
 *  - liest ungelesene Nachrichten eines Ordners, holt PDF- und Bild-Anhänge
 *    (auch aus weitergeleiteten Mails als Anhang), markiert sie danach als gelesen
 *    oder verschiebt sie in einen Erledigt-Ordner
 */
const tls = require('node:tls');
const net = require('node:net');

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------
class Imap {
  constructor({ host, port = 993, secure = true, timeout = 30000 }) {
    Object.assign(this, { host, port: Number(port) || (secure ? 993 : 143), secure, timeout });
    this.buf = Buffer.alloc(0); this.tagNo = 0; this.waiters = []; this.caps = '';
  }

  connect() {
    return new Promise((resolve, reject) => {
      const onErr = (e) => reject(friendly(e));
      const opts = { host: this.host, port: this.port, servername: this.host };
      this.sock = this.secure ? tls.connect(opts) : net.connect(opts);
      this.sock.setTimeout(this.timeout, () => this.sock.destroy(new Error('Zeitüberschreitung bei der Verbindung zum Mailserver')));
      this.sock.once('error', onErr);
      this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
      this.sock.on('close', () => { this.closed = true; this.pump(); });
      this.greeting = { resolve: (lines) => { this.sock.off('error', onErr); this.sock.on('error', () => {}); resolve(lines); }, reject };
    });
  }

  /** Antwortzeilen inkl. Literalen ({n}) aus dem Puffer schneiden */
  readItem() {
    let pos = 0; const parts = []; const literals = [];
    for (;;) {
      const nl = this.buf.indexOf('\r\n', pos);
      if (nl < 0) return null;
      const line = this.buf.slice(pos, nl).toString('latin1');
      const m = line.match(/\{(\d+)\}$/);
      if (m) {
        const n = Number(m[1]);
        if (this.buf.length < nl + 2 + n) return null;
        parts.push(line);
        literals.push(this.buf.slice(nl + 2, nl + 2 + n));
        pos = nl + 2 + n;
        continue;
      }
      parts.push(line);
      this.buf = this.buf.slice(nl + 2);
      return { line: parts.join(''), literals };
    }
  }

  pump() {
    let item;
    while ((item = this.readItem())) {
      if (this.greeting) {
        const g = this.greeting; this.greeting = null;
        if (/^\* (OK|PREAUTH)/i.test(item.line)) { const c = item.line.match(/\[CAPABILITY ([^\]]+)\]/i); if (c) this.caps = c[1]; g.resolve(item); }
        else g.reject(new Error('Mailserver verweigert die Verbindung: ' + item.line));
        continue;
      }
      const w = this.waiters[0];
      if (!w) continue;
      if (item.line.startsWith(w.tag + ' ')) {
        this.waiters.shift();
        const ok = /^\S+ OK/i.test(item.line);
        if (ok) w.resolve({ untagged: w.untagged, status: item.line });
        else { const e = new Error(item.line.replace(/^\S+\s+/, '')); e.imap = true; w.reject(e); }
      } else w.untagged.push(item);
    }
    if (this.closed) {
      if (this.greeting) { this.greeting.reject(new Error('Verbindung vom Mailserver getrennt')); this.greeting = null; }
      while (this.waiters.length) this.waiters.shift().reject(new Error('Verbindung vom Mailserver getrennt'));
    }
  }

  cmd(text) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Verbindung geschlossen'));
      const tag = 'K' + String(++this.tagNo).padStart(4, '0');
      this.waiters.push({ tag, resolve, reject, untagged: [] });
      this.sock.write(`${tag} ${text}\r\n`);
    });
  }

  async login(user, pass) {
    try { await this.cmd(`LOGIN ${q(user)} ${q(pass)}`); }
    catch (e) { throw new Error(e.imap ? 'Anmeldung fehlgeschlagen – Benutzername oder Passwort prüfen (bei Gmail/GMX/Web.de ggf. App-Passwort und IMAP in den Postfach-Einstellungen aktivieren)' : e.message); }
    const c = await this.cmd('CAPABILITY');
    const line = c.untagged.find((x) => /^\* CAPABILITY/i.test(x.line));
    if (line) this.caps = line.line.slice(13);
  }

  async select(folder) {
    try { return await this.cmd(`SELECT ${q(folder)}`); }
    catch (e) { throw new Error(`Ordner „${folder}“ nicht gefunden`); }
  }

  async searchUnseen() {
    const r = await this.cmd('UID SEARCH UNSEEN');
    const line = r.untagged.find((x) => /^\* SEARCH/i.test(x.line));
    return line ? line.line.slice(8).trim().split(/\s+/).filter(Boolean).map(Number) : [];
  }

  async fetch(uid) {
    const r = await this.cmd(`UID FETCH ${uid} (BODY.PEEK[])`);
    const it = r.untagged.find((x) => x.literals.length);
    return it ? it.literals[0] : null;
  }

  async done(uid, doneFolder) {
    if (doneFolder) {
      try { await this.cmd(`CREATE ${q(doneFolder)}`); } catch { /* existiert schon */ }
      if (/\bMOVE\b/i.test(this.caps)) { await this.cmd(`UID MOVE ${uid} ${q(doneFolder)}`); return; }
      await this.cmd(`UID COPY ${uid} ${q(doneFolder)}`);
      await this.cmd(`UID STORE ${uid} +FLAGS.SILENT (\\Seen \\Deleted)`);
      try { await this.cmd(`UID EXPUNGE ${uid}`); } catch { await this.cmd('EXPUNGE'); }
      return;
    }
    await this.cmd(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`);
  }

  async logout() {
    try { await this.cmd('LOGOUT'); } catch { /* egal */ }
    try { this.sock.end(); } catch { /* egal */ }
  }
}

function q(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function friendly(e) {
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return new Error('Mailserver nicht gefunden – Servername prüfen');
  if (e.code === 'ECONNREFUSED') return new Error('Mailserver lehnt die Verbindung ab – Port prüfen');
  if (/certificate|self.signed|CERT_/i.test(e.message || '')) return new Error('TLS-Zertifikat des Mailservers ungültig');
  if (/wrong version number|packet length/i.test(e.message || '')) return new Error('TLS passt nicht zum Port – bei Port 993 „SSL/TLS“, bei 143 „unverschlüsselt“ wählen');
  return e;
}

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------
function decodeBytes(buf, charset) {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(cs === 'latin1' ? 'iso-8859-1' : cs).decode(buf); } catch { return buf.toString('utf8'); }
}
function decodeQP(str) {
  const s = str.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}
/** =?utf-8?B?...?= und =?iso-8859-1?Q?...?= in Kopfzeilen */
function decodeWords(v) {
  return String(v || '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, cs, enc, data) => {
    const buf = enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : decodeQP(data.replace(/_/g, ' '));
    return decodeBytes(buf, cs);
  });
}
function parseHeaders(raw) {
  const h = {};
  raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':'); if (i <= 0) return;
    const k = line.slice(0, i).trim().toLowerCase(); const v = line.slice(i + 1).trim();
    if (!(k in h)) h[k] = v;
  });
  return h;
}
function param(header, name) {
  const s = String(header || '');
  // RFC 2231: name*=UTF-8''…  bzw. name*0*=…
  const ext = [...s.matchAll(new RegExp(`${name}\\*(\\d+)?\\*?=\\s*("?)([^";]*)\\2`, 'gi'))];
  if (ext.length) {
    let v = ext.map((m) => m[3]).join('');
    const m = v.match(/^([^']*)'[^']*'(.*)$/);
    if (m) { try { return decodeBytes(Buffer.from(m[2].replace(/%([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1'), m[1] || 'utf-8'); } catch { v = m[2]; } }
    return v;
  }
  const m = s.match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i'));
  return m ? decodeWords(m[2] !== undefined ? m[2] : m[1]) : '';
}

const WANT = /^(application\/pdf|image\/(?:png|jpe?g|webp|tiff|gif|heic|heif))$/i;
const EXT_MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic' };

/** Nachricht (Buffer) → {from, subject, date, messageId, attachments:[{filename, mime, data}]} */
function parseMessage(buf, depth = 0) {
  const s = buf.toString('latin1');
  const sep = s.search(/\r?\n\r?\n/);
  const headRaw = sep >= 0 ? s.slice(0, sep) : s;
  const body = sep >= 0 ? s.slice(sep).replace(/^\r?\n\r?\n/, '') : '';
  const h = parseHeaders(headRaw);
  const msg = {
    from: decodeWords(h.from || ''), subject: decodeWords(h.subject || ''), date: h.date || '', messageId: (h['message-id'] || '').trim(),
    attachments: [],
  };
  walk(h, body, msg, depth);
  return msg;
}

function walk(h, body, msg, depth) {
  const ct = h['content-type'] || 'text/plain';
  const type = ct.split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    const boundary = param(ct, 'boundary');
    if (!boundary) return;
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    for (const part of parts.slice(1)) {
      if (!part.trim()) continue;
      const sep = part.search(/\r?\n\r?\n/);
      if (sep < 0) continue;
      walk(parseHeaders(part.slice(0, sep)), part.slice(sep).replace(/^\r?\n\r?\n/, ''), msg, depth);
    }
    return;
  }
  const enc = (h['content-transfer-encoding'] || '').toLowerCase().trim();
  const data = () => (enc === 'base64' ? Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64') : enc === 'quoted-printable' ? decodeQP(body) : Buffer.from(body, 'latin1'));
  if (type === 'message/rfc822' && depth < 3) {
    const inner = parseMessage(data(), depth + 1);
    msg.attachments.push(...inner.attachments);
    if (!msg.forwardedFrom && inner.from) msg.forwardedFrom = inner.from;
    return;
  }
  let filename = param(h['content-disposition'], 'filename') || param(ct, 'name');
  let mime = type;
  const ext = (filename.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  if ((mime === 'application/octet-stream' || !WANT.test(mime)) && ext && EXT_MIME[ext.toLowerCase()]) mime = EXT_MIME[ext.toLowerCase()];
  if (!WANT.test(mime)) return;
  const d = data();
  if (d.length < 200) return; // Mini-Logos u. Ä.
  // eingebettete Bildchen aus Signaturen überspringen
  if (/^image\//.test(mime) && /inline/i.test(h['content-disposition'] || '') && d.length < 30000) return;
  if (!filename) filename = `anhang.${Object.keys(EXT_MIME).find((k) => EXT_MIME[k] === mime) || 'bin'}`;
  msg.attachments.push({ filename, mime, data: d });
}

/** Absender-Adresse aus „Name <mail@x.de>“ */
const addressOf = (from) => ((String(from).match(/<([^>]+)>/) || [])[1] || String(from)).trim().toLowerCase();

/**
 * Postfach abrufen. cfg: {host, port, secure, user, pass, folder, done_folder, allowed}
 * onAttachment(att, msg) wird je Anhang aufgerufen. Rückgabe: Statistik.
 */
async function fetchInvoices(cfg, { onAttachment, isKnown, limit = 25 }) {
  const imap = new Imap({ host: cfg.host, port: cfg.port, secure: cfg.secure !== false });
  const stat = { messages: 0, attachments: 0, skipped: 0, ignoredSenders: 0 };
  await imap.connect();
  try {
    await imap.login(cfg.user, cfg.pass);
    await imap.select(cfg.folder || 'INBOX');
    const uids = (await imap.searchUnseen()).slice(0, limit);
    const allowed = String(cfg.allowed || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    for (const uid of uids) {
      const raw = await imap.fetch(uid);
      if (!raw) continue;
      const msg = parseMessage(raw);
      const sender = addressOf(msg.from);
      if (allowed.length && !allowed.some((a) => sender === a || (a.startsWith('@') && sender.endsWith(a)))) {
        stat.ignoredSenders += 1;
        await imap.cmd(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`); // nicht erneut prüfen, aber im Postfach lassen
        continue;
      }
      stat.messages += 1;
      const key = msg.messageId || `uid:${uid}:${msg.date}`;
      let i = 0;
      for (const att of msg.attachments) {
        const k = `${key}#${i++}`;
        if (isKnown && isKnown(k)) { stat.skipped += 1; continue; }
        await onAttachment(att, msg, k);
        stat.attachments += 1;
      }
      await imap.done(uid, cfg.done_folder);
    }
  } finally {
    await imap.logout();
  }
  return stat;
}

async function testConnection(cfg) {
  const imap = new Imap({ host: cfg.host, port: cfg.port, secure: cfg.secure !== false });
  await imap.connect();
  try {
    await imap.login(cfg.user, cfg.pass);
    const r = await imap.select(cfg.folder || 'INBOX');
    const ex = r.untagged.find((x) => /^\* \d+ EXISTS/i.test(x.line));
    const unseen = await imap.searchUnseen();
    return { messages: ex ? Number(ex.line.split(' ')[1]) : 0, unseen: unseen.length };
  } finally {
    await imap.logout();
  }
}

module.exports = { fetchInvoices, testConnection, parseMessage, _internal: { decodeWords, param, Imap } };
