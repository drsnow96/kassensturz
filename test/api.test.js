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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kassensturz-test-'));
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
