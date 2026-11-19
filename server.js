'use strict';
/*
 * Kassensturz – Budget & Ausgaben für den Hausbau.
 * Ein einzelner Node.js-Prozess ohne externe Abhängigkeiten:
 * HTTP-Server, JSON-API, SQLite (node:sqlite), Login, Belege, Backups.
 *
 * Alle Nutzdaten liegen in DATA_DIR (im Container: /data).
 * Der Container selbst ist zustandslos und kann bei jedem Release ersetzt werden.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const ocr = require('./ocr');
const docs = require('./docs');
const mail = require('./mail');

const VERSION = require('./package.json').version;
const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_PATH = path.join(DATA_DIR, 'kassensturz.sqlite');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const FILES_DIR = path.join(DATA_DIR, 'belege');
const KEEP_BACKUPS = Math.max(1, Number(process.env.KEEP_BACKUPS) || 10);
const SESSION_DAYS = 30;
const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 25) * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATUSES = ['geplant', 'option', 'angebot', 'beauftragt', 'bezahlt'];
const INCLUDED = ['nein', 'ja', 'pruefen'];
const SOURCE_KINDS = ['eigen', 'darlehen', 'sonstig'];

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// Datenbank, Migrationen, Backups
// ---------------------------------------------------------------------------
for (const d of [DATA_DIR, BACKUP_DIR, FILES_DIR]) fs.mkdirSync(d, { recursive: true });

const dbExisted = fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0;
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

/*
 * Migrationen werden nur angehängt, nie verändert. Jede Migration läuft genau
 * einmal (Stand in PRAGMA user_version) in einer Transaktion. Vorher wird
 * automatisch ein Backup gezogen.
 */
const MIGRATIONS = [
  // 1 – Grundschema
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    budget REAL NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE expenses (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('option','angebot','beauftragt','bezahlt')),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    vendor TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '',
    due TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at TEXT NOT NULL
  );
  CREATE INDEX idx_expenses_category ON expenses(category_id);
  CREATE INDEX idx_attachments_expense ON attachments(expense_id);

  INSERT INTO categories (name, sort) VALUES
    ('Grundstück', 10),
    ('Haus (Fertighaus-Anbieter)', 20),
    ('Bodenplatte / Keller / Erdarbeiten', 30),
    ('Baunebenkosten (Notar, Steuer, Genehmigung, Statik)', 40),
    ('Hausanschlüsse (Strom, Wasser, Gas, Telekom)', 50),
    ('Elektro & Smart Home (KNX)', 60),
    ('Haustechnik (Lüftung, Klima, PV)', 70),
    ('Küche', 80),
    ('Innenausbau (Böden, Fliesen, Maler)', 90),
    ('Kamin & Schornstein', 100),
    ('Außenanlagen (Garten, Terrasse, Zufahrt)', 110),
    ('Möbel, Leuchten & Umzug', 120),
    ('Finanzierungskosten (Bereitstellungszinsen, Gebühren)', 130),
    ('Reserve / Unvorhergesehenes', 140);

  INSERT INTO sources (name, note, sort) VALUES
    ('Eigenkapital', '', 10),
    ('KfW 297 Klimafreundlicher Neubau', 'bis 100.000 €, mit QNG bis 150.000 €', 20),
    ('Bankdarlehen (Hausbank)', 'Zins, Zinsbindung, Tilgung', 30);
  `,

  // 2 – Kostenpositionen wie in der Excel-Kostenübersicht:
  //     Nr, Schätzung, Angebot/Ist, „Im Hauspreis?“, Hinweis, Status „geplant“,
  //     Aufteilung der Zahlung je Person, Reserve-Kennzeichen je Kategorie.
  `
  CREATE TABLE expenses_new (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    estimate REAL,
    amount REAL,
    status TEXT NOT NULL CHECK (status IN ('geplant','option','angebot','beauftragt','bezahlt')),
    included TEXT NOT NULL DEFAULT 'nein' CHECK (included IN ('nein','ja','pruefen')),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    vendor TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '',
    due TEXT NOT NULL DEFAULT '',
    hint TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    split TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO expenses_new (id, title, amount, status, category_id, vendor, date, due, note, created_by, created_at, updated_by, updated_at)
    SELECT id, title, amount, status, category_id, vendor, date, due, note, created_by, created_at, updated_by, updated_at FROM expenses;
  DROP TABLE expenses;
  ALTER TABLE expenses_new RENAME TO expenses;
  CREATE INDEX idx_expenses_category ON expenses(category_id);

  ALTER TABLE categories ADD COLUMN reserve INTEGER NOT NULL DEFAULT 1;
  UPDATE categories SET reserve = 0 WHERE name LIKE 'Grundstück%' OR name LIKE 'Haus (%' OR name LIKE 'Reserve%';
  INSERT INTO meta (key, value) VALUES ('reserve_rate', '0.1') ON CONFLICT(key) DO NOTHING;
  `,

  // 3 – Darlehen: Zins, Monatsrate, erste Rate, Zinsbindung, tilgungsfreie Monate, Aufteilung der Rate
  `
  ALTER TABLE sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'eigen';
  ALTER TABLE sources ADD COLUMN interest REAL;
  ALTER TABLE sources ADD COLUMN rate REAL;
  ALTER TABLE sources ADD COLUMN start TEXT NOT NULL DEFAULT '';
  ALTER TABLE sources ADD COLUMN fixed_years INTEGER;
  ALTER TABLE sources ADD COLUMN grace_months INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sources ADD COLUMN split TEXT;
  UPDATE sources SET kind = 'darlehen' WHERE name LIKE 'KfW%' OR name LIKE '%darlehen%' OR name LIKE '%Darlehen%';
  `,

  // 4 – Gewährleistung je Position, Entscheidungen & Szenarien, Leistungsbeschreibungen, Eingang (E-Mail)
  `
  ALTER TABLE expenses ADD COLUMN warranty_start TEXT NOT NULL DEFAULT '';
  ALTER TABLE expenses ADD COLUMN warranty_months INTEGER;
  ALTER TABLE expenses ADD COLUMN warranty_note TEXT NOT NULL DEFAULT '';
  CREATE TABLE decisions (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL DEFAULT '[]',
    sort INTEGER NOT NULL DEFAULT 0,
    decided_option TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE scenarios (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    choices TEXT NOT NULL DEFAULT '{}',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    vendor TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    pages INTEGER NOT NULL DEFAULT 0,
    method TEXT NOT NULL DEFAULT '',
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at TEXT NOT NULL
  );
  CREATE TABLE inbox (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'mail',
    mail_from TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    received_at TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    scan TEXT,
    status TEXT NOT NULL DEFAULT 'neu',
    expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
    message_key TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_inbox_status ON inbox(status);
  CREATE INDEX idx_inbox_key ON inbox(message_key);
  `,
];

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function backup(reason) {
  const file = path.join(BACKUP_DIR, `kassensturz-${stamp()}-${reason}.sqlite`);
  if (fs.existsSync(file)) return file;
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  pruneBackups();
  log(`Backup erstellt: ${path.basename(file)}`);
  return file;
}

function pruneBackups() {
  const files = listBackups();
  for (const f of files.slice(KEEP_BACKUPS)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch { /* egal */ }
  }
}

function listBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter((n) => n.endsWith('.sqlite'))
    .map((n) => { const s = fs.statSync(path.join(BACKUP_DIR, n)); return { name: n, size: s.size, mtime: s.mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime);
}

function getMeta(key) {
  try { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; } catch { return null; }
}
function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  // KS_TARGET_MIGRATION nur für Tests (Datenbank auf älterem Stand erzeugen)
  const target = Math.min(MIGRATIONS.length, Number(process.env.KS_TARGET_MIGRATION) || MIGRATIONS.length);
  if (current > MIGRATIONS.length) {
    throw new Error(`Datenbank-Version ${current} ist neuer als diese App (${target}). Bitte neueres Image verwenden.`);
  }
  const lastVersion = current > 0 ? getMeta('app_version') : null;
  if (dbExisted && current > 0 && (current < target || lastVersion !== VERSION)) {
    backup(`vor-v${VERSION}`);
  }
  // Fremdschlüssel während Tabellen-Umbauten aus (geht nur außerhalb einer Transaktion)
  db.exec('PRAGMA foreign_keys = OFF');
  for (let v = current; v < target; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error('Fremdschlüssel nach Migration verletzt: ' + JSON.stringify(broken.slice(0, 3)));
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
      log(`Migration ${v + 1} angewendet`);
    } catch (e) {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
      throw e;
    }
  }
  db.exec('PRAGMA foreign_keys = ON');
  setMeta('app_version', VERSION);
}
migrate();

// tägliches Backup
function dailyBackup() {
  const today = new Date().toISOString().slice(0, 10);
  if (getMeta('last_daily_backup') === today) return;
  try { backup('taeglich'); setMeta('last_daily_backup', today); } catch (e) { log('Backup fehlgeschlagen:', e.message); }
}
dailyBackup();
setInterval(dailyBackup, 60 * 60 * 1000).unref();

// Texterkennung verfügbar? (einmal beim Start prüfen)
let ocrStatus = { pdftotext: false, tesseract: false, deu: false };
ocr.available().then((st) => { ocrStatus = st; log('Texterkennung:', JSON.stringify(st)); }).catch(() => {});

// Änderungszähler für das Polling der Clients
let rev = Date.now();
const bump = () => { rev += 1; };

// ---------------------------------------------------------------------------
// Passwörter & Sessions
// ---------------------------------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, actual);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_DAYS * 864e5);
  return token;
}
function cleanupSessions() { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); }
cleanupSessions();
setInterval(cleanupSessions, 6 * 60 * 60 * 1000).unref();

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function sessionCookie(req, token, maxAge) {
  return `ks_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}
function currentUser(req) {
  const token = parseCookies(req).ks_session;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), Date.now());
  return row || null;
}

// einfache Bremse gegen Passwort-Raten
const failed = new Map();
function clientIp(req) { return req.socket.remoteAddress || '?'; }
function loginBlocked(ip) {
  const f = failed.get(ip);
  return f && f.count >= 5 && Date.now() < f.until;
}
function loginFailed(ip) {
  const f = failed.get(ip) || { count: 0, until: 0 };
  if (Date.now() > f.until) f.count = 0;
  f.count += 1;
  f.until = Date.now() + 5 * 60 * 1000;
  failed.set(ip, f);
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen HTTP
// ---------------------------------------------------------------------------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  const payload = isBuf ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Anfrage zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try { const v = JSON.parse(buf.toString('utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* unten */ }
  throw new HttpError(400, 'Ungültiges JSON');
}

const str = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);
function amount(v, required = true) {
  if ((v === '' || v == null) && !required) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > 1e10) throw new HttpError(400, 'Ungültiger Betrag');
  return Math.round(n * 100) / 100;
}
function date(v) {
  const s = str(v, 10);
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, 'Ungültiges Datum');
  return s;
}
function idParam(v) { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Nicht gefunden'); return n; }
const nowIso = () => new Date().toISOString();

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Passwort muss mindestens 10 Zeichen haben');
  if (pw.length > 200) throw new HttpError(400, 'Passwort zu lang');
}
function validateUsername(u) {
  const s = str(u, 40);
  if (!/^[a-zA-Z0-9._-]{2,40}$/.test(s)) throw new HttpError(400, 'Benutzername: 2–40 Zeichen, nur Buchstaben, Ziffern, . _ -');
  return s;
}

// ---------------------------------------------------------------------------
// Daten lesen
// ---------------------------------------------------------------------------
function settings() {
  let split = null;
  try { split = JSON.parse(getMeta('default_split') || 'null'); } catch { split = null; }
  return {
    reserve_rate: Number(getMeta('reserve_rate') ?? 0.1),
    default_split: split && typeof split === 'object' ? split : null,
  };
}

function state(user) {
  const attachments = db.prepare('SELECT id, expense_id, filename, mime, size, uploaded_by, uploaded_at FROM attachments ORDER BY id').all();
  const byExpense = new Map();
  for (const a of attachments) {
    if (!byExpense.has(a.expense_id)) byExpense.set(a.expense_id, []);
    byExpense.get(a.expense_id).push(a);
  }
  const expenses = db.prepare('SELECT * FROM expenses ORDER BY id').all()
    .map((e) => {
      let split = null;
      try { split = e.split ? JSON.parse(e.split) : null; } catch { split = null; }
      return { ...e, split, attachments: byExpense.get(e.id) || [] };
    });
  return {
    rev,
    version: VERSION,
    me: user,
    settings: settings(),
    ocr: ocrStatus,
    users: db.prepare('SELECT id, username, display_name FROM users ORDER BY id').all(),
    categories: db.prepare('SELECT * FROM categories ORDER BY sort, id').all(),
    expenses,
    sources: db.prepare('SELECT * FROM sources ORDER BY sort, id').all().map((x) => ({ ...x, split: parseJson(x.split) })),
    decisions: db.prepare('SELECT * FROM decisions ORDER BY sort, id').all().map((d) => ({ ...d, options: parseJson(d.options) || [] })),
    scenarios: db.prepare('SELECT * FROM scenarios ORDER BY sort, id').all().map((x) => ({ ...x, choices: parseJson(x.choices) || {} })),
    documents: db.prepare('SELECT id, title, vendor, filename, mime, size, pages, method, uploaded_by, uploaded_at FROM documents ORDER BY id').all(),
    inbox: db.prepare("SELECT id, source, mail_from, subject, received_at, filename, mime, size, scan FROM inbox WHERE status = 'neu' ORDER BY id DESC LIMIT 100").all()
      .map((x) => ({ ...x, scan: parseJson(x.scan) })),
    mail: mailPublic(),
  };
}

// ---------------------------------------------------------------------------
// E-Mail-Postfach (Einstellungen in meta, Passwort nie an den Browser)
// ---------------------------------------------------------------------------
function mailConfig() { return parseJson(getMeta('mail_config')) || {}; }
function mailStatus() { return parseJson(getMeta('mail_status')) || {}; }
function mailPublic() {
  const c = mailConfig();
  return {
    enabled: !!c.enabled, host: c.host || '', port: c.port || 993, secure: c.secure !== false, user: c.user || '', has_pass: !!c.pass,
    folder: c.folder || 'INBOX', done_folder: c.done_folder ?? 'Kassensturz', allowed: c.allowed || '', interval: c.interval || 15,
    status: mailStatus(),
  };
}
let mailRunning = false;
async function runMail(trigger) {
  const c = mailConfig();
  if (!c.host || !c.user || !c.pass) throw new HttpError(400, 'Postfach ist noch nicht vollständig eingerichtet');
  if (mailRunning) throw new HttpError(409, 'Abruf läuft bereits');
  mailRunning = true;
  const st = { last_run: nowIso(), trigger };
  try {
    const stat = await mail.fetchInvoices(c, {
      isKnown: (k) => !!db.prepare('SELECT 1 FROM inbox WHERE message_key = ?').get(k),
      onAttachment: async (att, msg, key) => {
        const stored = `${crypto.randomUUID()}${path.extname(att.filename).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10)}`;
        fs.writeFileSync(path.join(FILES_DIR, stored), att.data);
        let scan = null;
        try {
          const t = await ocr.extractText(att.data, att.mime);
          const fields = ocr.parseDocument(t.text);
          const exps = db.prepare('SELECT id, code, title, hint, vendor, estimate, category_id FROM expenses').all();
          const matches = ocr.matchPositions(fields, t.text, exps, db.prepare('SELECT id, name FROM categories').all());
          const best = matches[0] && exps.find((e) => e.id === matches[0].id);
          scan = { method: t.method, text: t.text.slice(0, 8000), fields, matches, category_id: best ? best.category_id : null };
        } catch (e) { scan = { error: e.code === 'ENOENT' ? 'Texterkennung nicht installiert' : 'Konnte nicht gelesen werden' }; }
        db.prepare(`INSERT INTO inbox (source, mail_from, subject, received_at, filename, mime, size, stored_name, scan, message_key)
                    VALUES ('mail', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(str(msg.forwardedFrom || msg.from, 200), str(msg.subject, 300), nowIso(), str(path.basename(att.filename), 200) || 'anhang',
            att.mime, att.data.length, stored, JSON.stringify(scan), key);
      },
    });
    Object.assign(st, { ok: true, ...stat });
    if (stat.attachments) { log(`E-Mail: ${stat.attachments} Beleg(e) aus ${stat.messages} Nachricht(en) übernommen`); bump(); }
    return stat;
  } catch (e) {
    Object.assign(st, { ok: false, error: e.message });
    log('E-Mail-Abruf fehlgeschlagen:', e.message);
    throw e instanceof HttpError ? e : new HttpError(502, e.message);
  } finally {
    mailRunning = false;
    setMeta('mail_status', JSON.stringify(st));
  }
}
setInterval(() => {
  const c = mailConfig();
  if (!c.enabled || mailRunning) return;
  const last = Date.parse(mailStatus().last_run || 0) || 0;
  if (Date.now() - last >= (Number(c.interval) || 15) * 60000) runMail('auto').catch(() => {});
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Kalender-Abo (ICS): Fälligkeiten und Gewährleistungsfristen
// ---------------------------------------------------------------------------
function addMonthsIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
function warrantyEnd(e) {
  const start = e.warranty_start || (e.status === 'bezahlt' ? e.date : '');
  if (!start || !e.warranty_months) return null;
  return addMonthsIso(start, e.warranty_months);
}
function icsCalendar() {
  const esc = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');
  const day = (iso) => iso.replace(/-/g, '');
  const next = (iso) => addMonthsIso(iso, 0) && new Date(Date.parse(iso + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const ev = [];
  const add = (uid, date, summary, desc, alarmDays) => {
    ev.push(['BEGIN:VEVENT', `UID:${uid}@kassensturz`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day(date)}`, `DTEND;VALUE=DATE:${next(date)}`,
      `SUMMARY:${esc(summary)}`, `DESCRIPTION:${esc(desc)}`, 'TRANSP:TRANSPARENT',
      ...(alarmDays != null ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(summary)}`, `TRIGGER:-P${alarmDays}D`, 'END:VALARM'] : []),
      'END:VEVENT'].join('\r\n'));
  };
  const rows = db.prepare('SELECT * FROM expenses').all();
  for (const e of rows) {
    const label = [e.code, e.title].filter(Boolean).join(' ');
    if (e.status === 'beauftragt' && e.due) add(`due-${e.id}-${e.due}`, e.due, `💶 Fällig: ${label}`, `${e.vendor || ''} ${e.amount != null ? e.amount.toFixed(2).replace('.', ',') + ' €' : ''}`.trim(), 3);
    const end = warrantyEnd(e);
    if (end) {
      add(`gw-${e.id}-${end}`, end, `🛠 Gewährleistung endet: ${label}`, `${e.vendor || ''} ${e.warranty_note || ''}`.trim(), 14);
      const check = addMonthsIso(end, -3);
      add(`gwcheck-${e.id}-${check}`, check, `🔍 Begehung vor Gewährleistungsende: ${label}`, 'Mängel jetzt schriftlich anzeigen – Frist endet in 3 Monaten.', 7);
    }
  }
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kassensturz//Hausbau//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Kassensturz – Fristen', 'X-WR-TIMEZONE:Europe/Berlin', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', ...ev, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Entscheidungen übernehmen
// ---------------------------------------------------------------------------
function cleanOptions(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'Optionen fehlen');
  if (list.length > 12) throw new HttpError(400, 'Höchstens 12 Optionen');
  return list.map((o, i) => {
    const effects = (Array.isArray(o.effects) ? o.effects : []).slice(0, 40).map((f) => {
      const amt = amount(f.amount, true);
      if (f.type === 'set') {
        const id = Number(f.expense_id);
        if (!db.prepare('SELECT 1 FROM expenses WHERE id = ?').get(id)) throw new HttpError(400, 'Position zu einer Option nicht gefunden');
        return { type: 'set', expense_id: id, amount: amt };
      }
      const cat = f.category_id == null || f.category_id === '' ? null : Number(f.category_id);
      return { type: 'add', label: str(f.label, 120) || 'Zusatzkosten', category_id: cat, amount: amt };
    });
    return { id: str(o.id, 20) || `o${i + 1}`, label: str(o.label, 80) || `Option ${i + 1}`, note: str(o.note, 500), effects };
  });
}


function optAmount(v) {
  if (v === '' || v == null) return null;
  return amount(v);
}

/**
 * Aufteilung prüfen und normalisieren auf {mode: 'pct'|'eur', values: {userId: Zahl}}.
 * Akzeptiert auch das alte Format {userId: Prozent}. null = Standardaufteilung.
 * Bei 'eur' müssen die Beträge zusammen `total` ergeben (falls angegeben).
 */
function splitFromBody(v, total) {
  if (v == null || v === '') return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Ungültige Aufteilung');
  const mode = v.mode === 'eur' ? 'eur' : 'pct';
  const raw = v.mode ? v.values : v;
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Ungültige Aufteilung');
  const values = {}; let sum = 0;
  for (const [k, r] of Object.entries(raw)) {
    const id = Number(k); const n = Number(r);
    if (!Number.isInteger(id) || !Number.isFinite(n) || n < 0 || (mode === 'pct' && n > 100) || n > 1e10) throw new HttpError(400, 'Ungültige Aufteilung');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) continue;
    values[id] = Math.round(n * 100) / 100; sum += values[id];
  }
  if (!Object.keys(values).length) return null;
  if (mode === 'pct' && Math.abs(sum - 100) > 0.5) throw new HttpError(400, 'Die Aufteilung muss zusammen 100 % ergeben');
  if (mode === 'eur' && total != null && Math.abs(sum - total) > 0.5) {
    throw new HttpError(400, `Die Beträge ergeben ${sum.toFixed(2).replace('.', ',')} € – sie müssen zusammen ${Number(total).toFixed(2).replace('.', ',')} € ergeben`);
  }
  return { mode, values };
}
const parseJson = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };

function expenseFromBody(b) {
  const title = str(b.title, 200);
  if (!title) throw new HttpError(400, 'Bezeichnung fehlt');
  const status = STATUSES.includes(b.status) ? b.status : 'geplant';
  const included = INCLUDED.includes(b.included) ? b.included : 'nein';
  let category = b.category_id == null || b.category_id === '' ? null : Number(b.category_id);
  if (category != null && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(category)) category = null;
  const e = {
    code: str(b.code, 20), title, status, included, category,
    estimate: optAmount(b.estimate), amount: optAmount(b.amount),
    vendor: str(b.vendor, 200), date: date(b.date), due: date(b.due),
    hint: str(b.hint, 2000), note: str(b.note, 4000),
    warranty_start: date(b.warranty_start), warranty_note: str(b.warranty_note, 500),
    warranty_months: (() => {
      if (b.warranty_months === '' || b.warranty_months == null) return null;
      const n = Number(b.warranty_months);
      if (!Number.isInteger(n) || n < 0 || n > 480) throw new HttpError(400, 'Gewährleistung: Dauer in Monaten (0–480)');
      return n;
    })(),
  };
  if (e.estimate == null && e.amount == null) throw new HttpError(400, 'Bitte Schätzung oder Angebot/Ist angeben');
  e.split = splitFromBody(b.split, e.amount != null ? e.amount : e.estimate);
  return e;
}

const EXPENSE_COLS = ['code', 'title', 'estimate', 'amount', 'status', 'included', 'category_id', 'vendor', 'date', 'due', 'hint', 'note', 'split',
  'warranty_start', 'warranty_months', 'warranty_note'];
const expenseValues = (e) => [e.code, e.title, e.estimate, e.amount, e.status, e.included, e.category, e.vendor, e.date, e.due, e.hint, e.note,
  e.split ? JSON.stringify(e.split) : null, e.warranty_start || '', e.warranty_months ?? null, e.warranty_note || ''];

function insertExpense(e, userId) {
  const t = nowIso();
  const r = db.prepare(`INSERT INTO expenses (${EXPENSE_COLS.join(', ')}, created_by, created_at, updated_by, updated_at)
                        VALUES (${EXPENSE_COLS.map(() => '?').join(', ')}, ?, ?, ?, ?)`)
    .run(...expenseValues(e), userId, t, userId, t);
  return Number(r.lastInsertRowid);
}
function updateExpense(id, e, userId) {
  db.prepare(`UPDATE expenses SET ${EXPENSE_COLS.map((c) => c + ' = ?').join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`)
    .run(...expenseValues(e), userId, nowIso(), id);
}

function sendFile(res, file, mime, filename) {
  if (!fs.existsSync(file)) throw new HttpError(404, 'Datei fehlt');
  const inline = SAFE_INLINE.has(mime);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'",
    'Content-Type': inline ? mime : 'application/octet-stream',
    'Content-Length': fs.statSync(file).size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'private, no-store',
    'X-Frame-Options': 'SAMEORIGIN',
  });
  fs.createReadStream(file).pipe(res);
}

function removeAttachmentFile(stored) {
  try { fs.unlinkSync(path.join(FILES_DIR, path.basename(stored))); } catch { /* bereits weg */ }
}

const STATUS_LABEL = { geplant: 'Geplant', option: 'Option', angebot: 'Angebot', beauftragt: 'Beauftragt', bezahlt: 'Bezahlt' };
const INCLUDED_LABEL = { nein: 'Nein', ja: 'Ja', pruefen: 'Prüfen' };

function csvExport() {
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const n = (v) => (v == null ? '' : Number(v).toFixed(2).replace('.', ','));
  const d = (s) => (s && s.length === 10 ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : '');
  const rows = db.prepare(`SELECT e.*, c.name AS category_name FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
                           ORDER BY c.sort, e.code, e.id`).all();
  const lines = [['Kategorie', 'Nr', 'Kostenpunkt', 'Im Hauspreis?', 'Schätzung', 'Angebot/Ist', 'Status', 'Firma', 'Datum', 'Fällig', 'Hinweis', 'Info'].map(q).join(';')];
  for (const e of rows) {
    lines.push([e.category_name || 'Ohne Kategorie', e.code, e.title, INCLUDED_LABEL[e.included], n(e.estimate), n(e.amount),
      STATUS_LABEL[e.status], e.vendor, d(e.date), d(e.due), e.hint, e.note].map(q).join(';'));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * Import im Format {format: "kassensturz-import", version: 1, settings, categories, positions}.
 * Kategorien werden über den Namen zugeordnet, Positionen über Kategorie + Nr + Kostenpunkt
 * (erneuter Import aktualisiert statt zu verdoppeln).
 */
function importData(b, userId) {
  if (b.format !== 'kassensturz-import') throw new HttpError(400, 'Unbekanntes Dateiformat');
  const cats = Array.isArray(b.categories) ? b.categories : [];
  const pos = Array.isArray(b.positions) ? b.positions : [];
  if (pos.length > 5000 || cats.length > 200) throw new HttpError(400, 'Import zu groß');
  const result = { categories_created: 0, categories_removed: 0, positions_created: 0, positions_updated: 0 };
  db.exec('BEGIN');
  try {
    if (b.replace_empty_categories) {
      result.categories_removed = Number(db.prepare(`DELETE FROM categories WHERE id NOT IN
        (SELECT category_id FROM expenses WHERE category_id IS NOT NULL)`).run().changes);
    }
    const keyToId = new Map();
    for (const c of cats) {
      const name = str(c.name, 120);
      if (!name) continue;
      let row = db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
      if (row) {
        db.prepare('UPDATE categories SET sort = ?, reserve = ? WHERE id = ?').run(Math.trunc(Number(c.sort)) || 0, c.reserve === false ? 0 : 1, row.id);
      } else {
        const r = db.prepare('INSERT INTO categories (name, budget, sort, reserve) VALUES (?, ?, ?, ?)')
          .run(name, amount(c.budget, false), Math.trunc(Number(c.sort)) || 0, c.reserve === false ? 0 : 1);
        row = { id: Number(r.lastInsertRowid) };
        result.categories_created += 1;
      }
      keyToId.set(String(c.key ?? name), row.id);
    }
    for (const p of pos) {
      const catId = keyToId.get(String(p.category)) ?? null;
      const e = expenseFromBody({ ...p, category_id: catId, split: null });
      const existing = db.prepare('SELECT id FROM expenses WHERE code = ? AND title = ? AND category_id IS ?').get(e.code, e.title, catId);
      if (existing) { updateExpense(existing.id, e, userId); result.positions_updated += 1; }
      else { insertExpense(e, userId); result.positions_created += 1; }
    }
    if (b.settings && b.settings.reserve_rate != null) {
      const rr = Number(b.settings.reserve_rate);
      if (Number.isFinite(rr) && rr >= 0 && rr <= 1) setMeta('reserve_rate', rr);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return result;
}

function jsonExport() {
  const cats = db.prepare('SELECT * FROM categories ORDER BY sort, id').all();
  return {
    format: 'kassensturz-import', version: 1, exported_at: nowIso(), app_version: VERSION,
    settings: { reserve_rate: settings().reserve_rate },
    categories: cats.map((c) => ({ key: String(c.id), name: c.name, sort: c.sort, budget: c.budget, reserve: !!c.reserve })),
    positions: db.prepare('SELECT * FROM expenses ORDER BY id').all().map((e) => ({
      category: e.category_id == null ? null : String(e.category_id), code: e.code, title: e.title, estimate: e.estimate, amount: e.amount,
      status: e.status, included: e.included, vendor: e.vendor, date: e.date, due: e.due, hint: e.hint, note: e.note,
    })),
    sources: db.prepare('SELECT name, amount, note, kind, interest, rate, start, fixed_years, grace_months FROM sources ORDER BY sort, id').all(),
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const SAFE_INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (m !== 'GET' && m !== 'HEAD' && req.headers['x-kassensturz'] !== '1') throw new HttpError(403, 'Ungültige Anfrage');

  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  if (p === '/api/status' && m === 'GET') {
    return send(res, 200, { setupNeeded: userCount === 0, user: currentUser(req), version: VERSION });
  }

  if (p === '/api/setup' && m === 'POST') {
    if (userCount > 0) throw new HttpError(409, 'Einrichtung bereits abgeschlossen');
    const b = await readJson(req);
    const username = validateUsername(b.username);
    validatePassword(b.password);
    const display = str(b.display_name, 60) || username;
    const r = db.prepare('INSERT INTO users (username, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username, display, hashPassword(b.password), nowIso());
    const token = createSession(Number(r.lastInsertRowid));
    log(`Erster Benutzer angelegt: ${username}`);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
  }

  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) throw new HttpError(429, 'Zu viele Fehlversuche – bitte 5 Minuten warten');
    const b = await readJson(req);
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(str(b.username, 40));
    const ok = u && typeof b.password === 'string' && verifyPassword(b.password, u.pw_hash);
    if (!ok) {
      loginFailed(ip);
      await new Promise((r) => setTimeout(r, 400));
      throw new HttpError(401, 'Benutzername oder Passwort falsch');
    }
    failed.delete(ip);
    const token = createSession(u.id);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
  }

  if (p === '/api/logout' && m === 'POST') {
    const token = parseCookies(req).ks_session;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // Kalender-Abo: ohne Anmeldung, aber nur mit geheimem Token (Kalender-Apps können sich nicht anmelden)
  if (p === '/api/calendar.ics' && m === 'GET') {
    const tok = getMeta('ics_token');
    const given = String(url.searchParams.get('token') || '');
    if (!tok || given.length !== tok.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(tok))) throw new HttpError(404, 'Nicht gefunden');
    return send(res, 200, icsCalendar(), { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="kassensturz.ics"' });
  }

  // ---- ab hier nur angemeldet ----
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Bitte anmelden');

  if (p === '/api/state' && m === 'GET') return send(res, 200, state(user));
  if (p === '/api/rev' && m === 'GET') return send(res, 200, { rev });

  // Kategorien
  if (p === '/api/categories' && m === 'POST') {
    const b = await readJson(req);
    const sort = (db.prepare('SELECT MAX(sort) AS s FROM categories').get().s || 0) + 10;
    const r = db.prepare('INSERT INTO categories (name, budget, sort) VALUES (?, ?, ?)')
      .run(str(b.name, 120) || 'Neue Kategorie', amount(b.budget, false), sort);
    bump();
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }
  let mm;
  if ((mm = p.match(/^\/api\/categories\/(\d+)$/))) {
    const id = idParam(mm[1]);
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!cat) throw new HttpError(404, 'Kategorie nicht gefunden');
    if (m === 'PUT') {
      const b = await readJson(req);
      const name = b.name !== undefined ? str(b.name, 120) : cat.name;
      if (!name) throw new HttpError(400, 'Name fehlt');
      const budget = b.budget !== undefined ? amount(b.budget, false) : cat.budget;
      const sort = b.sort !== undefined ? Math.trunc(Number(b.sort)) || 0 : cat.sort;
      const reserve = b.reserve !== undefined ? (b.reserve ? 1 : 0) : cat.reserve;
      db.prepare('UPDATE categories SET name = ?, budget = ?, sort = ?, reserve = ? WHERE id = ?').run(name, budget, sort, reserve, id);
      bump();
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      db.prepare('DELETE FROM categories WHERE id = ?').run(id);
      bump();
      return send(res, 200, { ok: true });
    }
  }

  // Ausgaben
  if (p === '/api/expenses' && m === 'POST') {
    const id = insertExpense(expenseFromBody(await readJson(req)), user.id);
    bump();
    return send(res, 200, { id });
  }
  if ((mm = p.match(/^\/api\/expenses\/(\d+)$/))) {
    const id = idParam(mm[1]);
    if (!db.prepare('SELECT 1 FROM expenses WHERE id = ?').get(id)) throw new HttpError(404, 'Ausgabe nicht gefunden');
    if (m === 'PUT') {
      updateExpense(id, expenseFromBody(await readJson(req)), user.id);
      bump();
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      const files = db.prepare('SELECT stored_name FROM attachments WHERE expense_id = ?').all(id);
      db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
      files.forEach((f) => removeAttachmentFile(f.stored_name));
      bump();
      return send(res, 200, { ok: true });
    }
  }

  // ---- Entscheidungen ----
  if (p === '/api/decisions' && m === 'POST') {
    const b = await readJson(req);
    const sort = (db.prepare('SELECT MAX(sort) AS s FROM decisions').get().s || 0) + 10;
    const opts = cleanOptions(b.options || [{ id: 'o1', label: 'Nein / wie geplant', effects: [] }, { id: 'o2', label: 'Ja', effects: [] }]);
    const r = db.prepare('INSERT INTO decisions (title, note, options, sort, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(str(b.title, 120) || 'Neue Entscheidung', str(b.note, 1000), JSON.stringify(opts), sort, nowIso());
    bump();
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if ((mm = p.match(/^\/api\/decisions\/(\d+)$/))) {
    const id = idParam(mm[1]);
    const d = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
    if (!d) throw new HttpError(404, 'Entscheidung nicht gefunden');
    if (m === 'PUT') {
      const b = await readJson(req);
      db.prepare('UPDATE decisions SET title = ?, note = ?, options = ?, decided_option = ? WHERE id = ?').run(
        b.title !== undefined ? (str(b.title, 120) || d.title) : d.title, b.note !== undefined ? str(b.note, 1000) : d.note,
        b.options !== undefined ? JSON.stringify(cleanOptions(b.options)) : d.options,
        b.reopen ? null : d.decided_option, id);
      bump();
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') { db.prepare('DELETE FROM decisions WHERE id = ?').run(id); bump(); return send(res, 200, { ok: true }); }
  }
  if ((mm = p.match(/^\/api\/decisions\/(\d+)\/apply$/)) && m === 'POST') {
    // Option als entschieden übernehmen: Beträge in die Positionen schreiben bzw. neue Positionen anlegen
    const id = idParam(mm[1]);
    const d = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
    if (!d) throw new HttpError(404, 'Entscheidung nicht gefunden');
    const b = await readJson(req);
    const opt = (parseJson(d.options) || []).find((o) => o.id === b.option_id);
    if (!opt) throw new HttpError(400, 'Option nicht gefunden');
    backup('vor-entscheidung');
    let changed = 0, created = 0;
    db.exec('BEGIN');
    try {
      for (const f of opt.effects) {
        if (f.type === 'set') {
          const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(f.expense_id);
          if (!e) continue;
          // Angebot/Ist überschreiben, wenn schon eins da ist – sonst die Schätzung
          if (e.amount != null) db.prepare('UPDATE expenses SET amount = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(f.amount, user.id, nowIso(), e.id);
          else db.prepare('UPDATE expenses SET estimate = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(f.amount, user.id, nowIso(), e.id);
          changed += 1;
        } else {
          const cat = f.category_id != null && db.prepare('SELECT 1 FROM categories WHERE id = ?').get(f.category_id) ? f.category_id : null;
          insertExpense({ code: '', title: f.label, estimate: f.amount, amount: null, status: 'geplant', included: 'nein', category: cat,
            vendor: '', date: '', due: '', hint: `Aus Entscheidung „${d.title}“: ${opt.label}`, note: '', split: null,
            warranty_start: '', warranty_months: null, warranty_note: '' }, user.id);
          created += 1;
        }
      }
      db.prepare('UPDATE decisions SET decided_option = ?, decided_at = ? WHERE id = ?').run(opt.id, nowIso(), id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    bump();
    return send(res, 200, { changed, created });
  }

  // ---- Szenarien ----
  if (p === '/api/scenarios' && m === 'POST') {
    const b = await readJson(req);
    const sort = (db.prepare('SELECT MAX(sort) AS s FROM scenarios').get().s || 0) + 10;
    const r = db.prepare('INSERT INTO scenarios (name, choices, sort, created_at) VALUES (?, ?, ?, ?)')
      .run(str(b.name, 80) || 'Neues Szenario', JSON.stringify(b.choices && typeof b.choices === 'object' ? b.choices : {}), sort, nowIso());
    bump();
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if ((mm = p.match(/^\/api\/scenarios\/(\d+)$/))) {
    const id = idParam(mm[1]);
    const sc = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id);
    if (!sc) throw new HttpError(404, 'Szenario nicht gefunden');
    if (m === 'PUT') {
      const b = await readJson(req);
      const choices = b.choices !== undefined ? Object.fromEntries(Object.entries(b.choices || {}).map(([k, v]) => [String(Number(k)), str(v, 20)])) : parseJson(sc.choices);
      db.prepare('UPDATE scenarios SET name = ?, choices = ? WHERE id = ?').run(b.name !== undefined ? (str(b.name, 80) || sc.name) : sc.name, JSON.stringify(choices), id);
      bump();
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') { db.prepare('DELETE FROM scenarios WHERE id = ?').run(id); bump(); return send(res, 200, { ok: true }); }
  }

  // ---- Leistungsbeschreibungen / Angebote ----
  if (p === '/api/documents' && m === 'POST') {
    let filename = 'dokument.pdf';
    try { filename = decodeURIComponent(String(req.headers['x-filename'] || filename)); } catch { /* Standard */ }
    filename = path.basename(filename).replace(/[\u0000-\u001f"\\]/g, '').slice(0, 200) || 'dokument.pdf';
    let title = '', vendor = '';
    try { title = decodeURIComponent(String(req.headers['x-title'] || '')); vendor = decodeURIComponent(String(req.headers['x-vendor'] || '')); } catch { /* leer */ }
    const mime = str(req.headers['content-type'], 100).split(';')[0] || 'application/pdf';
    const body = await readBody(req, 60 * 1024 * 1024);
    if (!body.length) throw new HttpError(400, 'Leere Datei');
    let t;
    try { t = await ocr.extractText(body, mime, { maxPages: 120, maxOcrPages: 20 }); }
    catch (e) {
      if (e.code === 'ENOENT') throw new HttpError(501, 'Die Texterkennung ist auf diesem Server nicht installiert.');
      throw new HttpError(422, 'Das Dokument konnte nicht gelesen werden.');
    }
    if (t.text.replace(/\s/g, '').length < 200) throw new HttpError(422, 'Im Dokument wurde kaum Text gefunden.');
    const stored = `${crypto.randomUUID()}${path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10)}`;
    fs.writeFileSync(path.join(FILES_DIR, stored), body);
    const r = db.prepare(`INSERT INTO documents (title, vendor, filename, mime, size, stored_name, text, pages, method, uploaded_by, uploaded_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(str(title, 120) || filename.replace(/\.[^.]+$/, ''), str(vendor, 120), filename, mime, body.length, stored, t.text,
        t.text.split('\f').length, t.method, user.id, nowIso());
    log(`Dokument geprüft: ${filename} (${t.method}) von ${user.username}`);
    bump();
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if (p === '/api/documents/analysis' && m === 'GET') {
    const exps = db.prepare('SELECT id, code, title, hint FROM expenses').all();
    const out = db.prepare('SELECT id, text FROM documents ORDER BY id').all().map((d) => {
      const a = docs.analyze(d.text, exps);
      return { id: d.id, byExpense: a.byExpense, traps: a.traps };
    });
    return send(res, 200, { documents: out });
  }
  if ((mm = p.match(/^\/api\/documents\/(\d+)(\/file)?$/))) {
    const id = idParam(mm[1]);
    const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!d) throw new HttpError(404, 'Dokument nicht gefunden');
    if (mm[2] && m === 'GET') return sendFile(res, path.join(FILES_DIR, path.basename(d.stored_name)), d.mime, d.filename);
    if (!mm[2] && m === 'PUT') {
      const b = await readJson(req);
      db.prepare('UPDATE documents SET title = ?, vendor = ? WHERE id = ?').run(str(b.title, 120) || d.title, str(b.vendor, 120), id);
      bump(); return send(res, 200, { ok: true });
    }
    if (!mm[2] && m === 'DELETE') {
      db.prepare('DELETE FROM documents WHERE id = ?').run(id);
      removeAttachmentFile(d.stored_name);
      bump(); return send(res, 200, { ok: true });
    }
  }
  if (p === '/api/documents/apply' && m === 'POST') {
    const b = await readJson(req);
    const ch = Array.isArray(b.changes) ? b.changes.slice(0, 2000) : [];
    db.exec('BEGIN');
    let n = 0;
    try {
      for (const c of ch) {
        if (!INCLUDED.includes(c.included)) continue;
        n += Number(db.prepare('UPDATE expenses SET included = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(c.included, user.id, nowIso(), Number(c.expense_id)).changes);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    bump();
    return send(res, 200, { changed: n });
  }

  // ---- Eingang (Belege aus dem E-Mail-Postfach) ----
  if ((mm = p.match(/^\/api\/inbox\/(\d+)(?:\/(file|attach|dismiss))?$/))) {
    const id = idParam(mm[1]);
    const it = db.prepare('SELECT * FROM inbox WHERE id = ?').get(id);
    if (!it) throw new HttpError(404, 'Eintrag nicht gefunden');
    if (mm[2] === 'file' && m === 'GET') return sendFile(res, path.join(FILES_DIR, path.basename(it.stored_name)), it.mime, it.filename);
    if (mm[2] === 'attach' && m === 'POST') {
      const b = await readJson(req);
      const eid = Number(b.expense_id);
      if (!db.prepare('SELECT 1 FROM expenses WHERE id = ?').get(eid)) throw new HttpError(404, 'Position nicht gefunden');
      db.prepare(`INSERT INTO attachments (expense_id, filename, mime, size, stored_name, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(eid, it.filename, it.mime, it.size, it.stored_name, user.id, nowIso());
      db.prepare("UPDATE inbox SET status = 'erledigt', expense_id = ? WHERE id = ?").run(eid, id);
      bump(); return send(res, 200, { ok: true });
    }
    if (mm[2] === 'dismiss' && m === 'POST') {
      db.prepare("UPDATE inbox SET status = 'verworfen' WHERE id = ?").run(id);
      if (!db.prepare('SELECT 1 FROM attachments WHERE stored_name = ?').get(it.stored_name)) removeAttachmentFile(it.stored_name);
      bump(); return send(res, 200, { ok: true });
    }
  }

  // ---- E-Mail-Postfach ----
  if (p === '/api/mail' && m === 'PUT') {
    const b = await readJson(req);
    const c = mailConfig();
    const port = Number(b.port) || 993;
    if (port < 1 || port > 65535) throw new HttpError(400, 'Ungültiger Port');
    Object.assign(c, {
      enabled: !!b.enabled, host: str(b.host, 200), port, secure: b.secure !== false, user: str(b.user, 200),
      folder: str(b.folder, 120) || 'INBOX', done_folder: str(b.done_folder, 120), allowed: str(b.allowed, 1000),
      interval: Math.min(1440, Math.max(5, Number(b.interval) || 15)),
    });
    if (typeof b.pass === 'string' && b.pass) c.pass = b.pass.slice(0, 300);
    if (b.clear_pass) delete c.pass;
    setMeta('mail_config', JSON.stringify(c));
    bump();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/mail/test' && m === 'POST') {
    const c = mailConfig();
    if (!c.host || !c.user || !c.pass) throw new HttpError(400, 'Bitte Server, Benutzer und Passwort speichern');
    try { return send(res, 200, await mail.testConnection(c)); }
    catch (e) { throw new HttpError(502, e.message); }
  }
  if (p === '/api/mail/run' && m === 'POST') {
    const stat = await runMail('manuell');
    return send(res, 200, stat);
  }

  // ---- Kalender-Abo ----
  if (p === '/api/calendar/token' && m === 'POST') {
    const t = crypto.randomBytes(24).toString('base64url');
    setMeta('ics_token', t);
    return send(res, 200, { token: t });
  }
  if (p === '/api/calendar/token' && m === 'GET') return send(res, 200, { token: getMeta('ics_token') || null });

  // Beleg lesen (OCR) – die Datei wird nur ausgewertet und nicht gespeichert
  if (p === '/api/scan' && m === 'POST') {
    const mime = str(req.headers['content-type'], 100).split(';')[0] || 'application/octet-stream';
    const body = await readBody(req, MAX_UPLOAD);
    if (!body.length) throw new HttpError(400, 'Leere Datei');
    let res2;
    try { res2 = await ocr.extractText(body, mime); }
    catch (e) {
      if (e.code === 'ENOENT') throw new HttpError(501, 'Die Texterkennung ist auf diesem Server nicht installiert.');
      log('OCR-Fehler:', e.message, e.stderr || '');
      throw new HttpError(422, 'Der Beleg konnte nicht gelesen werden. Bitte ein schärferes Foto oder ein PDF verwenden.');
    }
    const fields = ocr.parseDocument(res2.text);
    const expenses = db.prepare('SELECT id, code, title, hint, vendor, estimate, category_id FROM expenses').all();
    const categories = db.prepare('SELECT id, name FROM categories').all();
    const matches = ocr.matchPositions(fields, res2.text, expenses, categories);
    const best = matches[0] && expenses.find((e) => e.id === matches[0].id);
    log(`Beleg gelesen (${res2.method}, ${res2.text.length} Zeichen) von ${user.username}`);
    return send(res, 200, {
      method: res2.method, text: res2.text.slice(0, 8000), fields, matches,
      category_id: best ? best.category_id : null,
    });
  }

  // Belege
  if ((mm = p.match(/^\/api\/expenses\/(\d+)\/attachments$/)) && m === 'POST') {
    const id = idParam(mm[1]);
    if (!db.prepare('SELECT 1 FROM expenses WHERE id = ?').get(id)) throw new HttpError(404, 'Ausgabe nicht gefunden');
    let filename = 'beleg';
    try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'beleg')); } catch { /* Standardname */ }
    filename = path.basename(filename).replace(/[\u0000-\u001f"\\]/g, '').slice(0, 200) || 'beleg';
    const mime = str(req.headers['content-type'], 100).split(';')[0] || 'application/octet-stream';
    const body = await readBody(req, MAX_UPLOAD);
    if (!body.length) throw new HttpError(400, 'Leere Datei');
    const stored = `${crypto.randomUUID()}${path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10)}`;
    fs.writeFileSync(path.join(FILES_DIR, stored), body);
    const r = db.prepare(`INSERT INTO attachments (expense_id, filename, mime, size, stored_name, uploaded_by, uploaded_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, filename, mime, body.length, stored, user.id, nowIso());
    bump();
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if ((mm = p.match(/^\/api\/attachments\/(\d+)$/))) {
    const id = idParam(mm[1]);
    const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
    if (!a) throw new HttpError(404, 'Beleg nicht gefunden');
    if (m === 'GET') {
      const file = path.join(FILES_DIR, path.basename(a.stored_name));
      if (!fs.existsSync(file)) throw new HttpError(404, 'Datei fehlt');
      const inline = SAFE_INLINE.has(a.mime);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'",
        'Content-Type': inline ? a.mime : 'application/octet-stream',
        'Content-Length': fs.statSync(file).size,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
        'Cache-Control': 'private, no-store',
        'X-Frame-Options': 'SAMEORIGIN',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (m === 'DELETE') {
      db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
      removeAttachmentFile(a.stored_name);
      bump();
      return send(res, 200, { ok: true });
    }
  }

  // Finanzierung
  if (p === '/api/sources' && m === 'POST') {
    const b = await readJson(req);
    const sort = (db.prepare('SELECT MAX(sort) AS s FROM sources').get().s || 0) + 10;
    const kind = SOURCE_KINDS.includes(b.kind) ? b.kind : 'eigen';
    const r = db.prepare('INSERT INTO sources (name, amount, note, sort, kind) VALUES (?, ?, ?, ?, ?)')
      .run(str(b.name, 120) || (kind === 'darlehen' ? 'Neues Darlehen' : 'Neuer Baustein'), amount(b.amount, false), str(b.note, 500), sort, kind);
    bump();
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if ((mm = p.match(/^\/api\/sources\/(\d+)$/))) {
    const id = idParam(mm[1]);
    const s = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'Baustein nicht gefunden');
    if (m === 'PUT') {
      const b = await readJson(req);
      const pick = (k, fn) => (b[k] !== undefined ? fn(b[k]) : s[k]);
      const name = pick('name', (v) => str(v, 120));
      if (!name) throw new HttpError(400, 'Name fehlt');
      const kind = pick('kind', (v) => (SOURCE_KINDS.includes(v) ? v : 'eigen'));
      const interest = pick('interest', (v) => {
        if (v === '' || v == null) return null;
        const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 25) throw new HttpError(400, 'Sollzins muss zwischen 0 und 25 % liegen');
        return Math.round(n * 1000) / 1000;
      });
      const rate = pick('rate', (v) => optAmount(v));
      const start = pick('start', (v) => {
        const t = str(v, 7);
        if (t && !/^\d{4}-(0[1-9]|1[0-2])$/.test(t)) throw new HttpError(400, 'Erste Rate bitte als Monat angeben (z. B. 03.2027)');
        return t;
      });
      const intIn = (lo, hi, label) => (v) => {
        if (v === '' || v == null) return null;
        const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${label}: ${lo}–${hi}`);
        return n;
      };
      const fixedYears = pick('fixed_years', intIn(0, 40, 'Zinsbindung in Jahren'));
      const grace = b.grace_months !== undefined ? (intIn(0, 120, 'Tilgungsfreie Monate')(b.grace_months) || 0) : s.grace_months;
      const amt = pick('amount', (v) => amount(v, false));
      const note = pick('note', (v) => str(v, 500));
      // Aufteilung bezieht sich bei Darlehen auf die Monatsrate, sonst auf den Betrag (wer bringt wie viel ein)
      const split = b.split !== undefined ? splitFromBody(b.split, kind === 'darlehen' ? rate : amt) : parseJson(s.split);
      db.prepare(`UPDATE sources SET name = ?, amount = ?, note = ?, kind = ?, interest = ?, rate = ?, start = ?, fixed_years = ?,
                  grace_months = ?, split = ? WHERE id = ?`)
        .run(name, amt, note, kind, interest, rate, start, fixedYears, grace, split ? JSON.stringify(split) : null, id);
      bump();
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      db.prepare('DELETE FROM sources WHERE id = ?').run(id);
      bump();
      return send(res, 200, { ok: true });
    }
  }

  // Export
  if (p === '/api/export.csv' && m === 'GET') {
    return send(res, 200, csvExport(), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="kassensturz-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  }

  // Benutzer
  if (p === '/api/users' && m === 'POST') {
    const b = await readJson(req);
    const username = validateUsername(b.username);
    validatePassword(b.password);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Benutzername vergeben');
    db.prepare('INSERT INTO users (username, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username, str(b.display_name, 60) || username, hashPassword(b.password), nowIso());
    log(`Benutzer angelegt: ${username} (von ${user.username})`);
    bump();
    return send(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/users\/(\d+)$/)) && m === 'DELETE') {
    const id = idParam(mm[1]);
    if (id === user.id) throw new HttpError(400, 'Du kannst dich nicht selbst löschen');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    bump();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/me' && m === 'PUT') {
    const b = await readJson(req);
    const full = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (b.display_name !== undefined) {
      const dn = str(b.display_name, 60);
      if (dn) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(dn, user.id);
    }
    if (b.new_password !== undefined) {
      if (typeof b.current_password !== 'string' || !verifyPassword(b.current_password, full.pw_hash)) {
        throw new HttpError(400, 'Aktuelles Passwort falsch');
      }
      validatePassword(b.new_password);
      db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hashPassword(b.new_password), user.id);
      // andere Sitzungen dieses Benutzers beenden
      const token = parseCookies(req).ks_session;
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, sha256(token));
    }
    bump();
    return send(res, 200, { ok: true });
  }

  // Einstellungen: Reserve-Satz und Standardaufteilung der Zahlungen
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readJson(req);
    if (b.reserve_rate !== undefined) {
      const rr = Number(b.reserve_rate);
      if (!Number.isFinite(rr) || rr < 0 || rr > 1) throw new HttpError(400, 'Reserve-Satz muss zwischen 0 und 100 % liegen');
      setMeta('reserve_rate', rr);
    }
    if (b.default_split !== undefined) {
      const sp = splitFromBody(b.default_split);
      if (sp && sp.mode !== 'pct') throw new HttpError(400, 'Die Standardaufteilung wird in Prozent angegeben');
      setMeta('default_split', sp ? JSON.stringify(sp) : 'null');
    }
    bump();
    return send(res, 200, { ok: true });
  }

  // Import / Export (JSON)
  if (p === '/api/import' && m === 'POST') {
    const buf = await readBody(req, 5 * 1024 * 1024);
    let b;
    try { b = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Datei ist kein gültiges JSON'); }
    backup('vor-import');
    const r = importData(b, user.id);
    log(`Import durch ${user.username}: ${JSON.stringify(r)}`);
    bump();
    return send(res, 200, r);
  }
  if (p === '/api/export.json' && m === 'GET') {
    return send(res, 200, JSON.stringify(jsonExport(), null, 2), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="kassensturz-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  }

  // Backups
  if (p === '/api/backups' && m === 'GET') {
    return send(res, 200, { keep: KEEP_BACKUPS, backups: listBackups() });
  }
  if (p === '/api/backups' && m === 'POST') {
    const f = backup('manuell');
    return send(res, 200, { name: path.basename(f) });
  }

  throw new HttpError(404, 'Nicht gefunden');
}

// ---------------------------------------------------------------------------
// Statische Dateien
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'Nicht gefunden');
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Ungültige URL'); }
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Nicht erlaubt');
    return serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    log('Fehler:', req.method, url.pathname, e);
    if (!res.headersSent) send(res, 500, { error: 'Interner Fehler' });
  }
});

server.listen(PORT, () => log(`Kassensturz v${VERSION} läuft auf Port ${PORT}, Daten in ${DATA_DIR}`));

function shutdown(sig) {
  log(`${sig} empfangen, beende …`);
  server.close(() => { try { db.close(); } catch { /* egal */ } process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
