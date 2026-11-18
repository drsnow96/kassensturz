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
const STATUSES = ['option', 'angebot', 'beauftragt', 'bezahlt'];

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
  const target = MIGRATIONS.length;
  if (current > target) {
    throw new Error(`Datenbank-Version ${current} ist neuer als diese App (${target}). Bitte neueres Image verwenden.`);
  }
  const lastVersion = current > 0 ? getMeta('app_version') : null;
  if (dbExisted && current > 0 && (current < target || lastVersion !== VERSION)) {
    backup(`vor-v${VERSION}`);
  }
  for (let v = current; v < target; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
      log(`Migration ${v + 1} angewendet`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
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
function state(user) {
  const attachments = db.prepare('SELECT id, expense_id, filename, mime, size, uploaded_by, uploaded_at FROM attachments ORDER BY id').all();
  const byExpense = new Map();
  for (const a of attachments) {
    if (!byExpense.has(a.expense_id)) byExpense.set(a.expense_id, []);
    byExpense.get(a.expense_id).push(a);
  }
  const expenses = db.prepare('SELECT * FROM expenses ORDER BY date DESC, id DESC').all()
    .map((e) => ({ ...e, attachments: byExpense.get(e.id) || [] }));
  return {
    rev,
    version: VERSION,
    me: user,
    users: db.prepare('SELECT id, username, display_name FROM users ORDER BY id').all(),
    categories: db.prepare('SELECT * FROM categories ORDER BY sort, id').all(),
    expenses,
    sources: db.prepare('SELECT * FROM sources ORDER BY sort, id').all(),
  };
}

function expenseFromBody(b) {
  const title = str(b.title, 200);
  if (!title) throw new HttpError(400, 'Bezeichnung fehlt');
  const status = STATUSES.includes(b.status) ? b.status : 'bezahlt';
  let category = b.category_id == null || b.category_id === '' ? null : Number(b.category_id);
  if (category != null && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(category)) category = null;
  return {
    title, status, category,
    amount: amount(b.amount),
    vendor: str(b.vendor, 200), date: date(b.date), due: date(b.due), note: str(b.note, 2000),
  };
}

function removeAttachmentFile(stored) {
  try { fs.unlinkSync(path.join(FILES_DIR, path.basename(stored))); } catch { /* bereits weg */ }
}

function csvExport() {
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const d = (s) => (s && s.length === 10 ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : '');
  const labels = { option: 'Option', angebot: 'Angebot', beauftragt: 'Beauftragt', bezahlt: 'Bezahlt' };
  const rows = db.prepare(`SELECT e.*, c.name AS category_name FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
                           ORDER BY e.date, e.id`).all();
  const lines = [['Datum', 'Bezeichnung', 'Firma', 'Kategorie', 'Status', 'Betrag', 'Fällig', 'Notiz'].map(q).join(';')];
  for (const e of rows) {
    lines.push([d(e.date), e.title, e.vendor, e.category_name || 'Ohne Kategorie', labels[e.status], e.amount.toFixed(2).replace('.', ','), d(e.due), e.note].map(q).join(';'));
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n';
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
      db.prepare('UPDATE categories SET name = ?, budget = ?, sort = ? WHERE id = ?').run(name, budget, sort, id);
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
    const e = expenseFromBody(await readJson(req));
    const t = nowIso();
    const r = db.prepare(`INSERT INTO expenses (title, amount, status, category_id, vendor, date, due, note, created_by, created_at, updated_by, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.title, e.amount, e.status, e.category, e.vendor, e.date, e.due, e.note, user.id, t, user.id, t);
    bump();
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if ((mm = p.match(/^\/api\/expenses\/(\d+)$/))) {
    const id = idParam(mm[1]);
    if (!db.prepare('SELECT 1 FROM expenses WHERE id = ?').get(id)) throw new HttpError(404, 'Ausgabe nicht gefunden');
    if (m === 'PUT') {
      const e = expenseFromBody(await readJson(req));
      db.prepare(`UPDATE expenses SET title = ?, amount = ?, status = ?, category_id = ?, vendor = ?, date = ?, due = ?, note = ?,
                  updated_by = ?, updated_at = ? WHERE id = ?`)
        .run(e.title, e.amount, e.status, e.category, e.vendor, e.date, e.due, e.note, user.id, nowIso(), id);
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
    const r = db.prepare('INSERT INTO sources (name, amount, note, sort) VALUES (?, ?, ?, ?)')
      .run(str(b.name, 120) || 'Neuer Baustein', amount(b.amount, false), str(b.note, 500), sort);
    bump();
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if ((mm = p.match(/^\/api\/sources\/(\d+)$/))) {
    const id = idParam(mm[1]);
    const s = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'Baustein nicht gefunden');
    if (m === 'PUT') {
      const b = await readJson(req);
      const name = b.name !== undefined ? str(b.name, 120) : s.name;
      if (!name) throw new HttpError(400, 'Name fehlt');
      db.prepare('UPDATE sources SET name = ?, amount = ?, note = ? WHERE id = ?')
        .run(name, b.amount !== undefined ? amount(b.amount, false) : s.amount, b.note !== undefined ? str(b.note, 500) : s.note, id);
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
