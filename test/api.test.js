'use strict';
// Integrationstest: startet den Server mit einem temporären Datenordner,
// prüft Login, Ausgaben, Belege und dass die Daten einen Neustart überleben.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kassensturz-test-'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

function startServer(env = {}) {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  proc.output = () => out;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      try { const r = await fetch(BASE + '/healthz'); if (r.ok) return resolve(proc); } catch { /* noch nicht da */ }
      if (Date.now() - t0 > 8000) { proc.kill(); return reject(new Error('Server startet nicht:\n' + out)); }
      setTimeout(tick, 100);
    };
    tick();
  });
}
const stop = (proc) => new Promise((r) => { proc.on('exit', r); proc.kill('SIGTERM'); });

let cookie = '';
async function call(method, url, body, headers = {}) {
  const h = { 'X-Kassensturz': '1', ...headers };
  if (cookie) h.Cookie = cookie;
  let payload = body;
  if (body !== undefined && !(body instanceof Buffer)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + url, { method, headers: h, body: payload });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}

test('kompletter Ablauf inklusive Neustart', async () => {
  let srv = await startServer();
  try {
    let r = await call('GET', '/api/status');
    assert.equal(r.body.setupNeeded, true);

    // ohne Login kein Zugriff
    r = await call('GET', '/api/state');
    assert.equal(r.status, 401);

    // ohne CSRF-Header keine Änderung
    const raw = await fetch(BASE + '/api/setup', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(raw.status, 403);

    r = await call('POST', '/api/setup', { username: 'daniel', password: 'kurz' });
    assert.equal(r.status, 400);
    r = await call('POST', '/api/setup', { username: 'daniel', display_name: 'Daniel', password: 'geheim-genug-123' });
    assert.equal(r.status, 200);
    r = await call('POST', '/api/setup', { username: 'x', password: 'geheim-genug-123' });
    assert.equal(r.status, 409, 'zweites Setup muss abgelehnt werden');

    r = await call('POST', '/api/users', { username: 'partnerin', display_name: 'Partnerin', password: 'auch-geheim-456' });
    assert.equal(r.status, 200);

    r = await call('GET', '/api/state');
    assert.equal(r.status, 200);
    assert.equal(r.body.categories.length, 14);
    assert.equal(r.body.sources.length, 3);
    assert.equal(r.body.users.length, 2);
    const haus = r.body.categories.find((c) => c.name.startsWith('Haus'));

    r = await call('PUT', `/api/categories/${haus.id}`, { budget: 420000 });
    assert.equal(r.status, 200);
    r = await call('POST', '/api/expenses', { title: 'Aufpreis Holzfaser', amount: 10000, status: 'option', category_id: haus.id });
    assert.equal(r.status, 200);
    const expId = r.body.id;
    r = await call('POST', '/api/expenses', { title: 'Kaputt', amount: 'abc' });
    assert.equal(r.status, 400);

    // Beleg hochladen und abrufen
    const pdf = Buffer.from('%PDF-1.4 test');
    r = await call('POST', `/api/expenses/${expId}/attachments`, pdf, { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent('Angebot Ü.pdf') });
    assert.equal(r.status, 200);
    const attId = r.body.id;
    r = await call('GET', `/api/attachments/${attId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), '%PDF-1.4 test');

    r = await call('GET', '/api/export.csv');
    assert.match(r.body.toString(), /Aufpreis Holzfaser/);

    // falsches Passwort
    const saved = cookie; cookie = '';
    r = await call('POST', '/api/login', { username: 'daniel', password: 'falsch-falsch' });
    assert.equal(r.status, 401);
    cookie = saved;
  } finally {
    await stop(srv);
  }

  // Neustart = neues Release: Daten müssen erhalten bleiben, Backup muss entstehen
  srv = await startServer({ KEEP_BACKUPS: '3' });
  try {
    const r = await call('GET', '/api/state');
    assert.equal(r.status, 200, 'Session muss den Neustart überleben');
    assert.equal(r.body.expenses.length, 1);
    assert.equal(r.body.expenses[0].attachments.length, 1);
    assert.equal(r.body.categories.find((c) => c.name.startsWith('Haus')).budget, 420000);
    const b = await call('GET', '/api/backups');
    assert.ok(b.body.backups.length >= 1, 'tägliches Backup erwartet');
  } finally {
    await stop(srv);
  }

  // Versionswechsel simulieren → Backup "vor-v…" erwartet
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(DATA, 'kassensturz.sqlite'));
  d.prepare("UPDATE meta SET value = '0.9.0' WHERE key = 'app_version'").run();
  d.close();
  srv = await startServer();
  try {
    const names = fs.readdirSync(path.join(DATA, 'backups'));
    assert.ok(names.some((n) => n.includes('vor-v')), 'Backup vor Update erwartet: ' + names.join(', '));
  } finally {
    await stop(srv);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
});


test('Migration v1 → v2 behält Daten, Import und Aufteilung funktionieren', async () => {
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kassensturz-mig-'));
  cookie = '';
  // Datenbank auf Stand v1 erzeugen und eine Ausgabe im alten Format anlegen
  let srv = await startServer({ KS_TARGET_MIGRATION: '1' });
  let ids;
  try {
    await call('POST', '/api/setup', { username: 'person1', display_name: 'Person 1', password: 'geheim-genug-123' });
    await call('POST', '/api/users', { username: 'person2', display_name: 'Person 2', password: 'geheim-genug-456' });
  } finally { await stop(srv); }
  {
    // Eintrag direkt im alten Schema anlegen (so wie ihn v1.0 geschrieben hätte)
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(path.join(DATA, 'kassensturz.sqlite'));
    ids = d.prepare('SELECT id FROM users ORDER BY id').all().map((u) => u.id);
    const cat = d.prepare('SELECT id FROM categories ORDER BY id LIMIT 1').get().id;
    const r = d.prepare(`INSERT INTO expenses (title, amount, status, category_id, created_by, created_at, updated_by, updated_at)
                         VALUES ('Alter Eintrag', 123.45, 'bezahlt', ?, ?, 'x', ?, 'x')`).run(cat, ids[0], ids[0]);
    d.prepare(`INSERT INTO attachments (expense_id, filename, mime, size, stored_name, uploaded_at) VALUES (?, 'a.png', 'image/png', 1, 'test.png', 'x')`)
      .run(Number(r.lastInsertRowid));
    d.close();
  }

  srv = await startServer();
  try {
    let r = await call('GET', '/api/state');
    assert.equal(r.status, 200);
    const old = r.body.expenses.find((e) => e.title === 'Alter Eintrag');
    assert.ok(old, 'alter Eintrag muss erhalten bleiben');
    assert.equal(old.amount, 123.45);
    assert.equal(old.included, 'nein');
    assert.equal(old.estimate, null);
    assert.equal(old.attachments.length, 1, 'Beleg muss nach Umbau noch zugeordnet sein');
    assert.equal(r.body.settings.reserve_rate, 0.1);
    assert.ok(fs.readdirSync(path.join(DATA, 'backups')).some((n) => n.includes('vor-v')), 'Backup vor Migration');

    // neue Felder + eigene Aufteilung
    r = await call('POST', '/api/expenses', {
      code: 'X1', title: 'Testposten', estimate: 1000, amount: null, status: 'geplant', included: 'pruefen', hint: 'Hinweis',
      split: { [ids[0]]: 70, [ids[1]]: 30 },
    });
    assert.equal(r.status, 200);
    r = await call('POST', '/api/expenses', { title: 'Falsch', estimate: 1, split: { [ids[0]]: 70, [ids[1]]: 20 } });
    assert.equal(r.status, 400, 'Aufteilung ungleich 100 % ablehnen');
    r = await call('POST', '/api/expenses', { title: 'Ohne Betrag' });
    assert.equal(r.status, 400);
    r = await call('PUT', '/api/settings', { reserve_rate: 0.05, default_split: { [ids[0]]: 60, [ids[1]]: 40 } });
    assert.equal(r.status, 200);
    r = await call('GET', '/api/state');
    assert.equal(r.body.settings.reserve_rate, 0.05);
    assert.equal(r.body.settings.default_split.values[ids[0]], 60);
    assert.equal(r.body.expenses.find((e) => e.code === 'X1').split.values[ids[1]], 30);

    // Aufteilung in Euro: muss den Betrag der Position ergeben
    r = await call('POST', '/api/expenses', { title: 'Euro-Aufteilung', amount: 1000, status: 'bezahlt', split: { mode: 'eur', values: { [ids[0]]: 800, [ids[1]]: 200 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('POST', '/api/expenses', { title: 'Euro falsch', amount: 1000, split: { mode: 'eur', values: { [ids[0]]: 800, [ids[1]]: 100 } } });
    assert.equal(r.status, 400);
    r = await call('PUT', '/api/settings', { default_split: { mode: 'eur', values: { [ids[0]]: 1, [ids[1]]: 1 } } });
    assert.equal(r.status, 400, 'Standardaufteilung nur in Prozent');

    // Darlehen mit Rate und Aufteilung
    let st2 = await call('GET', '/api/state');
    const kfw = st2.body.sources.find((x) => x.name.startsWith('KfW'));
    assert.equal(kfw.kind, 'darlehen', 'Migration 3 markiert KfW als Darlehen');
    r = await call('PUT', `/api/sources/${kfw.id}`, { amount: 100000, interest: 2.5, rate: 500, start: '2027-03', fixed_years: 10, grace_months: 12 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('PUT', `/api/sources/${kfw.id}`, { split: { mode: 'eur', values: { [ids[0]]: 300, [ids[1]]: 200 } } });
    assert.equal(r.status, 200);
    r = await call('PUT', `/api/sources/${kfw.id}`, { split: { mode: 'eur', values: { [ids[0]]: 300, [ids[1]]: 100 } } });
    assert.equal(r.status, 400, 'Raten-Aufteilung muss die Rate ergeben');
    r = await call('PUT', `/api/sources/${kfw.id}`, { start: '13.2027' });
    assert.equal(r.status, 400);
    st2 = await call('GET', '/api/state');
    const k2 = st2.body.sources.find((x) => x.id === kfw.id);
    assert.equal(k2.rate, 500); assert.equal(k2.interest, 2.5); assert.equal(k2.start, '2027-03');
    assert.equal(k2.grace_months, 12); assert.equal(k2.split.values[ids[0]], 300);

    // Eigenkapital: wer bringt wie viel ein (Bezug = Betrag)
    const eqSrc = st2.body.sources.find((x) => x.kind === 'eigen');
    r = await call('PUT', `/api/sources/${eqSrc.id}`, { amount: 50000, split: { mode: 'eur', values: { [ids[0]]: 30000, [ids[1]]: 20000 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('PUT', `/api/sources/${eqSrc.id}`, { split: { mode: 'eur', values: { [ids[0]]: 30000, [ids[1]]: 10000 } } });
    assert.equal(r.status, 400, 'Eigenkapital-Aufteilung muss den Betrag ergeben');

    // Import (Beispieldaten, keine echten Werte) – zweimal, darf nicht verdoppeln
    const imp = {
      format: 'kassensturz-import', version: 1, replace_empty_categories: true, settings: { reserve_rate: 0.1 },
      categories: [{ key: 'A', name: 'A · Testbereich', sort: 10, reserve: true }, { key: 'H', name: 'Haus', sort: 5, reserve: false }],
      positions: [
        { category: 'A', code: 'A1', title: 'Gutachten', included: 'nein', estimate: 100, amount: null, status: 'geplant', hint: '', note: 'https://example.org' },
        { category: 'A', code: 'A2', title: 'Recherche', included: 'nein', estimate: 30, amount: 60, status: 'beauftragt' },
        { category: 'H', code: 'Haus', title: 'Hauspreis', included: 'nein', estimate: 1000, amount: 1000, status: 'angebot' },
      ],
    };
    const body = Buffer.from(JSON.stringify(imp));
    r = await call('POST', '/api/import', body, { 'Content-Type': 'application/json' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.positions_created, 3);
    assert.ok(r.body.categories_removed >= 10, 'leere Standardbereiche entfernt');
    r = await call('POST', '/api/import', body, { 'Content-Type': 'application/json' });
    assert.equal(r.body.positions_created, 0);
    assert.equal(r.body.positions_updated, 3);
    r = await call('GET', '/api/state');
    assert.equal(r.body.expenses.filter((e) => e.code === 'A1').length, 1);
    assert.equal(r.body.categories.find((c) => c.name === 'Haus').reserve, 0);
    r = await call('GET', '/api/export.json');
    assert.equal(r.body.format, 'kassensturz-import');
    assert.equal(r.body.positions.length, 6);
  } finally {
    await stop(srv);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
});
