'use strict';
(function () {
  const fmt0 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const fmt2 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const STATUS = [
    { k: 'option', l: 'Option', h: 'erwogen, noch nicht angefragt' },
    { k: 'angebot', l: 'Angebot', h: 'liegt vor, nicht beauftragt' },
    { k: 'beauftragt', l: 'Beauftragt', h: 'verbindlich, noch nicht bezahlt' },
    { k: 'bezahlt', l: 'Bezahlt', h: 'Geld ist geflossen' },
  ];
  const SL = Object.fromEntries(STATUS.map((s) => [s.k, s.l]));
  const NOCAT = 'none';
  const TABS = ['uebersicht', 'ausgaben', 'budget', 'finanzierung', 'einstellungen'];

  let S = { categories: [], expenses: [], sources: [], users: [], me: null, rev: 0, version: '' };
  let tab = 'uebersicht';
  const filt = { q: '', cat: '', st: '' };
  let pendingRender = false;

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  function parseAmount(s) {
    s = String(s == null ? '' : s).trim().replace(/[€\s]/g, '');
    if (!s) return NaN;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    return Number(s);
  }
  const amtInput = (n) => (n ? String(n).replace('.', ',') : '');
  const fdate = (d) => { if (!d) return ''; const p = d.split('-'); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : d; };
  const fsize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const userName = (id) => { const u = S.users.find((x) => x.id === id); return u ? u.display_name : ''; };

  // ---------- API ----------
  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  async function api(method, url, body, extraHeaders) {
    const opt = { method, headers: { 'X-Kassensturz': '1', ...(extraHeaders || {}) }, credentials: 'same-origin' };
    if (body instanceof Blob) opt.body = body;
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(url, opt); } catch (e) { throw new ApiError(0, 'Keine Verbindung zum Server'); }
    let data = null;
    try { data = await r.json(); } catch (e) { /* kein JSON */ }
    if (r.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/setup')) { showAuth(false); }
    if (!r.ok) throw new ApiError(r.status, (data && data.error) || 'Fehler ' + r.status);
    return data;
  }

  function setSync(txt, cls) { $('#synctxt').textContent = txt; $('#sync').className = cls || ''; }

  async function load() {
    try {
      S = await api('GET', '/api/state');
      setSync('Aktuell', 'ok');
      $('#who').textContent = S.me ? 'Angemeldet als ' + S.me.display_name : '';
      render();
    } catch (e) {
      if (e.status !== 401) setSync(e.message, 'warn');
    }
  }
  async function mutate(method, url, body) {
    const r = await api(method, url, body);
    await load();
    return r;
  }

  // Abgleich mit Änderungen der anderen Person
  async function poll() {
    if (document.hidden || $('#app').hidden) return;
    try {
      const r = await api('GET', '/api/rev');
      if (r.rev !== S.rev) await load(); else setSync('Aktuell', 'ok');
    } catch (e) { if (e.status !== 401) setSync('Server nicht erreichbar', 'warn'); }
  }
  setInterval(poll, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  // ---------- Auth ----------
  async function start() {
    let st;
    try { st = await api('GET', '/api/status'); } catch (e) {
      $('#auth').hidden = false;
      $('#auth').innerHTML = `<div class="authbox"><div class="card"><h1>Kassensturz</h1><div class="err">${esc(e.message)}</div></div></div>`;
      return;
    }
    if (st.user) { showApp(); return; }
    showAuth(st.setupNeeded);
  }

  function showAuth(setup) {
    $('#app').hidden = true;
    const a = $('#auth');
    a.hidden = false;
    a.innerHTML = setup ? `
      <div class="authbox"><div class="card">
        <h1>Kassensturz einrichten</h1>
        <div class="muted small">Lege das erste Konto an. Das zweite Konto (z. B. für deine Frau) erstellst du danach unter „Einstellungen“.</div>
        <form id="authForm" autocomplete="on">
          <label>Anzeigename<input name="display_name" placeholder="z. B. Daniel" required></label>
          <label>Benutzername<input name="username" autocomplete="username" required pattern="[A-Za-z0-9._\\-]{2,40}"></label>
          <label>Passwort (mind. 10 Zeichen)<input name="password" type="password" autocomplete="new-password" minlength="10" required></label>
          <label>Passwort wiederholen<input name="password2" type="password" autocomplete="new-password" minlength="10" required></label>
          <button class="primary" type="submit">Konto anlegen</button>
          <div class="err" id="authErr"></div>
        </form>
      </div></div>` : `
      <div class="authbox"><div class="card">
        <h1>Kassensturz</h1>
        <div class="muted small">Budget &amp; Ausgaben für den Hausbau</div>
        <form id="authForm" autocomplete="on">
          <label>Benutzername<input name="username" autocomplete="username" required autofocus></label>
          <label>Passwort<input name="password" type="password" autocomplete="current-password" required></label>
          <button class="primary" type="submit">Anmelden</button>
          <div class="err" id="authErr"></div>
        </form>
      </div></div>`;
    const f = $('#authForm');
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      if (setup && d.password !== d.password2) { $('#authErr').textContent = 'Passwörter stimmen nicht überein.'; return; }
      f.querySelector('button').disabled = true;
      try {
        await api('POST', setup ? '/api/setup' : '/api/login', { username: d.username, password: d.password, display_name: d.display_name });
        showApp();
      } catch (e) {
        $('#authErr').textContent = e.message;
        f.querySelector('button').disabled = false;
      }
    });
  }

  function showApp() {
    $('#auth').hidden = true;
    $('#auth').innerHTML = '';
    $('#app').hidden = false;
    route();
    load();
  }

  // ---------- Berechnungen ----------
  function catName(id) { const c = S.categories.find((c) => c.id === id); return c ? c.name : 'Ohne Kategorie'; }
  function totals(list) {
    const t = { option: 0, angebot: 0, beauftragt: 0, bezahlt: 0 };
    list.forEach((e) => { if (t[e.status] != null) t[e.status] += num(e.amount); });
    t.gebunden = t.bezahlt + t.beauftragt; t.prognose = t.gebunden + t.angebot; return t;
  }
  function catStats() {
    const rows = S.categories.map((c) => ({ id: c.id, name: c.name, budget: num(c.budget), ...totals(S.expenses.filter((e) => e.category_id === c.id)) }));
    const orphan = S.expenses.filter((e) => !S.categories.some((c) => c.id === e.category_id));
    if (orphan.length) rows.push({ id: NOCAT, name: 'Ohne Kategorie', budget: 0, ...totals(orphan) });
    return rows;
  }
  const finTotal = () => S.sources.reduce((s, x) => s + num(x.amount), 0);
  const budgetTotal = () => S.categories.reduce((s, c) => s + num(c.budget), 0);

  // ---------- Rendering ----------
  function render() {
    const ae = document.activeElement;
    if (ae && ae.closest && ae.closest('[data-live]')) { pendingRender = true; return; }
    if ($('#modal').classList.contains('open')) { pendingRender = true; return; }
    pendingRender = false;
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    const v = $('#view');
    if (tab === 'ausgaben') v.innerHTML = viewExpenses();
    else if (tab === 'budget') v.innerHTML = viewBudget();
    else if (tab === 'finanzierung') v.innerHTML = viewFinance();
    else if (tab === 'einstellungen') { v.innerHTML = viewSettings(); loadBackups(); }
    else v.innerHTML = viewOverview();
  }
  document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender) render(); }, 60));

  function kpi(l, v, h, cls) { return `<div class="card kpi"><div class="l">${l}</div><div class="v ${cls || ''}">${v}</div>${h ? `<div class="h">${h}</div>` : ''}</div>`; }

  function viewOverview() {
    const t = totals(S.expenses);
    const budget = budgetTotal();
    const ft = finTotal();
    const need = Math.max(budget, t.prognose);
    const rest = budget - t.prognose;
    const gap = ft - need;
    const rows = catStats();
    const maxv = Math.max(1, ...rows.map((r) => Math.max(r.budget, r.prognose)));
    let html = `<div class="grid kpis">
      ${kpi('Gesamtbudget', fmt0.format(budget), 'Summe aller Kategorien')}
      ${kpi('Bezahlt', fmt0.format(t.bezahlt), budget ? Math.round((t.bezahlt / budget) * 100) + ' % vom Budget' : '')}
      ${kpi('Beauftragt, offen', fmt0.format(t.beauftragt), 'noch zu zahlen')}
      ${kpi('Prognose', fmt0.format(t.prognose), 'bezahlt + beauftragt + Angebote')}
      ${kpi('Budget-Rest', fmt0.format(rest), rest < 0 ? 'Budget überschritten' : 'Luft im Budget', rest < 0 ? 'neg' : 'pos')}
      ${kpi('Finanzierung', fmt0.format(ft), gap < 0 ? 'Lücke ' + fmt0.format(-gap) : 'Puffer ' + fmt0.format(gap), gap < 0 ? 'neg' : 'pos')}
    </div>
    <div class="grid two">
      <div class="card"><h2>Budget je Kategorie</h2>
        <div class="legend"><span><i style="background:var(--paid)"></i>Bezahlt</span><span><i style="background:var(--comm)"></i>Beauftragt</span><span><i style="background:var(--offer)"></i>Angebot</span><span><span class="mk"></span>Budget</span></div>`;
    if (!rows.length) html += `<div class="empty">Noch keine Kategorien.</div>`;
    rows.forEach((r) => {
      const w = (x) => ((x / maxv) * 100).toFixed(2) + '%';
      const over = r.budget && r.prognose > r.budget;
      html += `<div class="catrow"><div class="n" title="${esc(r.name)}">${esc(r.name)}</div>
        <div class="bar">
          <div class="seg" style="left:0;width:${w(r.bezahlt)};background:var(--paid)"></div>
          <div class="seg" style="left:${w(r.bezahlt)};width:${w(r.beauftragt)};background:var(--comm)"></div>
          <div class="seg" style="left:${w(r.gebunden)};width:${w(r.angebot)};background:var(--offer)"></div>
          ${r.budget ? `<div class="mark" style="left:calc(${w(r.budget)} - 1px)" title="Budget ${fmt0.format(r.budget)}"></div>` : ''}
        </div>
        <div class="a ${over ? 'neg' : ''}">${fmt0.format(r.prognose)}<small>von ${r.budget ? fmt0.format(r.budget) : '–'}</small></div></div>`;
    });
    html += `</div><div class="grid" style="gap:14px">`;
    const open = S.expenses.filter((e) => e.status === 'beauftragt')
      .sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999'))).slice(0, 8);
    html += `<div class="card"><h2>Offene Zahlungen</h2>`;
    if (!open.length) html += `<div class="muted small">Keine beauftragten, offenen Posten.</div>`;
    else html += `<table><tbody>${open.map((e) => `<tr class="click" data-edit="${e.id}"><td>${esc(e.title)}<div class="muted small">${e.due ? 'fällig ' + fdate(e.due) : 'ohne Fälligkeit'}</div></td><td class="num">${fmt0.format(num(e.amount))}</td></tr>`).join('')}</tbody></table>`;
    html += `</div>`;
    const opts = S.expenses.filter((e) => e.status === 'option' || e.status === 'angebot');
    html += `<div class="card"><h2>Angebote &amp; Optionen</h2>`;
    if (!opts.length) html += `<div class="muted small">Keine offenen Entscheidungen.</div>`;
    else html += `<table><tbody>${opts.map((e) => `<tr class="click" data-edit="${e.id}"><td>${esc(e.title)}<div class="muted small">${esc(catName(e.category_id))}</div></td><td><span class="chip s-${e.status}">${SL[e.status]}</span></td><td class="num">${fmt0.format(num(e.amount))}</td></tr>`).join('')}</tbody></table>
      <div class="muted small" style="margin-top:8px">Optionen zählen nicht zur Prognose: ${fmt0.format(t.option)} insgesamt.</div>`;
    html += `</div></div></div>`;
    return html;
  }

  function filteredExpenses() {
    const q = filt.q.toLowerCase();
    return S.expenses.filter((e) => {
      if (filt.cat) {
        if (filt.cat === NOCAT) { if (S.categories.some((c) => c.id === e.category_id)) return false; }
        else if (String(e.category_id) !== filt.cat) return false;
      }
      if (filt.st && e.status !== filt.st) return false;
      if (q && !`${e.title} ${e.vendor || ''} ${e.note || ''}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.id - a.id);
  }

  function viewExpenses() {
    const list = filteredExpenses();
    const t = totals(list);
    const catOpts = S.categories.map((c) => `<option value="${c.id}" ${filt.cat === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    let html = `<div class="toolbar">
      <input id="fq" type="search" placeholder="Suchen …" value="${esc(filt.q)}" style="min-width:200px">
      <select id="fcat"><option value="">Alle Kategorien</option>${catOpts}<option value="${NOCAT}" ${filt.cat === NOCAT ? 'selected' : ''}>Ohne Kategorie</option></select>
      <select id="fst"><option value="">Alle Status</option>${STATUS.map((s) => `<option value="${s.k}" ${filt.st === s.k ? 'selected' : ''}>${s.l}</option>`).join('')}</select>
      <span class="spacer"></span>
      <a class="btn" href="/api/export.csv">CSV exportieren</a>
      <button class="primary" id="addExp">+ Ausgabe erfassen</button>
    </div><div class="card" style="padding:4px 8px;overflow-x:auto">`;
    if (!list.length) html += `<div class="empty">${S.expenses.length ? 'Keine Treffer für diesen Filter.' : 'Noch keine Ausgaben erfasst.'}</div>`;
    else html += `<table><thead><tr><th>Datum</th><th>Bezeichnung</th><th>Kategorie</th><th>Status</th><th class="num">Betrag</th></tr></thead><tbody>
      ${list.map((e) => `<tr class="click" data-edit="${e.id}"><td class="small">${fdate(e.date) || '<span class="muted">–</span>'}</td>
        <td>${esc(e.title)}${e.attachments.length ? `<span class="clip" title="Belege">📎 ${e.attachments.length}</span>` : ''}
          ${e.vendor ? `<div class="muted small">${esc(e.vendor)}</div>` : ''}${e.note ? `<div class="muted small">${esc(e.note)}</div>` : ''}
          ${e.created_by ? `<div class="muted small">erfasst von ${esc(userName(e.created_by))}</div>` : ''}</td>
        <td class="small">${esc(catName(e.category_id))}</td>
        <td><span class="chip s-${esc(e.status)}">${SL[e.status] || esc(e.status)}</span>${e.status === 'beauftragt' && e.due ? `<div class="muted small">fällig ${fdate(e.due)}</div>` : ''}</td>
        <td class="num">${fmt2.format(num(e.amount))}</td></tr>`).join('')}
      </tbody><tfoot>
        <tr><td colspan="4">Bezahlt</td><td class="num">${fmt2.format(t.bezahlt)}</td></tr>
        <tr><td colspan="4">Beauftragt, offen</td><td class="num">${fmt2.format(t.beauftragt)}</td></tr>
        <tr><td colspan="4">Angebote</td><td class="num">${fmt2.format(t.angebot)}</td></tr>
        <tr><td colspan="4" class="muted">Optionen (nicht in Prognose)</td><td class="num muted">${fmt2.format(t.option)}</td></tr>
      </tfoot></table>`;
    return html + `</div>`;
  }

  function viewBudget() {
    const rows = catStats();
    const tb = rows.reduce((s, r) => s + r.budget, 0), tp = rows.reduce((s, r) => s + r.prognose, 0), tg = rows.reduce((s, r) => s + r.gebunden, 0);
    let html = `<div class="toolbar"><div class="muted">Budget je Kategorie festlegen. Änderungen werden beim Verlassen des Feldes gespeichert.</div><span class="spacer"></span><button class="primary" id="addCat">+ Kategorie</button></div>
    <div class="card" style="padding:4px 8px;overflow-x:auto"><table class="edit-table" data-live><thead><tr><th style="width:36%">Kategorie</th><th class="num" style="width:16%">Budget</th><th class="num">Gebunden</th><th class="num">Prognose</th><th class="num">Rest</th><th></th></tr></thead><tbody>`;
    rows.forEach((r) => {
      const rest = r.budget - r.prognose;
      if (r.id === NOCAT) {
        html += `<tr><td class="muted">Ohne Kategorie</td><td class="num muted">–</td><td class="num">${fmt0.format(r.gebunden)}</td><td class="num">${fmt0.format(r.prognose)}</td><td class="num">–</td><td></td></tr>`;
        return;
      }
      html += `<tr><td><input data-cat="${r.id}" data-f="name" value="${esc(r.name)}"></td>
        <td><input data-cat="${r.id}" data-f="budget" inputmode="decimal" style="text-align:right" value="${esc(amtInput(r.budget))}" placeholder="0"></td>
        <td class="num">${fmt0.format(r.gebunden)}</td><td class="num">${fmt0.format(r.prognose)}</td>
        <td class="num ${rest < 0 ? 'neg' : ''}">${r.budget ? fmt0.format(rest) : '–'}</td>
        <td class="num"><button class="iconbtn" data-delcat="${r.id}" title="Kategorie löschen">✕</button></td></tr>`;
    });
    if (!rows.length) html += `<tr><td colspan="6"><div class="empty">Noch keine Kategorien.</div></td></tr>`;
    html += `</tbody><tfoot><tr><td>Summe</td><td class="num">${fmt0.format(tb)}</td><td class="num">${fmt0.format(tg)}</td><td class="num">${fmt0.format(tp)}</td><td class="num ${tb - tp < 0 ? 'neg' : ''}">${fmt0.format(tb - tp)}</td><td></td></tr></tfoot></table></div>
    <div class="err" id="catErr"></div>
    <div class="note"><b>Begriffe:</b> <i>Gebunden</i> = bezahlt + beauftragt. <i>Prognose</i> = gebunden + vorliegende Angebote. Optionen (z. B. Aufpreise, die ihr noch abwägt) zählen erst, wenn ihr sie auf „Angebot“ oder „Beauftragt“ setzt. Wird eine Kategorie gelöscht, landen ihre Ausgaben unter „Ohne Kategorie“.</div>`;
    return html;
  }

  function viewFinance() {
    const ft = finTotal();
    const t = totals(S.expenses);
    const need = Math.max(budgetTotal(), t.prognose);
    const gap = ft - need;
    const maxv = Math.max(ft, need, 1);
    let html = `<div class="grid kpis">
      ${kpi('Finanzierung gesamt', fmt0.format(ft))}
      ${kpi('Bedarf', fmt0.format(need), 'größerer Wert aus Budget und Prognose')}
      ${kpi(gap < 0 ? 'Finanzierungslücke' : 'Puffer', fmt0.format(Math.abs(gap)), '', gap < 0 ? 'neg' : 'pos')}
    </div>
    <div class="card" style="margin-top:14px"><h2>Finanzierung vs. Bedarf</h2>
      <div class="small muted">Finanzierung</div><div class="finbar"><div style="width:${((ft / maxv) * 100).toFixed(1)}%;background:var(--paid)"></div></div>
      <div class="small muted">Bedarf</div><div class="finbar"><div style="width:${((need / maxv) * 100).toFixed(1)}%;background:var(--comm)"></div></div>
    </div>
    <div class="toolbar" style="margin-top:18px"><h2 style="margin:0">Finanzierungsbausteine</h2><span class="spacer"></span><button class="primary" id="addSrc">+ Baustein</button></div>
    <div class="card" style="padding:4px 8px;overflow-x:auto"><table class="edit-table" data-live><thead><tr><th style="width:30%">Baustein</th><th class="num" style="width:18%">Betrag</th><th>Notiz (Zins, Laufzeit, Bank …)</th><th></th></tr></thead><tbody>`;
    S.sources.forEach((s) => {
      html += `<tr><td><input data-src="${s.id}" data-f="name" value="${esc(s.name)}"></td>
        <td><input data-src="${s.id}" data-f="amount" inputmode="decimal" style="text-align:right" value="${esc(amtInput(num(s.amount)))}" placeholder="0"></td>
        <td><input data-src="${s.id}" data-f="note" value="${esc(s.note || '')}"></td>
        <td class="num"><button class="iconbtn" data-delsrc="${s.id}" title="Entfernen">✕</button></td></tr>`;
    });
    if (!S.sources.length) html += `<tr><td colspan="4"><div class="empty">Noch keine Finanzierungsbausteine.</div></td></tr>`;
    html += `</tbody><tfoot><tr><td>Summe</td><td class="num">${fmt0.format(ft)}</td><td colspan="2"></td></tr></tfoot></table></div>
    <div class="err" id="finErr"></div>
    <div class="note"><b>KfW 297 „Klimafreundlicher Neubau“ (selbstgenutzt):</b> Kredit bis 100.000 € je Wohneinheit, mit QNG-Nachhaltigkeitssiegel bis 150.000 €. Konditionen ändern sich regelmäßig – aktuellen Zinssatz bei der Hausbank bzw. auf kfw.de/297 prüfen. Für den Antrag muss die Baugenehmigung vorliegen.</div>`;
    return html;
  }

  function viewSettings() {
    return `<div class="grid settings">
      <div class="card"><h2>Mein Konto</h2>
        <form id="meForm">
          <label>Anzeigename<input name="display_name" value="${esc(S.me ? S.me.display_name : '')}" required></label>
          <button type="submit">Name speichern</button>
        </form>
        <form id="pwForm" style="margin-top:18px">
          <label>Aktuelles Passwort<input name="current_password" type="password" autocomplete="current-password" required></label>
          <label>Neues Passwort (mind. 10 Zeichen)<input name="new_password" type="password" autocomplete="new-password" minlength="10" required></label>
          <button type="submit">Passwort ändern</button>
        </form>
        <div class="err" id="meErr"></div><div class="okmsg" id="meOk"></div>
        <div style="margin-top:18px"><button id="logout">Abmelden</button></div>
      </div>
      <div class="card"><h2>Benutzer</h2>
        <table><tbody>${S.users.map((u) => `<tr><td>${esc(u.display_name)}<div class="muted small">${esc(u.username)}</div></td>
          <td class="num">${S.me && u.id === S.me.id ? '<span class="muted small">du</span>' : `<button class="iconbtn" data-deluser="${u.id}">Entfernen</button>`}</td></tr>`).join('')}</tbody></table>
        <form id="userForm" style="margin-top:14px">
          <label>Anzeigename<input name="display_name" required></label>
          <label>Benutzername<input name="username" autocomplete="off" required pattern="[A-Za-z0-9._\\-]{2,40}"></label>
          <label>Start-Passwort (mind. 10 Zeichen)<input name="password" type="password" autocomplete="new-password" minlength="10" required></label>
          <button class="primary" type="submit">Benutzer anlegen</button>
        </form>
        <div class="err" id="userErr"></div><div class="okmsg" id="userOk"></div>
      </div>
      <div class="card"><h2>Backups</h2>
        <div class="muted small">Automatisch vor jedem Update und einmal täglich. Die Belege liegen als Dateien im Datenordner und werden über Hyper Backup mitgesichert.</div>
        <div id="backupList" class="small" style="margin:10px 0">Lade …</div>
        <button id="backupNow">Jetzt sichern</button>
        <div class="err" id="bkErr"></div>
        <div class="muted small" style="margin-top:14px">Version ${esc(S.version)}</div>
      </div>
    </div>`;
  }
  async function loadBackups() {
    const el = $('#backupList'); if (!el) return;
    try {
      const r = await api('GET', '/api/backups');
      el.innerHTML = r.backups.length
        ? `<table><tbody>${r.backups.map((b) => `<tr><td>${esc(b.name)}</td><td class="num">${fsize(b.size)}</td></tr>`).join('')}</tbody></table><div class="muted" style="margin-top:6px">Es werden die letzten ${r.keep} aufbewahrt.</div>`
        : 'Noch keine Backups.';
    } catch (e) { el.textContent = e.message; }
  }

  // ---------- Dialog Ausgabe ----------
  function openModal(html) { $('#dlg').innerHTML = html; $('#modal').classList.add('open'); const f = $('#dlg input'); if (f) f.focus(); }
  function closeModal() { $('#modal').classList.remove('open'); $('#dlg').innerHTML = ''; if (pendingRender) render(); }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modal').classList.contains('open')) closeModal(); });

  function expenseDialog(id) {
    const e = id ? S.expenses.find((x) => x.id === id) : null;
    if (id && !e) return;
    const d = e || { status: 'bezahlt', date: new Date().toISOString().slice(0, 10), category_id: filt.cat && filt.cat !== NOCAT ? Number(filt.cat) : null, attachments: [] };
    openModal(`<h2>${e ? 'Ausgabe bearbeiten' : 'Ausgabe erfassen'}</h2>
      <form id="expForm" class="form">
        <label class="full">Bezeichnung *<input name="title" required value="${esc(d.title || '')}" placeholder="z. B. Notarkosten Kaufvertrag"></label>
        <label>Betrag (€) *<input name="amount" inputmode="decimal" required value="${esc(amtInput(num(d.amount)))}" placeholder="12.500,00"></label>
        <label>Status<select name="status">${STATUS.map((s) => `<option value="${s.k}" ${d.status === s.k ? 'selected' : ''}>${s.l} – ${s.h}</option>`).join('')}</select></label>
        <label>Kategorie<select name="category_id"><option value="">Ohne Kategorie</option>${S.categories.map((c) => `<option value="${c.id}" ${d.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label>Firma / Anbieter<input name="vendor" value="${esc(d.vendor || '')}"></label>
        <label>Datum<input type="date" name="date" value="${esc(d.date || '')}"></label>
        <label>Fällig am<input type="date" name="due" value="${esc(d.due || '')}"></label>
        <label class="full">Notiz<textarea name="note" rows="2">${esc(d.note || '')}</textarea></label>
        <div class="full">
          <div class="small muted" style="font-weight:500;margin-bottom:4px">Belege (PDF, Fotos)</div>
          <div id="attList">${(d.attachments || []).map((a) => `<div class="att"><a href="/api/attachments/${a.id}" target="_blank" rel="noopener">${esc(a.filename)}</a><span class="muted small">${fsize(a.size)}</span><button type="button" class="iconbtn" data-delatt="${a.id}">✕</button></div>`).join('')}</div>
          <input type="file" name="files" multiple accept="application/pdf,image/*" style="margin-top:6px">
        </div>
      </form>
      <div class="err" id="expErr"></div>
      <div class="actions">
        ${e ? `<button class="danger" id="delExp">Löschen</button>` : ''}
        <span class="spacer"></span>
        <button id="cancel">Abbrechen</button>
        <button class="primary" id="saveExp">Speichern</button>
      </div>`);
    const form = $('#expForm');
    $('#cancel').onclick = closeModal;
    form.addEventListener('submit', (ev) => { ev.preventDefault(); save(); });
    $('#saveExp').onclick = save;
    if ($('#delExp')) $('#delExp').onclick = async () => {
      const b = $('#delExp');
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Wirklich löschen?'; return; }
      try { await api('DELETE', '/api/expenses/' + e.id); closeModal(); await load(); }
      catch (err) { $('#expErr').textContent = err.message; }
    };
    $('#attList').addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-delatt]'); if (!b) return;
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Löschen?'; b.classList.add('danger'); return; }
      try { await api('DELETE', '/api/attachments/' + b.dataset.delatt); b.closest('.att').remove(); pendingRender = true; await load(); }
      catch (err) { $('#expErr').textContent = err.message; }
    });
    async function save() {
      const f = new FormData(form);
      const amount = parseAmount(f.get('amount'));
      const title = String(f.get('title') || '').trim();
      if (!title) { $('#expErr').textContent = 'Bitte eine Bezeichnung eingeben.'; return; }
      if (!Number.isFinite(amount)) { $('#expErr').textContent = 'Betrag nicht erkannt (z. B. 12.500,00).'; return; }
      const body = {
        title, amount, status: f.get('status'), category_id: f.get('category_id') ? Number(f.get('category_id')) : null,
        vendor: f.get('vendor'), date: f.get('date'), due: f.get('due'), note: f.get('note'),
      };
      const files = form.querySelector('input[type=file]').files;
      $('#saveExp').disabled = true;
      try {
        let expId = e && e.id;
        if (e) await api('PUT', '/api/expenses/' + e.id, body);
        else expId = (await api('POST', '/api/expenses', body)).id;
        for (const file of files) {
          $('#expErr').textContent = 'Lade ' + file.name + ' hoch …';
          await api('POST', `/api/expenses/${expId}/attachments`, file, {
            'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name),
          });
        }
        closeModal();
        await load();
      } catch (err) {
        $('#saveExp').disabled = false; $('#expErr').textContent = err.message;
        await load();
      }
    }
  }

  // ---------- Events ----------
  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    const row = t.closest('[data-edit]'); if (row) { expenseDialog(Number(row.dataset.edit)); return; }
    try {
      if (t.id === 'addExp') { expenseDialog(null); return; }
      if (t.id === 'addCat') { await mutate('POST', '/api/categories', { name: 'Neue Kategorie', budget: 0 }); return; }
      if (t.id === 'addSrc') { await mutate('POST', '/api/sources', { name: 'Neuer Baustein', amount: 0 }); return; }
      if (t.dataset.delcat) {
        if (!t.dataset.armed) { t.dataset.armed = '1'; t.textContent = 'Löschen?'; t.classList.add('danger'); return; }
        await mutate('DELETE', '/api/categories/' + t.dataset.delcat); return;
      }
      if (t.dataset.delsrc) {
        if (!t.dataset.armed) { t.dataset.armed = '1'; t.textContent = 'Löschen?'; t.classList.add('danger'); return; }
        await mutate('DELETE', '/api/sources/' + t.dataset.delsrc); return;
      }
      if (t.dataset.deluser) {
        if (!t.dataset.armed) { t.dataset.armed = '1'; t.textContent = 'Wirklich entfernen?'; t.classList.add('danger'); return; }
        await mutate('DELETE', '/api/users/' + t.dataset.deluser); return;
      }
      if (t.id === 'logout') { await api('POST', '/api/logout'); showAuth(false); return; }
      if (t.id === 'backupNow') { t.disabled = true; await api('POST', '/api/backups'); t.disabled = false; loadBackups(); return; }
    } catch (err) {
      const el = $('#catErr') || $('#finErr') || $('#userErr') || $('#bkErr');
      if (el) el.textContent = err.message; else setSync(err.message, 'warn');
      if (t.id === 'backupNow') t.disabled = false;
    }
  });

  document.addEventListener('change', async (ev) => {
    const t = ev.target;
    if (t.id === 'fcat') { filt.cat = t.value; render(); return; }
    if (t.id === 'fst') { filt.st = t.value; render(); return; }
    if (t.dataset.cat) {
      const c = S.categories.find((x) => x.id === Number(t.dataset.cat)); if (!c) return;
      let v = t.value;
      if (t.dataset.f === 'budget') { v = v.trim() === '' ? 0 : parseAmount(v); if (!Number.isFinite(v)) { $('#catErr').textContent = 'Betrag nicht erkannt.'; return; } }
      else { v = v.trim(); if (!v) return; }
      if (c[t.dataset.f] === v) return;
      try { await mutate('PUT', '/api/categories/' + c.id, { [t.dataset.f]: v }); $('#catErr').textContent = ''; }
      catch (err) { $('#catErr').textContent = err.message; }
      return;
    }
    if (t.dataset.src) {
      const s = S.sources.find((x) => x.id === Number(t.dataset.src)); if (!s) return;
      let v = t.value;
      if (t.dataset.f === 'amount') { v = v.trim() === '' ? 0 : parseAmount(v); if (!Number.isFinite(v)) { $('#finErr').textContent = 'Betrag nicht erkannt.'; return; } }
      if (s[t.dataset.f] === v) return;
      try { await mutate('PUT', '/api/sources/' + s.id, { [t.dataset.f]: v }); $('#finErr').textContent = ''; }
      catch (err) { $('#finErr').textContent = err.message; }
    }
  });

  document.addEventListener('submit', async (ev) => {
    const f = ev.target;
    if (!['meForm', 'pwForm', 'userForm'].includes(f.id)) return;
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const isUser = f.id === 'userForm';
    const err = $(isUser ? '#userErr' : '#meErr'), ok = $(isUser ? '#userOk' : '#meOk');
    err.textContent = ''; ok.textContent = '';
    try {
      if (isUser) { await api('POST', '/api/users', d); f.reset(); ok.textContent = 'Benutzer angelegt.'; }
      else { await api('PUT', '/api/me', d); f.reset(); ok.textContent = f.id === 'pwForm' ? 'Passwort geändert.' : 'Gespeichert.'; }
      const msg = ok.textContent;
      await load();
      const ok2 = $(isUser ? '#userOk' : '#meOk'); if (ok2) ok2.textContent = msg;
    } catch (e) { err.textContent = e.message; }
  });

  let qTimer;
  document.addEventListener('input', (ev) => {
    if (ev.target.id !== 'fq') return;
    clearTimeout(qTimer);
    const el = ev.target;
    qTimer = setTimeout(() => {
      filt.q = el.value; const pos = el.selectionStart; render();
      const n = $('#fq'); if (n) { n.focus(); n.setSelectionRange(pos, pos); }
    }, 200);
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.matches('.edit-table input')) ev.target.blur(); });

  // ---------- Routing ----------
  function route() { const h = location.hash.replace('#', ''); tab = TABS.includes(h) ? h : 'uebersicht'; render(); }
  window.addEventListener('hashchange', route);

  start();
})();
