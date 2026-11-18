'use strict';
(function () {
  const fmt0 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const fmt2 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
  const STATUS = [
    { k: 'geplant', l: 'Geplant', h: 'Schätzung, noch kein Angebot' },
    { k: 'option', l: 'Option', h: 'erwogen, nicht eingeplant' },
    { k: 'angebot', l: 'Angebot', h: 'liegt vor, nicht beauftragt' },
    { k: 'beauftragt', l: 'Beauftragt', h: 'verbindlich, noch nicht bezahlt' },
    { k: 'bezahlt', l: 'Bezahlt', h: 'Geld ist geflossen' },
  ];
  const SL = Object.fromEntries(STATUS.map((s) => [s.k, s.l]));
  const INCL = [
    { k: 'nein', l: 'Nein', h: 'kostet zusätzlich zum Hauspreis' },
    { k: 'ja', l: 'Ja', h: 'im Hauspreis enthalten' },
    { k: 'pruefen', l: 'Prüfen', h: 'unklar – nur im Worst Case' },
  ];
  const IL = Object.fromEntries(INCL.map((s) => [s.k, s.l]));
  const NOCAT = 'none';
  const TABS = ['uebersicht', 'kosten', 'budget', 'finanzierung', 'einstellungen'];

  let S = { categories: [], expenses: [], sources: [], users: [], me: null, rev: 0, version: '', settings: { reserve_rate: 0.1, default_split: null } };
  let tab = 'uebersicht';
  const filt = { q: '', cat: '', st: '', inc: '' };
  let pendingRender = false;

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+[^\s<.,;:)\]]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}${u.length > 48 ? '…' : ''}</a>`);
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const has = (v) => v !== null && v !== undefined && v !== '';
  function parseAmount(s) {
    s = String(s == null ? '' : s).trim().replace(/[€\s]/g, '');
    if (!s) return NaN;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    return Number(s);
  }
  const amtInput = (n) => (has(n) && Number(n) !== 0 ? String(n).replace('.', ',') : (Number(n) === 0 && has(n) ? '0' : ''));
  const fdate = (d) => { if (!d) return ''; const p = d.split('-'); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : d; };
  const fsize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const userName = (id) => { const u = S.users.find((x) => x.id === id); return u ? u.display_name : ''; };
  const byCode = (a, b) => String(a.code || '').localeCompare(String(b.code || ''), 'de', { numeric: true }) || a.id - b.id;

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
        <div class="muted small">Lege das erste Konto an. Das zweite Konto erstellst du danach unter „Einstellungen“.</div>
        <form id="authForm" autocomplete="on">
          <label>Anzeigename<input name="display_name" required></label>
          <label>Benutzername<input name="username" autocomplete="username" required pattern="[A-Za-z0-9._\\-]{2,40}"></label>
          <label>Passwort (mind. 10 Zeichen)<input name="password" type="password" autocomplete="new-password" minlength="10" required></label>
          <label>Passwort wiederholen<input name="password2" type="password" autocomplete="new-password" minlength="10" required></label>
          <button class="primary" type="submit">Konto anlegen</button>
          <div class="err" id="authErr"></div>
        </form>
      </div></div>` : `
      <div class="authbox"><div class="card">
        <h1>Kassensturz</h1>
        <div class="muted small">Budget &amp; Kosten für den Hausbau</div>
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

  // ---------- Berechnungen (wie in der Excel-Kostenübersicht) ----------
  // Zählt zu den Kosten: „Nein“ (zusätzlich zum Hauspreis) – und „Prüfen“, sobald beauftragt/bezahlt.
  const counts = (e) => e.included === 'nein' || (e.included === 'pruefen' && (e.status === 'beauftragt' || e.status === 'bezahlt'));
  const cost = (e) => (has(e.amount) ? num(e.amount) : num(e.estimate));
  const active = (e) => counts(e) && e.status !== 'option';
  const catOf = (id) => S.categories.find((c) => c.id === id);
  function catName(id) { const c = catOf(id); return c ? c.name : 'Ohne Kategorie'; }

  function totals(list) {
    const t = { geplant: 0, option: 0, angebot: 0, beauftragt: 0, bezahlt: 0, schaetzung: 0, ist: 0, pruefen: 0, reserveBase: 0 };
    list.forEach((e) => {
      if (counts(e)) {
        t[e.status] += cost(e);
        if (e.status !== 'option') {
          t.schaetzung += num(e.estimate);
          if (has(e.amount)) t.ist += num(e.amount);
          const c = catOf(e.category_id);
          if (!c || c.reserve) t.reserveBase += cost(e);
        }
      } else if (e.included === 'pruefen' && e.status !== 'option') {
        t.pruefen += cost(e);
      }
    });
    t.gebunden = t.bezahlt + t.beauftragt;
    t.prognose = t.geplant + t.angebot + t.beauftragt + t.bezahlt;
    t.reserve = t.reserveBase * num(S.settings.reserve_rate);
    t.gesamt = t.prognose + t.reserve;
    t.worst = t.gesamt + t.pruefen;
    return t;
  }
  function catStats() {
    const rows = S.categories.map((c) => ({ ...c, budget: num(c.budget), ...totals(S.expenses.filter((e) => e.category_id === c.id)) }));
    const orphan = S.expenses.filter((e) => !catOf(e.category_id));
    if (orphan.length) rows.push({ id: NOCAT, name: 'Ohne Kategorie', budget: 0, reserve: 1, ...totals(orphan) });
    return rows;
  }
  const finTotal = () => S.sources.reduce((s, x) => s + num(x.amount), 0);

  // Aufteilung der Zahlungen
  function defaultSplit() {
    const ids = S.users.map((u) => u.id);
    const d = S.settings.default_split;
    if (d && ids.length && ids.every((id) => d[id] != null)) {
      const sum = ids.reduce((s, id) => s + num(d[id]), 0);
      if (Math.abs(sum - 100) < 0.6) return Object.fromEntries(ids.map((id) => [id, num(d[id])]));
    }
    return Object.fromEntries(ids.map((id) => [id, ids.length ? 100 / ids.length : 0]));
  }
  function splitOf(e) {
    if (e.split && S.users.every((u) => e.split[u.id] != null)) return e.split;
    if (e.split) { // Benutzer wurde ergänzt/entfernt: vorhandene Anteile übernehmen, Rest 0
      return Object.fromEntries(S.users.map((u) => [u.id, num(e.split[u.id])]));
    }
    return defaultSplit();
  }
  const splitLabel = (sp) => S.users.map((u) => pct.format(num(sp[u.id]))).join(' : ');
  function paidByUser() {
    const out = Object.fromEntries(S.users.map((u) => [u.id, 0]));
    let total = 0;
    S.expenses.filter((e) => e.status === 'bezahlt' && counts(e)).forEach((e) => {
      const sp = splitOf(e); const c = cost(e); total += c;
      S.users.forEach((u) => { out[u.id] += c * num(sp[u.id]) / 100; });
    });
    return { out, total };
  }

  // ---------- Rendering ----------
  function render() {
    const ae = document.activeElement;
    if (ae && ae.closest && ae.closest('[data-live]')) { pendingRender = true; return; }
    if ($('#modal').classList.contains('open')) { pendingRender = true; return; }
    pendingRender = false;
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    const v = $('#view');
    if (tab === 'kosten') v.innerHTML = viewCosts();
    else if (tab === 'budget') v.innerHTML = viewBudget();
    else if (tab === 'finanzierung') v.innerHTML = viewFinance();
    else if (tab === 'einstellungen') { v.innerHTML = viewSettings(); loadBackups(); }
    else v.innerHTML = viewOverview();
  }
  document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender) render(); }, 60));

  function kpi(l, v, h, cls) { return `<div class="card kpi"><div class="l">${l}</div><div class="v ${cls || ''}">${v}</div>${h ? `<div class="h">${h}</div>` : ''}</div>`; }
  const rr = () => pct.format(num(S.settings.reserve_rate) * 100) + ' %';

  function viewOverview() {
    const t = totals(S.expenses);
    const ft = finTotal();
    const gap = ft - t.gesamt;
    const rows = catStats().filter((r) => r.prognose || r.budget || r.schaetzung);
    const maxv = Math.max(1, ...rows.map((r) => Math.max(r.budget || r.schaetzung, r.prognose)));
    let html = `<div class="grid kpis">
      ${kpi('Gesamtbudget', fmt0.format(t.gesamt), `Prognose ${fmt0.format(t.prognose)} + ${rr()} Reserve`)}
      ${kpi('Bezahlt', fmt0.format(t.bezahlt), t.gesamt ? Math.round((t.bezahlt / t.gesamt) * 100) + ' % vom Gesamtbudget' : '')}
      ${kpi('Beauftragt, offen', fmt0.format(t.beauftragt), 'noch zu zahlen')}
      ${kpi('Noch geplant', fmt0.format(t.geplant + t.angebot), 'Schätzungen und Angebote')}
      ${kpi('Worst Case', fmt0.format(t.worst), `falls alle „Prüfen“-Posten anfallen (+${fmt0.format(t.pruefen)})`, 'neg')}
      ${kpi('Finanzierung', fmt0.format(ft), gap < 0 ? 'Lücke ' + fmt0.format(-gap) : 'Puffer ' + fmt0.format(gap), gap < 0 ? 'neg' : 'pos')}
    </div>
    <div class="grid two">
      <div class="card"><h2>Kosten je Bereich</h2>
        <div class="legend"><span><i style="background:var(--paid)"></i>Bezahlt</span><span><i style="background:var(--comm)"></i>Beauftragt</span><span><i style="background:var(--offer)"></i>Geplant / Angebot</span><span><span class="mk"></span>Budget bzw. Schätzung</span></div>`;
    if (!rows.length) html += `<div class="empty">Noch keine Kosten erfasst.</div>`;
    rows.forEach((r) => {
      const w = (x) => ((x / maxv) * 100).toFixed(2) + '%';
      const ref = r.budget || r.schaetzung;
      const over = ref && r.prognose > ref + 0.5;
      html += `<div class="catrow"><div class="n" title="${esc(r.name)}">${esc(r.name)}</div>
        <div class="bar">
          <div class="seg" style="left:0;width:${w(r.bezahlt)};background:var(--paid)"></div>
          <div class="seg" style="left:${w(r.bezahlt)};width:${w(r.beauftragt)};background:var(--comm)"></div>
          <div class="seg" style="left:${w(r.gebunden)};width:${w(r.angebot + r.geplant)};background:var(--offer)"></div>
          ${ref ? `<div class="mark" style="left:calc(${w(ref)} - 1px)" title="${r.budget ? 'Budget' : 'Schätzung'} ${fmt0.format(ref)}"></div>` : ''}
        </div>
        <div class="a ${over ? 'neg' : ''}">${fmt0.format(r.prognose)}<small>${ref ? (r.budget ? 'Budget ' : 'geschätzt ') + fmt0.format(ref) : '–'}</small></div></div>`;
    });
    html += `<div class="catrow"><div class="n muted">Reserve (${rr()})</div><div></div><div class="a">${fmt0.format(t.reserve)}</div></div>`;
    html += `</div><div class="grid" style="gap:14px">`;

    // Wer hat gezahlt
    if (S.users.length) {
      const { out, total } = paidByUser();
      const target = defaultSplit();
      html += `<div class="card"><h2>Gezahlt nach Person</h2><table><tbody>${S.users.map((u) => {
        const diff = out[u.id] - total * num(target[u.id]) / 100;
        return `<tr><td>${esc(u.display_name)}<div class="muted small">Soll ${pct.format(num(target[u.id]))} %</div></td><td class="num">${fmt0.format(out[u.id])}
          ${S.users.length > 1 && Math.abs(diff) >= 1 ? `<div class="small ${diff > 0 ? 'pos' : 'neg'}">${diff > 0 ? '+' : '−'}${fmt0.format(Math.abs(diff))} ggü. Soll</div>` : ''}</td></tr>`;
      }).join('')}</tbody><tfoot><tr><td>Bezahlt gesamt</td><td class="num">${fmt0.format(total)}</td></tr></tfoot></table></div>`;
    }

    const open = S.expenses.filter((e) => e.status === 'beauftragt' && counts(e))
      .sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999'))).slice(0, 8);
    html += `<div class="card"><h2>Offene Zahlungen</h2>`;
    if (!open.length) html += `<div class="muted small">Keine beauftragten, offenen Posten.</div>`;
    else html += `<table><tbody>${open.map((e) => `<tr class="click" data-edit="${e.id}"><td>${esc(e.title)}<div class="muted small">${e.due ? 'fällig ' + fdate(e.due) : 'ohne Fälligkeit'}</div></td><td class="num">${fmt0.format(cost(e))}</td></tr>`).join('')}</tbody></table>`;
    html += `</div>`;

    const dec = S.expenses.filter((e) => (e.included === 'pruefen' && !counts(e)) || e.status === 'option' || e.status === 'angebot').sort(byCode);
    html += `<div class="card"><h2>Offene Entscheidungen</h2>`;
    if (!dec.length) html += `<div class="muted small">Keine.</div>`;
    else html += `<table><tbody>${dec.map((e) => `<tr class="click" data-edit="${e.id}"><td>${e.code ? `<span class="muted">${esc(e.code)}</span> ` : ''}${esc(e.title)}</td>
      <td>${e.included === 'pruefen' && !counts(e) ? '<span class="chip s-pruefen">Prüfen</span>' : `<span class="chip s-${e.status}">${SL[e.status]}</span>`}</td><td class="num">${fmt0.format(cost(e))}</td></tr>`).join('')}</tbody></table>`;
    html += `</div></div></div>`;
    return html;
  }

  function matches(e) {
    const q = filt.q.toLowerCase();
    if (filt.cat) {
      if (filt.cat === NOCAT) { if (catOf(e.category_id)) return false; }
      else if (String(e.category_id) !== filt.cat) return false;
    }
    if (filt.st && e.status !== filt.st) return false;
    if (filt.inc && e.included !== filt.inc) return false;
    if (q && !`${e.code} ${e.title} ${e.vendor || ''} ${e.hint || ''} ${e.note || ''}`.toLowerCase().includes(q)) return false;
    return true;
  }

  function costRow(e) {
    const diff = has(e.amount) && has(e.estimate) ? num(e.amount) - num(e.estimate) : null;
    const dim = !counts(e) ? ' class="click dim"' : ' class="click"';
    return `<tr${dim} data-edit="${e.id}">
      <td class="small muted">${esc(e.code)}</td>
      <td>${esc(e.title)}${e.attachments.length ? `<span class="clip" title="Belege">📎 ${e.attachments.length}</span>` : ''}
        ${e.hint ? `<div class="muted small">${esc(e.hint)}</div>` : ''}
        ${e.note ? `<div class="small info">${linkify(e.note)}</div>` : ''}
        ${e.vendor ? `<div class="muted small">${esc(e.vendor)}</div>` : ''}
        ${e.status === 'bezahlt' && S.users.length > 1 && e.split ? `<div class="muted small">Aufteilung ${splitLabel(splitOf(e))}</div>` : ''}</td>
      <td><span class="chip i-${e.included}">${IL[e.included]}</span></td>
      <td class="num">${has(e.estimate) ? fmt0.format(num(e.estimate)) : '<span class="muted">–</span>'}</td>
      <td class="num">${has(e.amount) ? fmt2.format(num(e.amount)) : '<span class="muted">–</span>'}</td>
      <td class="num small ${diff > 0 ? 'neg' : diff < 0 ? 'pos' : ''}">${diff ? (diff > 0 ? '+' : '') + fmt0.format(diff) : ''}</td>
      <td><span class="chip s-${esc(e.status)}">${SL[e.status] || esc(e.status)}</span>${e.status === 'beauftragt' && e.due ? `<div class="muted small">fällig ${fdate(e.due)}</div>` : ''}</td>
    </tr>`;
  }

  function viewCosts() {
    const catOpts = S.categories.map((c) => `<option value="${c.id}" ${filt.cat === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    let html = `<div class="toolbar">
      <input id="fq" type="search" placeholder="Suchen …" value="${esc(filt.q)}" style="min-width:180px">
      <select id="fcat"><option value="">Alle Bereiche</option>${catOpts}<option value="${NOCAT}" ${filt.cat === NOCAT ? 'selected' : ''}>Ohne Kategorie</option></select>
      <select id="finc"><option value="">Im Hauspreis: alle</option>${INCL.map((s) => `<option value="${s.k}" ${filt.inc === s.k ? 'selected' : ''}>Im Hauspreis: ${s.l}</option>`).join('')}</select>
      <select id="fst"><option value="">Alle Status</option>${STATUS.map((s) => `<option value="${s.k}" ${filt.st === s.k ? 'selected' : ''}>${s.l}</option>`).join('')}</select>
      <span class="spacer"></span>
      <a class="btn" href="/api/export.csv">CSV</a>
      <button class="primary" id="addExp">+ Position</button>
    </div>`;
    const groups = S.categories.map((c) => ({ id: c.id, name: c.name, items: S.expenses.filter((e) => e.category_id === c.id) }));
    const orphan = S.expenses.filter((e) => !catOf(e.category_id));
    if (orphan.length) groups.push({ id: NOCAT, name: 'Ohne Kategorie', items: orphan });
    let any = false;
    const all = [];
    html += `<div class="card" style="padding:4px 8px;overflow-x:auto"><table class="costs"><thead><tr><th>Nr</th><th>Kostenpunkt</th><th>Im Hauspreis?</th><th class="num">Schätzung</th><th class="num">Angebot / Ist</th><th class="num">Differenz</th><th>Status</th></tr></thead>`;
    groups.forEach((g) => {
      const items = g.items.filter(matches).sort(byCode);
      if (!items.length) return;
      any = true; all.push(...items);
      const t = totals(items);
      html += `<tbody><tr class="group"><td colspan="7">${esc(g.name)}</td></tr>${items.map(costRow).join('')}
        <tr class="sub"><td></td><td>Zwischensumme (nur Kosten zusätzlich zum Hauspreis)</td><td></td><td class="num">${fmt0.format(t.schaetzung)}</td><td class="num">${t.ist ? fmt0.format(t.ist) : ''}</td><td></td><td class="num">${fmt0.format(t.prognose)}</td></tr></tbody>`;
    });
    if (!any) html += `<tbody><tr><td colspan="7"><div class="empty">${S.expenses.length ? 'Keine Treffer für diesen Filter.' : 'Noch keine Positionen. Lege eine an oder importiere eure Kostenübersicht unter „Einstellungen“.'}</div></td></tr></tbody>`;
    else {
      const t = totals(all);
      html += `<tfoot>
        <tr><td></td><td colspan="2">Prognose (Ist, sonst Schätzung)</td><td class="num">${fmt0.format(t.schaetzung)}</td><td class="num">${fmt0.format(t.ist)}</td><td></td><td class="num">${fmt0.format(t.prognose)}</td></tr>
        <tr><td></td><td colspan="5">Reserve ${rr()}</td><td class="num">${fmt0.format(t.reserve)}</td></tr>
        <tr><td></td><td colspan="5">Gesamtbudget</td><td class="num">${fmt0.format(t.gesamt)}</td></tr>
        <tr><td></td><td colspan="5" class="muted">Nachrichtlich „Prüfen“ – nicht enthalten</td><td class="num muted">${fmt0.format(t.pruefen)}</td></tr>
      </tfoot>`;
    }
    return html + `</table></div>`;
  }

  function viewBudget() {
    const rows = catStats();
    const t = totals(S.expenses);
    let html = `<div class="toolbar"><div class="muted">Je Bereich: Schätzung aus den Positionen, optional ein eigener Budgetrahmen. Änderungen werden beim Verlassen des Feldes gespeichert.</div><span class="spacer"></span><button class="primary" id="addCat">+ Bereich</button></div>
    <div class="card" style="padding:4px 8px;overflow-x:auto"><table class="edit-table" data-live><thead><tr><th style="width:30%">Bereich</th><th title="Fließt in die Reserve-Berechnung ein">Reserve</th><th class="num">Schätzung</th><th class="num">Angebot / Ist</th><th class="num">Prognose</th><th class="num" style="width:14%">Budgetrahmen</th><th class="num">Rest</th><th></th></tr></thead><tbody>`;
    rows.forEach((r) => {
      const ref = r.budget || r.schaetzung;
      const rest = ref - r.prognose;
      if (r.id === NOCAT) {
        html += `<tr><td class="muted">Ohne Kategorie</td><td></td><td class="num">${fmt0.format(r.schaetzung)}</td><td class="num">${fmt0.format(r.ist)}</td><td class="num">${fmt0.format(r.prognose)}</td><td></td><td></td><td></td></tr>`;
        return;
      }
      html += `<tr><td><input data-cat="${r.id}" data-f="name" value="${esc(r.name)}"></td>
        <td style="text-align:center"><input type="checkbox" data-cat="${r.id}" data-f="reserve" ${r.reserve ? 'checked' : ''} style="width:auto"></td>
        <td class="num">${fmt0.format(r.schaetzung)}</td><td class="num">${r.ist ? fmt0.format(r.ist) : '–'}</td><td class="num">${fmt0.format(r.prognose)}</td>
        <td><input data-cat="${r.id}" data-f="budget" inputmode="decimal" style="text-align:right" value="${esc(r.budget ? amtInput(r.budget) : '')}" placeholder="optional"></td>
        <td class="num ${rest < -0.5 ? 'neg' : ''}">${ref ? fmt0.format(rest) : '–'}</td>
        <td class="num"><button class="iconbtn" data-delcat="${r.id}" title="Bereich löschen">✕</button></td></tr>`;
    });
    if (!rows.length) html += `<tr><td colspan="8"><div class="empty">Noch keine Bereiche.</div></td></tr>`;
    html += `</tbody><tfoot>
      <tr><td>Summe</td><td></td><td class="num">${fmt0.format(t.schaetzung)}</td><td class="num">${fmt0.format(t.ist)}</td><td class="num">${fmt0.format(t.prognose)}</td><td></td><td></td><td></td></tr>
      <tr><td>Reserve ${rr()}</td><td></td><td></td><td></td><td class="num">${fmt0.format(t.reserve)}</td><td></td><td></td><td></td></tr>
      <tr><td>Gesamtbudget</td><td></td><td></td><td></td><td class="num">${fmt0.format(t.gesamt)}</td><td></td><td></td><td></td></tr>
    </tfoot></table></div>
    <div class="err" id="catErr"></div>
    <div class="note"><b>So wird gerechnet (wie in eurer Excel-Kostenübersicht):</b> Es zählen Positionen mit „Im Hauspreis? = Nein“. „Ja“ ist im Hauspreis enthalten und wird nur aufgeführt. „Prüfen“ zählt nur zum Worst Case – außer der Posten ist beauftragt oder bezahlt. Pro Position gilt der Angebots-/Ist-Betrag, solange keiner da ist die Schätzung. Optionen zählen nicht mit. Die Reserve wird auf alle Bereiche mit Haken bei „Reserve“ berechnet.</div>`;
    return html;
  }

  function viewFinance() {
    const ft = finTotal();
    const t = totals(S.expenses);
    const gap = ft - t.gesamt;
    const maxv = Math.max(ft, t.worst, 1);
    let html = `<div class="grid kpis">
      ${kpi('Finanzierung gesamt', fmt0.format(ft))}
      ${kpi('Bedarf', fmt0.format(t.gesamt), 'Gesamtbudget inkl. Reserve')}
      ${kpi(gap < 0 ? 'Finanzierungslücke' : 'Puffer', fmt0.format(Math.abs(gap)), '', gap < 0 ? 'neg' : 'pos')}
      ${kpi('Puffer im Worst Case', fmt0.format(ft - t.worst), '', ft - t.worst < 0 ? 'neg' : 'pos')}
    </div>
    <div class="card" style="margin-top:14px"><h2>Finanzierung vs. Bedarf</h2>
      <div class="small muted">Finanzierung</div><div class="finbar"><div style="width:${((ft / maxv) * 100).toFixed(1)}%;background:var(--paid)"></div></div>
      <div class="small muted">Bedarf (Gesamtbudget)</div><div class="finbar"><div style="width:${((t.gesamt / maxv) * 100).toFixed(1)}%;background:var(--comm)"></div></div>
      <div class="small muted">Worst Case</div><div class="finbar"><div style="width:${((t.worst / maxv) * 100).toFixed(1)}%;background:var(--offer)"></div></div>
    </div>
    <div class="toolbar" style="margin-top:18px"><h2 style="margin:0">Finanzierungsbausteine</h2><span class="spacer"></span><button class="primary" id="addSrc">+ Baustein</button></div>
    <div class="card" style="padding:4px 8px;overflow-x:auto"><table class="edit-table" data-live><thead><tr><th style="width:30%">Baustein</th><th class="num" style="width:18%">Betrag</th><th>Notiz (Zins, Laufzeit, Bank …)</th><th></th></tr></thead><tbody>`;
    S.sources.forEach((s) => {
      html += `<tr><td><input data-src="${s.id}" data-f="name" value="${esc(s.name)}"></td>
        <td><input data-src="${s.id}" data-f="amount" inputmode="decimal" style="text-align:right" value="${esc(s.amount ? amtInput(s.amount) : '')}" placeholder="0"></td>
        <td><input data-src="${s.id}" data-f="note" value="${esc(s.note || '')}"></td>
        <td class="num"><button class="iconbtn" data-delsrc="${s.id}" title="Entfernen">✕</button></td></tr>`;
    });
    if (!S.sources.length) html += `<tr><td colspan="4"><div class="empty">Noch keine Finanzierungsbausteine.</div></td></tr>`;
    html += `</tbody><tfoot><tr><td>Summe</td><td class="num">${fmt0.format(ft)}</td><td colspan="2"></td></tr></tfoot></table></div>
    <div class="err" id="finErr"></div>
    <div class="note"><b>KfW 297 „Klimafreundlicher Neubau“ (selbstgenutzt):</b> Kredit bis 100.000 € je Wohneinheit, mit QNG-Nachhaltigkeitssiegel bis 150.000 €. Konditionen ändern sich regelmäßig – aktuellen Zinssatz bei der Hausbank bzw. auf kfw.de/297 prüfen. Für den Antrag muss die Baugenehmigung vorliegen.</div>`;
    return html;
  }

  function splitInputs(sp, prefix) {
    if (S.users.length < 2) return `<div class="muted small">Sobald ein zweites Konto angelegt ist, kannst du hier die Aufteilung festlegen.</div>`;
    return `<div class="splitbox">${S.users.map((u, i) => `<label>${esc(u.display_name)} (%)<input type="number" min="0" max="100" step="1" data-split="${prefix}" data-uid="${u.id}" data-idx="${i}" value="${Math.round(num(sp[u.id]) * 100) / 100}"></label>`).join('')}
      ${S.users.length === 2 ? `<input type="range" min="0" max="100" step="5" data-splitrange="${prefix}" value="${num(sp[S.users[0].id])}" class="full">` : ''}</div>`;
  }
  function readSplit(prefix) {
    const out = {}; let sum = 0;
    document.querySelectorAll(`[data-split="${prefix}"]`).forEach((i) => { const v = Number(i.value); out[i.dataset.uid] = v; sum += v; });
    return { out, sum };
  }

  function viewSettings() {
    return `<div class="grid settings">
      <div class="card"><h2>Aufteilung &amp; Reserve</h2>
        <form id="setForm">
          <div class="small muted" style="font-weight:500">Standardaufteilung geleisteter Zahlungen</div>
          ${splitInputs(defaultSplit(), 'def')}
          <div class="muted small">Gilt für alle Positionen ohne eigene Aufteilung. Pro Position änderbar im Bearbeiten-Dialog.</div>
          <label style="margin-top:8px">Reserve für Unvorhergesehenes (%)<input name="reserve" type="number" min="0" max="100" step="0.5" value="${Math.round(num(S.settings.reserve_rate) * 1000) / 10}"></label>
          <button type="submit" class="primary">Speichern</button>
        </form>
        <div class="err" id="setErr"></div><div class="okmsg" id="setOk"></div>
      </div>
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
      <div class="card"><h2>Import &amp; Export</h2>
        <form id="impForm">
          <label>Kassensturz-Importdatei (.json)<input type="file" name="file" accept="application/json,.json" required></label>
          <label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" name="replace" checked style="width:auto"> Leere Bereiche ohne Positionen vorher entfernen</label>
          <button type="submit" class="primary">Importieren</button>
        </form>
        <div class="err" id="impErr"></div><div class="okmsg" id="impOk"></div>
        <div class="muted small" style="margin-top:10px">Ein erneuter Import derselben Datei aktualisiert die Positionen statt sie zu verdoppeln. Vorher wird automatisch ein Backup angelegt.</div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><a class="btn" href="/api/export.json">Alles als JSON exportieren</a><a class="btn" href="/api/export.csv">Positionen als CSV</a></div>
      </div>
      <div class="card"><h2>Backups</h2>
        <div class="muted small">Automatisch vor jedem Update, vor jedem Import und einmal täglich. Die Belege liegen als Dateien im Datenordner und werden über Hyper Backup mitgesichert.</div>
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

  // ---------- Dialog Position ----------
  function openModal(html) { $('#dlg').innerHTML = html; $('#modal').classList.add('open'); const f = $('#dlg input'); if (f) f.focus(); }
  function closeModal() { $('#modal').classList.remove('open'); $('#dlg').innerHTML = ''; if (pendingRender) render(); }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modal').classList.contains('open')) closeModal(); });

  function expenseDialog(id) {
    const e = id ? S.expenses.find((x) => x.id === id) : null;
    if (id && !e) return;
    const d = e || { status: 'geplant', included: 'nein', date: '', category_id: filt.cat && filt.cat !== NOCAT ? Number(filt.cat) : null, attachments: [], split: null };
    const custom = !!d.split;
    openModal(`<h2>${e ? 'Position bearbeiten' : 'Position anlegen'}</h2>
      <form id="expForm" class="form">
        <label>Nr<input name="code" value="${esc(d.code || '')}" placeholder="z. B. A18"></label>
        <label>Bereich<select name="category_id"><option value="">Ohne Kategorie</option>${S.categories.map((c) => `<option value="${c.id}" ${d.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label class="full">Kostenpunkt *<input name="title" required value="${esc(d.title || '')}"></label>
        <label>Im Hauspreis?<select name="included">${INCL.map((s) => `<option value="${s.k}" ${d.included === s.k ? 'selected' : ''}>${s.l} – ${s.h}</option>`).join('')}</select></label>
        <label>Status<select name="status">${STATUS.map((s) => `<option value="${s.k}" ${d.status === s.k ? 'selected' : ''}>${s.l} – ${s.h}</option>`).join('')}</select></label>
        <label>Schätzung (€)<input name="estimate" inputmode="decimal" value="${esc(amtInput(d.estimate))}" placeholder="z. B. 5.000"></label>
        <label>Angebot / Ist (€)<input name="amount" inputmode="decimal" value="${esc(amtInput(d.amount))}" placeholder="leer = noch keins"></label>
        <label>Firma / Anbieter<input name="vendor" value="${esc(d.vendor || '')}"></label>
        <label>Datum<input type="date" name="date" value="${esc(d.date || '')}"></label>
        <label>Fällig am<input type="date" name="due" value="${esc(d.due || '')}"></label>
        <label class="full">Hinweis<textarea name="hint" rows="2">${esc(d.hint || '')}</textarea></label>
        <label class="full">Info / Notiz (Links werden klickbar)<textarea name="note" rows="2">${esc(d.note || '')}</textarea></label>
        ${S.users.length > 1 ? `<div class="full">
          <div class="small muted" style="font-weight:500;margin-bottom:4px">Aufteilung der Zahlung</div>
          <label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="splitDefault" ${custom ? '' : 'checked'} style="width:auto"> Standardaufteilung verwenden (${splitLabel(defaultSplit())})</label>
          <div id="splitCustom" ${custom ? '' : 'hidden'}>${splitInputs(splitOf(d), 'exp')}</div>
        </div>` : ''}
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
    if ($('#splitDefault')) $('#splitDefault').onchange = (ev) => { $('#splitCustom').hidden = ev.target.checked; };
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
      const title = String(f.get('title') || '').trim();
      const est = String(f.get('estimate') || '').trim(), amt = String(f.get('amount') || '').trim();
      const estimate = est ? parseAmount(est) : null, amount = amt ? parseAmount(amt) : null;
      if (!title) { $('#expErr').textContent = 'Bitte einen Kostenpunkt eingeben.'; return; }
      if ((est && !Number.isFinite(estimate)) || (amt && !Number.isFinite(amount))) { $('#expErr').textContent = 'Betrag nicht erkannt (z. B. 12.500,00).'; return; }
      if (estimate == null && amount == null) { $('#expErr').textContent = 'Bitte Schätzung oder Angebot/Ist angeben.'; return; }
      let split = null;
      if ($('#splitDefault') && !$('#splitDefault').checked) {
        const r = readSplit('exp');
        if (Math.abs(r.sum - 100) > 0.5) { $('#expErr').textContent = `Die Aufteilung ergibt ${pct.format(r.sum)} % – sie muss 100 % ergeben.`; return; }
        split = r.out;
      }
      const body = {
        code: f.get('code'), title, estimate, amount, status: f.get('status'), included: f.get('included'),
        category_id: f.get('category_id') ? Number(f.get('category_id')) : null,
        vendor: f.get('vendor'), date: f.get('date'), due: f.get('due'), hint: f.get('hint'), note: f.get('note'), split,
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
    if (t.closest('a')) return; // Links in Zeilen öffnen, nicht den Dialog
    const row = t.closest('[data-edit]'); if (row) { expenseDialog(Number(row.dataset.edit)); return; }
    try {
      if (t.id === 'addExp') { expenseDialog(null); return; }
      if (t.id === 'addCat') { await mutate('POST', '/api/categories', { name: 'Neuer Bereich', budget: 0 }); return; }
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

  // Aufteilung: bei zwei Personen ergänzt sich der andere Wert automatisch
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.dataset.splitrange) {
      const ins = document.querySelectorAll(`[data-split="${t.dataset.splitrange}"]`);
      ins[0].value = t.value; ins[1].value = 100 - Number(t.value);
      return;
    }
    if (t.dataset.split && S.users.length === 2) {
      const ins = document.querySelectorAll(`[data-split="${t.dataset.split}"]`);
      const other = ins[t.dataset.idx === '0' ? 1 : 0];
      const v = Math.min(100, Math.max(0, Number(t.value) || 0));
      other.value = Math.round((100 - v) * 100) / 100;
      const range = document.querySelector(`[data-splitrange="${t.dataset.split}"]`);
      if (range) range.value = ins[0].value;
      return;
    }
    if (t.id === 'fq') {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        filt.q = t.value; const pos = t.selectionStart; render();
        const n = $('#fq'); if (n) { n.focus(); n.setSelectionRange(pos, pos); }
      }, 200);
    }
  });
  let qTimer;

  document.addEventListener('change', async (ev) => {
    const t = ev.target;
    if (t.id === 'fcat') { filt.cat = t.value; render(); return; }
    if (t.id === 'fst') { filt.st = t.value; render(); return; }
    if (t.id === 'finc') { filt.inc = t.value; render(); return; }
    if (t.dataset.cat) {
      const c = S.categories.find((x) => x.id === Number(t.dataset.cat)); if (!c) return;
      let v = t.value;
      if (t.dataset.f === 'reserve') v = t.checked;
      else if (t.dataset.f === 'budget') { v = v.trim() === '' ? 0 : parseAmount(v); if (!Number.isFinite(v)) { $('#catErr').textContent = 'Betrag nicht erkannt.'; return; } }
      else { v = v.trim(); if (!v) return; }
      if (t.dataset.f !== 'reserve' && c[t.dataset.f] === v) return;
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
    if (f.id === 'setForm') {
      ev.preventDefault();
      $('#setErr').textContent = ''; $('#setOk').textContent = '';
      const body = { reserve_rate: Number(new FormData(f).get('reserve')) / 100 };
      if (S.users.length > 1) {
        const r = readSplit('def');
        if (Math.abs(r.sum - 100) > 0.5) { $('#setErr').textContent = `Die Aufteilung ergibt ${pct.format(r.sum)} % – sie muss 100 % ergeben.`; return; }
        body.default_split = r.out;
      }
      try { await mutate('PUT', '/api/settings', body); const ok = $('#setOk'); if (ok) ok.textContent = 'Gespeichert.'; }
      catch (e) { $('#setErr').textContent = e.message; }
      return;
    }
    if (f.id === 'impForm') {
      ev.preventDefault();
      $('#impErr').textContent = ''; $('#impOk').textContent = '';
      const file = f.querySelector('input[type=file]').files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        data.replace_empty_categories = f.querySelector('[name=replace]').checked;
        const r = await api('POST', '/api/import', new Blob([JSON.stringify(data)], { type: 'application/json' }), { 'Content-Type': 'application/json' });
        await load();
        const ok = $('#impOk');
        if (ok) ok.textContent = `Import fertig: ${r.positions_created} Positionen neu, ${r.positions_updated} aktualisiert, ${r.categories_created} Bereiche angelegt, ${r.categories_removed} leere entfernt.`;
      } catch (e) { const el = $('#impErr'); if (el) el.textContent = e instanceof SyntaxError ? 'Die Datei ist kein gültiges JSON.' : e.message; }
      return;
    }
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

  document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.matches('.edit-table input')) ev.target.blur(); });

  // ---------- Routing ----------
  function route() {
    let h = location.hash.replace('#', '');
    if (h === 'ausgaben') h = 'kosten';
    tab = TABS.includes(h) ? h : 'uebersicht'; render();
  }
  window.addEventListener('hashchange', route);

  start();
})();
