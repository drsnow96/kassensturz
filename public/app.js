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
  const TABS = ['uebersicht', 'kosten', 'budget', 'finanzierung', 'planung', 'einstellungen'];
  const PLAN_TABS = ['szenarien', 'leistungsbeschreibung', 'gewaehrleistung'];
  let planTab = 'szenarien';

  let S = { categories: [], expenses: [], sources: [], users: [], me: null, rev: 0, version: '', settings: { reserve_rate: 0.1, default_split: null } };
  let tab = 'uebersicht';
  const filt = { q: '', cat: '', st: '', inc: '' };
  let pendingRender = false;
  let filtOpen = false;

  // Layout: Handy (schmal) oder PC – wird live umgeschaltet, z. B. beim Drehen des Tablets
  const mq = window.matchMedia('(max-width: 760px)');
  let mobile = mq.matches;
  document.body.classList.toggle('mobile', mobile);
  mq.addEventListener('change', () => { mobile = mq.matches; document.body.classList.toggle('mobile', mobile); render(); });

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
  const fmtIn = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });
  const fmtIn2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const amtInput = (n) => (has(n) && Number.isFinite(Number(n)) ? (Number(n) % 1 ? fmtIn2 : fmtIn).format(Number(n)) : '');
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

  // Aufteilung der Zahlungen: {mode: 'pct'|'eur', values: {userId: Zahl}}
  function normSplit(sp) {
    if (!sp || typeof sp !== 'object') return null;
    if (sp.mode) return { mode: sp.mode === 'eur' ? 'eur' : 'pct', values: sp.values || {} };
    return { mode: 'pct', values: sp }; // altes Format {userId: Prozent}
  }
  function defaultSplit() {
    const ids = S.users.map((u) => u.id);
    const d = normSplit(S.settings.default_split);
    if (d && d.mode === 'pct' && ids.length && ids.every((id) => d.values[id] != null)) {
      const sum = ids.reduce((x, id) => x + num(d.values[id]), 0);
      if (Math.abs(sum - 100) < 0.6) return { mode: 'pct', values: Object.fromEntries(ids.map((id) => [id, num(d.values[id])])) };
    }
    return { mode: 'pct', values: Object.fromEntries(ids.map((id) => [id, ids.length ? 100 / ids.length : 0])) };
  }
  function splitOf(x) {
    const n = normSplit(x && x.split);
    if (!n) return defaultSplit();
    return { mode: n.mode, values: Object.fromEntries(S.users.map((u) => [u.id, num(n.values[u.id])])) };
  }
  /** Euro-Anteile je Person für einen Gesamtbetrag */
  function shareAmounts(sp, total) {
    const out = {};
    if (sp.mode === 'eur') {
      const sum = S.users.reduce((x, u) => x + num(sp.values[u.id]), 0);
      const f = sum > 0 && total > 0 && Math.abs(sum - total) > 0.5 ? total / sum : 1;
      S.users.forEach((u) => { out[u.id] = num(sp.values[u.id]) * f; });
    } else S.users.forEach((u) => { out[u.id] = total * num(sp.values[u.id]) / 100; });
    return out;
  }
  const splitLabel = (sp) => (sp.mode === 'eur'
    ? S.users.map((u) => fmt0.format(num(sp.values[u.id]))).join(' / ')
    : S.users.map((u) => pct.format(num(sp.values[u.id]))).join(' : ') + ' %');
  function paidByUser() {
    const out = Object.fromEntries(S.users.map((u) => [u.id, 0]));
    let total = 0;
    S.expenses.filter((e) => e.status === 'bezahlt' && counts(e)).forEach((e) => {
      const c = cost(e); total += c;
      const sh = shareAmounts(splitOf(e), c);
      S.users.forEach((u) => { out[u.id] += sh[u.id]; });
    });
    return { out, total };
  }

  // ---------- Darlehen ----------
  function parseMonth(v) {
    const t = String(v || '').trim(); let m;
    if (!t) return '';
    if ((m = t.match(/^(\d{4})-(\d{1,2})$/))) return `${m[1]}-${m[2].padStart(2, '0')}`;
    if ((m = t.match(/^(\d{1,2})[./-](\d{4})$/))) return `${m[2]}-${m[1].padStart(2, '0')}`;
    return null;
  }
  const fmonth = (ym) => (ym ? `${ym.slice(5, 7)}.${ym.slice(0, 4)}` : '');
  const ymIndex = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
  const ymFrom = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const parseNum = (v) => { const t = String(v == null ? '' : v).trim(); if (!t) return null; const n = Number(t.replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
  const fpct = (n) => pct.format(n) + ' %';
  function dur(months) { const y = Math.floor(months / 12), m = months % 12; return [y ? y + ' J.' : '', m ? m + ' Mon.' : ''].filter(Boolean).join(' ') || '0 Mon.'; }

  /** Annuitäten-Tilgungsplan, Monat für Monat (Zinsen = Restschuld × Sollzins/12) */
  function loanPlan(s) {
    const P = num(s.amount), i = num(s.interest) / 100 / 12, R = num(s.rate), g = num(s.grace_months);
    if (!(P > 0) || !(R > 0)) return null;
    const rows = []; let rest = P, stuck = false;
    for (let m = 0; rest > 0.005 && m < 600; m++) {
      const zins = rest * i;
      let pay;
      if (m < g) pay = zins;
      else { if (R <= zins + 0.005) stuck = true; pay = Math.min(R, rest + zins); }
      const tilg = pay - zins;
      rest = Math.max(0, rest - tilg);
      rows.push({ m, zins, tilg, pay, rest });
      if (stuck && m > g + 1) break;
    }
    const start = s.start || '';
    const elapsed = start ? Math.max(0, Math.min(rows.length, ymIndex(thisMonth()) - ymIndex(start) + 1)) : 0;
    const sum = (arr, k) => arr.reduce((x, r) => x + r[k], 0);
    const done = rows.slice(0, elapsed);
    const nFix = s.fixed_years ? Math.min(rows.length, s.fixed_years * 12) : 0;
    const fix = nFix ? rows.slice(0, nFix) : null;
    return {
      rows, stuck, start, elapsed,
      initialTilgung: P ? ((R - P * i) * 12 / P) * 100 : 0,
      paid: sum(done, 'pay'), zinsPaid: sum(done, 'zins'), tilgPaid: sum(done, 'tilg'),
      restToday: elapsed ? rows[elapsed - 1].rest : P,
      fixEnd: fix ? { months: nFix, rest: rows[nFix - 1].rest, zins: sum(fix, 'zins'), tilg: sum(fix, 'tilg'), ym: start ? ymFrom(ymIndex(start) + nFix - 1) : '' } : null,
      payoff: stuck ? null : { months: rows.length, ym: start ? ymFrom(ymIndex(start) + rows.length - 1) : '' },
      zinsTotal: sum(rows, 'zins'),
    };
  }
  function loans() { return S.sources.filter((x) => x.kind === 'darlehen'); }
  /** Eigenkapital und Sonstiges: wer bringt wie viel ein */
  function equityByUser() {
    const out = Object.fromEntries(S.users.map((u) => [u.id, 0]));
    let total = 0;
    S.sources.filter((x) => x.kind !== 'darlehen').forEach((x) => {
      const a = num(x.amount); total += a;
      const sh = shareAmounts(splitOf(x), a);
      S.users.forEach((u) => { out[u.id] += sh[u.id]; });
    });
    return { out, total };
  }
  function loanTotals() {
    const t = { rate: 0, restToday: 0, zinsPaid: 0, tilgPaid: 0, paid: 0, perUser: Object.fromEntries(S.users.map((u) => [u.id, { rate: 0, paid: 0, zins: 0, tilg: 0 }])) };
    loans().forEach((s) => {
      const R = num(s.rate);
      const pl = loanPlan(s);
      t.rate += R;
      t.restToday += pl ? pl.restToday : num(s.amount);
      if (!pl) return;
      t.zinsPaid += pl.zinsPaid; t.tilgPaid += pl.tilgPaid; t.paid += pl.paid;
      const sh = shareAmounts(splitOf(s), R);
      S.users.forEach((u) => {
        const f = R ? sh[u.id] / R : 0;
        const p = t.perUser[u.id];
        p.rate += sh[u.id]; p.paid += pl.paid * f; p.zins += pl.zinsPaid * f; p.tilg += pl.tilgPaid * f;
      });
    });
    return t;
  }

  // ---------- Rendering ----------
  function render() {
    if ($('#modal').classList.contains('open')) { pendingRender = true; return; }
    // Fokus und gerade getippten Wert über das Neuzeichnen hinweg erhalten
    const ae = document.activeElement;
    let keep = null;
    if (ae && ae.closest && ae.closest('[data-live]')) {
      const d = ae.dataset;
      const key = d.src ? `[data-src="${d.src}"][data-f="${d.f}"]` : d.cat ? `[data-cat="${d.cat}"][data-f="${d.f}"]`
        : d.split ? `[data-split="${d.split}"][data-uid="${d.uid}"]` : null;
      if (!key && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) { pendingRender = true; return; }
      if (key) keep = { key, value: ae.value, dirty: 'defaultValue' in ae && ae.value !== ae.defaultValue, start: ae.selectionStart, end: ae.selectionEnd };
    }
    pendingRender = false;
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    const nIn = (S.inbox || []).length; const kb = document.querySelector('#tabs a[data-tab=kosten] span'); if (kb) kb.innerHTML = 'Kosten' + (nIn ? ` <b class="badge">${nIn}</b>` : '');
    const v = $('#view');
    if (tab === 'kosten') v.innerHTML = mobile ? viewCostsMobile() : viewCosts();
    else if (tab === 'budget') v.innerHTML = mobile ? viewBudgetMobile() : viewBudget();
    else if (tab === 'finanzierung') v.innerHTML = viewFinance();
    else if (tab === 'planung') v.innerHTML = viewPlanning();
    else if (tab === 'einstellungen') { v.innerHTML = viewSettings(); loadBackups(); }
    else v.innerHTML = viewOverview();
    if (keep) {
      const n = document.querySelector(keep.key);
      if (n) {
        if (keep.dirty && n.tagName === 'INPUT' && n.type !== 'checkbox') n.value = keep.value;
        n.focus({ preventScroll: true });
        try { if (keep.start != null) n.setSelectionRange(keep.start, keep.end); } catch (e) { /* nicht jeder Typ */ }
      }
    }
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
    html += deadlinesCard();

    // Wer hat gezahlt
    if (S.users.length) {
      const { out, total } = paidByUser();
      const target = defaultSplit().values;
      const lt = loanTotals();
      const hasLoans = loans().some((x) => num(x.rate) > 0);
      const eqU = equityByUser();
      html += `<div class="card"><h2>Gezahlt nach Person</h2><table><tbody>${S.users.map((u) => {
        const diff = out[u.id] - total * num(target[u.id]) / 100;
        const lu = lt.perUser[u.id];
        return `<tr><td>${esc(u.display_name)}<div class="muted small">Soll ${pct.format(num(target[u.id]))} %</div>
            ${eqU.total ? `<div class="muted small">Eigenkapital ${fmt0.format(eqU.out[u.id])}</div>` : ''}
            ${hasLoans ? `<div class="muted small">Kreditrate ${fmt0.format(lu.rate)} / Monat</div>` : ''}</td>
          <td class="num">${fmt0.format(out[u.id])}
          ${S.users.length > 1 && Math.abs(diff) >= 1 ? `<div class="small ${diff > 0 ? 'pos' : 'neg'}">${diff > 0 ? '+' : '−'}${fmt0.format(Math.abs(diff))} ggü. Soll</div>` : ''}
          ${hasLoans && lu.paid ? `<div class="muted small">+ ${fmt0.format(lu.paid)} Raten</div>` : ''}</td></tr>`;
      }).join('')}</tbody><tfoot><tr><td>Bezahlt gesamt (Positionen)</td><td class="num">${fmt0.format(total)}</td></tr>
        ${hasLoans ? `<tr><td>Kreditraten bisher</td><td class="num">${fmt0.format(lt.paid)}</td></tr>` : ''}</tfoot></table></div>`;
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
      ${ocrOn() ? '<button id="scanDoc" title="PDF oder Foto einer Rechnung bzw. eines Angebots – oder Datei hierher ziehen">📄 Beleg erfassen</button>' : ''}
      <button class="primary" id="addExp">+ Position</button>
    </div>`;
    html += inboxCard();
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

  // ---------- Mobile Ansichten ----------
  function filterBar() {
    const active = [filt.cat, filt.inc, filt.st].filter(Boolean).length;
    const catOpts = S.categories.map((c) => `<option value="${c.id}" ${filt.cat === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    return `<div class="toolbar">
        <input id="fq" type="search" placeholder="Suchen …" value="${esc(filt.q)}">
        <button id="filtToggle" ${active ? 'class="primary"' : ''}>Filter${active ? ' (' + active + ')' : ''}</button>
        ${ocrOn() ? '<button id="scanDoc">📄 Beleg</button>' : ''}
      </div>
      ${filtOpen ? `<div class="filterpanel">
        <select id="fcat"><option value="">Alle Bereiche</option>${catOpts}<option value="${NOCAT}" ${filt.cat === NOCAT ? 'selected' : ''}>Ohne Kategorie</option></select>
        <select id="finc"><option value="">Im Hauspreis: alle</option>${INCL.map((x) => `<option value="${x.k}" ${filt.inc === x.k ? 'selected' : ''}>Im Hauspreis: ${x.l}</option>`).join('')}</select>
        <select id="fst"><option value="">Alle Status</option>${STATUS.map((x) => `<option value="${x.k}" ${filt.st === x.k ? 'selected' : ''}>${x.l}</option>`).join('')}</select>
        ${active ? '<button id="filtReset">Filter zurücksetzen</button>' : ''}
      </div>` : ''}`;
  }

  function costCard(e) {
    const diff = has(e.amount) && has(e.estimate) ? num(e.amount) - num(e.estimate) : null;
    return `<div class="mcard click${counts(e) ? '' : ' dim'}" data-edit="${e.id}">
      <div class="top"><span class="code">${esc(e.code)}</span><span class="ttl">${esc(e.title)}</span>${e.attachments.length ? `<span class="clip">📎 ${e.attachments.length}</span>` : ''}</div>
      ${e.hint ? `<div class="hint">${esc(e.hint)}</div>` : ''}
      <div class="chips"><span class="chip s-${esc(e.status)}">${SL[e.status] || esc(e.status)}</span><span class="chip i-${e.included}">Im Hauspreis: ${IL[e.included]}</span>
        ${e.status === 'beauftragt' && e.due ? `<span class="small muted">fällig ${fdate(e.due)}</span>` : ''}</div>
      <div class="amts">
        <div><small>Schätzung</small>${has(e.estimate) ? fmt0.format(num(e.estimate)) : '–'}</div>
        <div><small>Angebot / Ist</small>${has(e.amount) ? fmt0.format(num(e.amount)) : '–'}</div>
        <div><small>Differenz</small><span class="${diff > 0 ? 'neg' : diff < 0 ? 'pos' : ''}">${diff ? (diff > 0 ? '+' : '') + fmt0.format(diff) : '–'}</span></div>
      </div>
    </div>`;
  }

  function viewCostsMobile() {
    let html = inboxCard() + filterBar();
    const groups = S.categories.map((c) => ({ id: c.id, name: c.name, items: S.expenses.filter((e) => e.category_id === c.id) }));
    const orphan = S.expenses.filter((e) => !catOf(e.category_id));
    if (orphan.length) groups.push({ id: NOCAT, name: 'Ohne Kategorie', items: orphan });
    const searching = filt.q || filt.cat || filt.inc || filt.st;
    let any = false; const all = [];
    groups.forEach((g) => {
      const items = g.items.filter(matches).sort(byCode);
      if (!items.length) return;
      any = true; all.push(...items);
      const t = totals(items);
      const open = searching || openGroups.has(String(g.id));
      html += `<details class="mgroup" data-group="${g.id}" ${open ? 'open' : ''}><summary><span class="nm">${esc(g.name)} <span class="cnt">${items.length}</span></span><span class="sum">${fmt0.format(t.prognose)}</span></summary>
        ${items.map(costCard).join('')}</details>`;
    });
    if (!any) html += `<div class="empty">${S.expenses.length ? 'Keine Treffer für diesen Filter.' : 'Noch keine Positionen. Lege eine an oder importiere eure Kostenübersicht unter „Mehr“.'}</div>`;
    else {
      const t = totals(all);
      html += `<div class="card">
        <div class="mtotal"><span>Prognose</span><span>${fmt0.format(t.prognose)}</span></div>
        <div class="mtotal"><span>Reserve ${rr()}</span><span>${fmt0.format(t.reserve)}</span></div>
        <div class="mtotal b"><span>Gesamtbudget</span><span>${fmt0.format(t.gesamt)}</span></div>
        <div class="mtotal muted"><span>„Prüfen“, nicht enthalten</span><span>${fmt0.format(t.pruefen)}</span></div>
      </div>`;
    }
    return html + `<button class="fab" id="addExp" aria-label="Position anlegen">+</button>`;
  }
  const openGroups = new Set();
  document.addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (d.classList && d.classList.contains('mgroup')) { if (d.open) openGroups.add(d.dataset.group); else openGroups.delete(d.dataset.group); }
    if (d.classList && d.classList.contains('plan')) { if (d.open) openPlans.add(d.dataset.plan); else openPlans.delete(d.dataset.plan); }
  }, true);

  function viewBudgetMobile() {
    const rows = catStats();
    const t = totals(S.expenses);
    let html = `<div class="muted small" style="margin-bottom:10px">Schätzung aus den Positionen, optional ein eigener Budgetrahmen. Änderungen werden beim Verlassen des Feldes gespeichert.</div><div data-live>`;
    rows.forEach((r) => {
      const ref = r.budget || r.schaetzung;
      const rest = ref - r.prognose;
      const stats = `<div class="mstats">
          <div><small>Schätzung</small>${fmt0.format(r.schaetzung)}</div>
          <div><small>Angebot / Ist</small>${r.ist ? fmt0.format(r.ist) : '–'}</div>
          <div><small>Prognose</small>${fmt0.format(r.prognose)}</div>
          <div><small>Rest</small><span class="${rest < -0.5 ? 'neg' : ''}">${ref ? fmt0.format(rest) : '–'}</span></div>
        </div>`;
      if (r.id === NOCAT) { html += `<div class="mcard"><div class="ttl muted">Ohne Kategorie</div>${stats}</div>`; return; }
      html += `<div class="mcard">
        <input data-cat="${r.id}" data-f="name" value="${esc(r.name)}" style="width:100%;font-weight:600">
        ${stats}
        <label class="mfield">Budgetrahmen (optional)<input data-cat="${r.id}" data-f="budget" inputmode="decimal" value="${esc(r.budget ? amtInput(r.budget) : '')}" placeholder="optional"></label>
        <div class="mrow" style="margin-top:10px">
          <label class="mrow small muted" style="flex:1"><input type="checkbox" data-cat="${r.id}" data-f="reserve" ${r.reserve ? 'checked' : ''} style="width:22px;height:22px;min-height:0"> Reserve einrechnen</label>
          <button class="iconbtn" data-delcat="${r.id}" title="Bereich löschen">Löschen</button>
        </div>
      </div>`;
    });
    html += `</div><button class="primary" id="addCat" style="width:100%">+ Bereich</button>
      <div class="err" id="catErr"></div>
      <div class="card" style="margin-top:12px">
        <div class="mtotal"><span>Prognose</span><span>${fmt0.format(t.prognose)}</span></div>
        <div class="mtotal"><span>Reserve ${rr()}</span><span>${fmt0.format(t.reserve)}</span></div>
        <div class="mtotal b"><span>Gesamtbudget</span><span>${fmt0.format(t.gesamt)}</span></div>
      </div>`;
    return html;
  }

  function viewFinance() {
    const ft = finTotal();
    const t = totals(S.expenses);
    const gap = ft - t.gesamt;
    const maxv = Math.max(ft, t.worst, 1);
    const lt = loanTotals();
    const hasLoans = loans().length > 0;
    let html = `<div class="grid kpis">
      ${kpi('Finanzierung gesamt', fmt0.format(ft))}
      ${kpi('Bedarf', fmt0.format(t.gesamt), 'Gesamtbudget inkl. Reserve')}
      ${kpi(gap < 0 ? 'Finanzierungslücke' : 'Puffer', fmt0.format(Math.abs(gap)), '', gap < 0 ? 'neg' : 'pos')}
      ${kpi('Puffer im Worst Case', fmt0.format(ft - t.worst), '', ft - t.worst < 0 ? 'neg' : 'pos')}
      ${hasLoans ? kpi('Monatliche Rate', fmt0.format(lt.rate), 'alle Darlehen') : ''}
      ${hasLoans ? kpi('Restschuld heute', fmt0.format(lt.restToday), `Zinsen bisher ${fmt0.format(lt.zinsPaid)} · Tilgung ${fmt0.format(lt.tilgPaid)}`) : ''}
    </div>
    ${S.users.length ? personSpending(lt, hasLoans) : ''}
    <div class="card" style="margin-top:14px"><h2>Finanzierung vs. Bedarf</h2>
      <div class="small muted">Finanzierung</div><div class="finbar"><div style="width:${((ft / maxv) * 100).toFixed(1)}%;background:var(--paid)"></div></div>
      <div class="small muted">Bedarf (Gesamtbudget)</div><div class="finbar"><div style="width:${((t.gesamt / maxv) * 100).toFixed(1)}%;background:var(--comm)"></div></div>
      <div class="small muted">Worst Case</div><div class="finbar"><div style="width:${((t.worst / maxv) * 100).toFixed(1)}%;background:var(--offer)"></div></div>
    </div>
`;
    html += `<div class="toolbar" style="margin-top:18px"><h2 style="margin:0">Finanzierungsbausteine</h2><span class="spacer"></span>
      <button class="primary" id="addSrc">+ Baustein</button></div>
    <div class="err" id="finErr"></div>
    ${sourceList()}
    <div class="note"><b>KfW 297 „Klimafreundlicher Neubau“ (selbstgenutzt):</b> Kredit bis 100.000 € je Wohneinheit, mit QNG-Nachhaltigkeitssiegel bis 150.000 €, oft mit tilgungsfreien Anlaufjahren. Konditionen ändern sich regelmäßig – aktuellen Zinssatz bei der Hausbank bzw. auf kfw.de/297 prüfen.</div>`;
    return html;
  }

  /** Wer hat wie viel für das Projekt ausgegeben? Bezahlte Positionen + gezahlte Kreditraten, dazu Eigenkapital */
  function personSpending(lt, hasLoans) {
    const pos = paidByUser();
    const eq = equityByUser();
    const rows = S.users.map((u) => {
      const l = lt.perUser[u.id];
      return { u, pos: pos.out[u.id], raten: l.paid, zins: l.zins, tilg: l.tilg, spent: pos.out[u.id] + l.paid, eq: eq.out[u.id], rate: l.rate };
    });
    const total = rows.reduce((x, r) => x + r.spent, 0);
    const colors = ['var(--paid)', 'var(--opt)', 'var(--comm)', 'var(--warn)'];
    const line = (l, v, cls = '') => `<div class="pline ${cls}"><span>${l}</span><span>${v}</span></div>`;
    let html = `<div class="card" style="margin-top:14px"><div class="mrow" style="align-items:baseline"><h2 style="flex:1;margin-bottom:8px">Wer hat wie viel ausgegeben?</h2><span class="strong">${fmt0.format(total)}</span></div>`;
    if (total > 0 && rows.length > 1) {
      html += `<div class="sharebar">${rows.map((r, i) => `<div style="width:${((r.spent / total) * 100).toFixed(2)}%;background:${colors[i % colors.length]}" title="${esc(r.u.display_name)}"></div>`).join('')}</div>`;
    }
    html += `<div class="persongrid">${rows.map((r, i) => `<div class="person">
        <div class="phead"><i style="background:${colors[i % colors.length]}"></i><span class="ttl">${esc(r.u.display_name)}</span>
          <span class="strong">${fmt0.format(r.spent)}</span><span class="muted small">${total ? pct.format((r.spent / total) * 100) + ' %' : ''}</span></div>
        ${line('Bezahlte Positionen', fmt0.format(r.pos))}
        ${hasLoans ? line('Kreditraten bisher', fmt0.format(r.raten)) + line('davon Zinsen / Tilgung', `${fmt0.format(r.zins)} / ${fmt0.format(r.tilg)}`, 'muted') : ''}
        <div class="psep"></div>
        ${line('Eigenkapital eingebracht', fmt0.format(r.eq))}
        ${hasLoans ? line('Kreditrate pro Monat', fmt0.format(r.rate)) : ''}
      </div>`).join('')}</div>
      <div class="muted small" style="margin-top:8px">Ausgegeben = bezahlte Positionen (nach ihrer Aufteilung) + gezahlte Kreditraten${hasLoans ? ' (Annahme: pünktlich ab der ersten Rate)' : ''}. Das Eigenkapital ist separat aufgeführt.</div></div>`;
    return html;
  }

  const KINDS = [{ k: 'eigen', l: 'Eigenkapital' }, { k: 'darlehen', l: 'Darlehen' }, { k: 'sonstig', l: 'Sonstiges' }];
  const KL = Object.fromEntries(KINDS.map((k) => [k.k, k.l]));
  const openLoans = new Set();
  const openPlans = new Set();

  /** Liste aller Finanzierungsbausteine (PC: Tabelle, Handy: kompakte Zeilen) */
  function sourceList() {
    if (!S.sources.length) return `<div class="card"><div class="empty">Noch keine Finanzierungsbausteine. Lege Eigenkapital oder ein Darlehen an.</div></div>`;
    const info = S.sources.map((src) => {
      const isLoan = src.kind === 'darlehen';
      const pl = isLoan ? loanPlan(src) : null;
      const ref = isLoan ? num(src.rate) : num(src.amount);
      return { src, isLoan, pl, split: S.users.length > 1 ? (src.split ? splitLabel(splitOf(src)) : 'Standard') : '', rest: isLoan ? (pl ? pl.restToday : num(src.amount)) : null, ref };
    });
    const sumA = info.reduce((x, i) => x + num(i.src.amount), 0);
    const sumR = info.reduce((x, i) => x + (i.isLoan ? num(i.src.rate) : 0), 0);
    const sumRest = info.reduce((x, i) => x + (i.isLoan ? i.rest : 0), 0);
    if (mobile) {
      return info.map((i) => `<div class="mcard srcrow" data-editsrc="${i.src.id}">
          <div class="top"><span class="ttl">${esc(i.src.name)}</span><span class="chip k-${i.src.kind}">${KL[i.src.kind]}</span></div>
          ${i.src.note ? `<div class="hint">${esc(i.src.note)}</div>` : ''}
          <div class="amts">
            <div><small>${i.isLoan ? 'Darlehen' : 'Betrag'}</small>${fmt0.format(num(i.src.amount))}</div>
            <div><small>${i.isLoan ? 'Rate / Monat' : 'Aufteilung'}</small>${i.isLoan ? (i.src.rate ? fmt0.format(num(i.src.rate)) : '–') : esc(i.split || '–')}</div>
            <div><small>${i.isLoan ? 'Restschuld' : ''}</small>${i.isLoan ? fmt0.format(i.rest) : ''}</div>
          </div>
          ${i.isLoan && i.pl ? `<button class="iconbtn linkbtn" data-loandetail="${i.src.id}">${openLoans.has(String(i.src.id)) ? 'Details ausblenden' : 'Zinsen, Tilgung, Tilgungsplan'}</button>
            ${openLoans.has(String(i.src.id)) ? `<div class="loanbox">${loanStats(i.src, i.pl)}</div>` : ''}` : ''}
        </div>`).join('')
        + `<div class="card"><div class="mtotal"><span>Summe Bausteine</span><span>${fmt0.format(sumA)}</span></div>
           ${sumR ? `<div class="mtotal"><span>Raten pro Monat</span><span>${fmt0.format(sumR)}</span></div><div class="mtotal b"><span>Restschuld heute</span><span>${fmt0.format(sumRest)}</span></div>` : ''}</div>`;
    }
    return `<div class="card" style="padding:4px 8px;overflow-x:auto"><table class="srctable"><thead><tr>
        <th>Baustein</th><th>Art</th><th class="num">Betrag</th><th class="num">Sollzins</th><th class="num">Rate / Monat</th><th class="num">Restschuld heute</th>${S.users.length > 1 ? '<th>Aufteilung</th>' : ''}<th></th></tr></thead><tbody>
      ${info.map((i) => {
        const open = i.isLoan && i.pl && openLoans.has(String(i.src.id));
        return `<tr class="click" data-editsrc="${i.src.id}">
          <td>${esc(i.src.name)}${i.src.note ? `<div class="muted small">${esc(i.src.note)}</div>` : ''}</td>
          <td><span class="chip k-${i.src.kind}">${KL[i.src.kind]}</span></td>
          <td class="num">${fmt0.format(num(i.src.amount))}</td>
          <td class="num">${i.isLoan && i.src.interest != null ? fpct(num(i.src.interest)) : '–'}</td>
          <td class="num">${i.isLoan && i.src.rate ? fmt0.format(num(i.src.rate)) : '–'}</td>
          <td class="num">${i.isLoan ? fmt0.format(i.rest) : '–'}</td>
          ${S.users.length > 1 ? `<td class="small">${esc(i.split)}</td>` : ''}
          <td class="num nowrap">${i.isLoan && i.pl ? `<button class="iconbtn" data-loandetail="${i.src.id}" title="Zinsen, Tilgung, Tilgungsplan">${open ? 'Details ▴' : 'Details ▾'}</button>` : ''}
            <button class="iconbtn" data-editsrc="${i.src.id}">Bearbeiten</button></td></tr>
          ${open ? `<tr class="detail"><td colspan="${S.users.length > 1 ? 8 : 7}"><div class="loanbox">${loanStats(i.src, i.pl)}</div></td></tr>` : ''}`;
      }).join('')}</tbody>
      <tfoot><tr><td colspan="2">Summe</td><td class="num">${fmt0.format(sumA)}</td><td></td><td class="num">${sumR ? fmt0.format(sumR) : ''}</td><td class="num">${sumR ? fmt0.format(sumRest) : ''}</td>${S.users.length > 1 ? '<td></td>' : ''}<td></td></tr></tfoot></table></div>`;
  }

  /** Kennzahlen eines Darlehens + Tilgungsplan nach Jahren */
  function loanStats(src, pl, compact) {
    if (!pl) return `<div class="muted small">Darlehensbetrag und monatliche Rate eintragen, dann erscheinen Zinsen, Tilgung und Restschuld.</div>`;
    const cell = (l, v, cls = '') => `<div><small>${l}</small><span class="${cls}">${v}</span></div>`;
    let html = pl.stuck ? `<div class="err">Die Rate deckt nach den tilgungsfreien Monaten nicht die Zinsen (${fmt0.format(num(src.amount) * num(src.interest) / 1200)} / Monat) – die Schuld wird nicht kleiner.</div>` : '';
    html += `<div class="loanstats">
      ${cell('Anfängliche Tilgung', fpct(pl.initialTilgung))}
      ${cell('Gesamtzinsen (Laufzeit)', pl.stuck ? '–' : fmt0.format(pl.zinsTotal))}
      ${cell('Schuldenfrei', pl.payoff ? (pl.payoff.ym ? fmonth(pl.payoff.ym) + ' ' : '') + `(${dur(pl.payoff.months)})` : '–')}
      ${cell(pl.start ? `Raten bis heute (${pl.elapsed})` : 'Raten bis heute', pl.start ? fmt0.format(pl.paid) : 'Erste Rate fehlt')}
      ${cell('Zinsen bezahlt', fmt0.format(pl.zinsPaid))}
      ${cell('Tilgung bezahlt', fmt0.format(pl.tilgPaid))}
      ${cell('Restschuld heute', fmt0.format(pl.restToday), 'strong')}
      ${pl.fixEnd ? cell(`Restschuld Ende Zinsbindung${pl.fixEnd.ym ? ' ' + fmonth(pl.fixEnd.ym) : ''}`, fmt0.format(pl.fixEnd.rest), 'strong') : cell('Zinsbindung', 'nicht angegeben')}
      ${pl.fixEnd ? cell('Zinsen bis Ende Zinsbindung', fmt0.format(pl.fixEnd.zins)) : ''}
    </div>`;
    if (S.users.length > 1 && !compact) {
      const sh = shareAmounts(splitOf(src), num(src.rate));
      html += `<div class="small" style="margin-top:10px">Rate je Person: ${S.users.map((u) => `${esc(u.display_name)} <b>${fmt0.format(sh[u.id])}</b>`).join(' · ')}</div>`;
    }
    if (compact) return html;
    const years = new Map();
    pl.rows.forEach((r) => {
      const key = pl.start ? ymFrom(ymIndex(pl.start) + r.m).slice(0, 4) : 'Jahr ' + (Math.floor(r.m / 12) + 1);
      const y = years.get(key) || { zins: 0, tilg: 0, pay: 0, rest: 0 };
      y.zins += r.zins; y.tilg += r.tilg; y.pay += r.pay; y.rest = r.rest; years.set(key, y);
    });
    const now = thisMonth().slice(0, 4);
    html += `<details class="plan" data-plan="${src.id}" ${openPlans.has(String(src.id)) ? 'open' : ''}><summary>Tilgungsplan nach Jahren</summary>
      <div style="overflow-x:auto"><table><thead><tr><th>Jahr</th><th class="num">Raten</th><th class="num">Zinsen</th><th class="num">Tilgung</th><th class="num">Restschuld</th></tr></thead><tbody>
      ${[...years.entries()].map(([k, y]) => `<tr class="${k === now ? 'cur' : ''}"><td>${k}</td><td class="num">${fmt0.format(y.pay)}</td><td class="num">${fmt0.format(y.zins)}</td><td class="num">${fmt0.format(y.tilg)}</td><td class="num">${fmt0.format(y.rest)}</td></tr>`).join('')}
      </tbody></table></div></details>`;
    return html;
  }

  /** Eine Maske für Eigenkapital, Darlehen und Sonstiges – neu anlegen oder bearbeiten */
  function sourceDialog(id) {
    const src = id ? S.sources.find((x) => x.id === id) : null;
    if (id && !src) return;
    const d = src || { name: '', kind: 'eigen', amount: 0, note: '', split: null, grace_months: 0 };
    const custom = !!d.split;
    openModal(`<h2>${src ? 'Finanzierungsbaustein bearbeiten' : 'Finanzierungsbaustein anlegen'}</h2>
      <form id="srcForm" class="form">
        <div class="full"><div class="seg" id="kindSeg">${KINDS.map((k) => `<button type="button" data-kind="${k.k}" class="${d.kind === k.k ? 'on' : ''}">${k.l}</button>`).join('')}</div></div>
        <input type="hidden" name="kind" value="${esc(d.kind)}">
        <label class="full">Bezeichnung *<input name="name" required value="${esc(d.name)}" placeholder="z. B. Eigenkapital, KfW 297, Hausbank"></label>
        <label class="wide"><span data-lbl="amount">${d.kind === 'darlehen' ? 'Darlehensbetrag (€)' : 'Betrag (€)'}</span><input name="amount" inputmode="decimal" value="${esc(d.amount ? amtInput(d.amount) : '')}" placeholder="0"></label>
        <label data-loan>Sollzins (% p. a.)<input name="interest" inputmode="decimal" value="${d.interest != null ? String(d.interest).replace('.', ',') : ''}" placeholder="z. B. 3,45"></label>
        <label data-loan>Monatliche Rate (€)<input name="rate" inputmode="decimal" value="${esc(d.rate ? amtInput(d.rate) : '')}" placeholder="z. B. 1.250"></label>
        <label data-loan>Erste Rate (Monat)<input name="start" value="${esc(fmonth(d.start))}" placeholder="MM.JJJJ"></label>
        <label data-loan>Zinsbindung (Jahre)<input name="fixed_years" inputmode="numeric" value="${d.fixed_years != null ? d.fixed_years : ''}" placeholder="z. B. 10"></label>
        <label data-loan>Tilgungsfreie Monate<input name="grace_months" inputmode="numeric" value="${d.grace_months || ''}" placeholder="0"></label>
        <label class="full">Notiz (Bank, Vertragsnr. …)<input name="note" value="${esc(d.note || '')}"></label>
        <div class="full" data-loan><div class="loanbox" id="loanPreview"></div></div>
        ${S.users.length > 1 ? `<div class="full">
          <div class="small muted" style="font-weight:500;margin-bottom:4px" data-lbl="split">${d.kind === 'darlehen' ? 'Aufteilung der Rate' : 'Wer bringt das ein?'}</div>
          <label class="mrow small muted"><input type="checkbox" id="srcSplitDefault" ${custom ? '' : 'checked'}> Standardaufteilung (${splitLabel(defaultSplit())})</label>
          <div id="srcSplitCustom" ${custom ? '' : 'hidden'}>${splitEditor('srcdlg', splitOf(d), d.kind === 'darlehen' ? num(d.rate) : num(d.amount), true)}</div>
        </div>` : ''}
      </form>
      <div class="err" id="srcErr"></div>
      <div class="actions">
        ${src ? `<button class="danger" id="delSrc">Löschen</button>` : ''}
        <span class="spacer"></span>
        <button id="cancel">Abbrechen</button>
        <button class="primary" id="saveSrc">Speichern</button>
      </div>`);
    const form = $('#srcForm');
    const readForm = () => {
      const f = form.elements;
      return {
        kind: f.kind.value, name: f.name.value.trim(), note: f.note.value.trim(),
        amount: f.amount.value.trim() === '' ? 0 : parseAmount(f.amount.value),
        interest: parseNum(f.interest.value), rate: f.rate.value.trim() === '' ? null : parseAmount(f.rate.value),
        start: parseMonth(f.start.value),
        fixed_years: f.fixed_years.value.trim() === '' ? null : Number(f.fixed_years.value),
        grace_months: f.grace_months.value.trim() === '' ? 0 : Number(f.grace_months.value),
      };
    };
    const refresh = () => {
      const v = readForm();
      const isLoan = v.kind === 'darlehen';
      form.querySelectorAll('[data-loan]').forEach((el) => { el.hidden = !isLoan; });
      form.querySelector('[data-lbl="amount"]').textContent = isLoan ? 'Darlehensbetrag (€)' : 'Betrag (€)';
      const sl = form.querySelector('[data-lbl="split"]'); if (sl) sl.textContent = isLoan ? 'Aufteilung der Rate' : 'Wer bringt das ein?';
      setSplitTotal('srcdlg', isLoan ? num(v.rate) : num(v.amount));
      if (isLoan) {
        const tmp = { ...v, start: v.start || '', interest: Number.isFinite(v.interest) ? v.interest : 0, amount: num(v.amount), rate: num(v.rate) };
        $('#loanPreview').innerHTML = loanStats(tmp, loanPlan(tmp), true);
      }
    };
    refresh();
    form.addEventListener('input', (ev) => { if (!ev.target.dataset.split) refresh(); });
    $('#kindSeg').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-kind]'); if (!b) return;
      form.elements.kind.value = b.dataset.kind;
      $('#kindSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      refresh();
    });
    if ($('#srcSplitDefault')) $('#srcSplitDefault').onchange = (ev) => { $('#srcSplitCustom').hidden = ev.target.checked; };
    $('#cancel').onclick = closeModal;
    form.addEventListener('submit', (ev) => { ev.preventDefault(); save(); });
    $('#saveSrc').onclick = save;
    if ($('#delSrc')) $('#delSrc').onclick = async () => {
      const b = $('#delSrc');
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Wirklich löschen?'; return; }
      try { await api('DELETE', '/api/sources/' + src.id); closeModal(); await load(); }
      catch (err) { $('#srcErr').textContent = err.message; }
    };
    async function save() {
      const v = readForm();
      const err = (m) => { $('#srcErr').textContent = m; };
      if (!v.name) return err('Bitte eine Bezeichnung eingeben.');
      if (!Number.isFinite(v.amount)) return err('Betrag nicht erkannt (z. B. 300.000).');
      const body = { name: v.name, kind: v.kind, amount: v.amount, note: v.note };
      if (v.kind === 'darlehen') {
        if (Number.isNaN(v.interest)) return err('Sollzins nicht erkannt (z. B. 3,45).');
        if (v.rate != null && !Number.isFinite(v.rate)) return err('Rate nicht erkannt (z. B. 1.250).');
        if (v.start === null) return err('Erste Rate bitte als Monat angeben, z. B. 03.2027.');
        if (v.fixed_years != null && !Number.isInteger(v.fixed_years)) return err('Zinsbindung bitte in ganzen Jahren.');
        if (!Number.isInteger(v.grace_months)) return err('Tilgungsfreie Monate bitte als ganze Zahl.');
        Object.assign(body, { interest: v.interest, rate: v.rate, start: v.start, fixed_years: v.fixed_years, grace_months: v.grace_months });
      }
      body.split = null;
      if ($('#srcSplitDefault') && !$('#srcSplitDefault').checked) {
        const r = readSplit('srcdlg');
        if (!r.ok) {
          return err(r.mode === 'eur' ? `Die Beträge ergeben ${fmt2.format(r.sum)} – sie müssen zusammen ${fmt2.format(r.total)} ergeben.`
            : `Die Aufteilung ergibt ${pct.format(r.sum)} % – sie muss 100 % ergeben.`);
        }
        body.split = { mode: r.mode, values: r.values };
      }
      $('#saveSrc').disabled = true;
      try {
        let sid = src && src.id;
        if (!sid) sid = (await api('POST', '/api/sources', { name: v.name, kind: v.kind, amount: v.amount, note: v.note })).id;
        await api('PUT', '/api/sources/' + sid, body);
        closeModal();
        await load();
      } catch (e2) { $('#saveSrc').disabled = false; err(e2.message); await load(); }
    }
  }

  const splitVal = (v, mode) => { const n = Math.round(num(v) * 100) / 100; return mode === 'eur' ? amtInput(n) || '0' : String(n).replace('.', ','); };
  function splitHint(mode, sum, total) {
    if (mode === 'eur') {
      const ok = Math.abs(sum - total) <= 0.5;
      return `<span class="${ok ? '' : 'neg'}">Summe ${fmt2.format(sum)} von ${fmt2.format(total)}${ok ? '' : ' – muss übereinstimmen'}</span>`;
    }
    const ok = Math.abs(sum - 100) <= 0.5;
    return `<span class="${ok ? '' : 'neg'}">Summe ${pct.format(sum)} %${ok ? '' : ' – muss 100 % ergeben'}</span>`;
  }
  /** Editor für die Aufteilung: Prozent oder feste Beträge (€) je Person */
  function splitEditor(prefix, sp, total, allowEur) {
    if (S.users.length < 2) return `<div class="muted small">Sobald ein zweites Konto angelegt ist, kannst du hier die Aufteilung festlegen.</div>`;
    const mode = allowEur && sp.mode === 'eur' ? 'eur' : 'pct';
    const sum = S.users.reduce((x, u) => x + num(sp.values[u.id]), 0);
    return `<div class="splitbox" data-splitbox="${prefix}" data-mode="${mode}" data-total="${num(total)}" data-alloweur="${allowEur ? 1 : 0}">
      ${allowEur ? `<div class="seg full"><button type="button" data-splitmode="pct" data-for="${prefix}" class="${mode === 'pct' ? 'on' : ''}">Prozent</button><button type="button" data-splitmode="eur" data-for="${prefix}" class="${mode === 'eur' ? 'on' : ''}">Betrag (€)</button></div>` : ''}
      ${S.users.map((u, i) => `<label>${esc(u.display_name)} (${mode === 'eur' ? '€' : '%'})<input inputmode="decimal" data-split="${prefix}" data-uid="${u.id}" data-idx="${i}" value="${splitVal(sp.values[u.id], mode)}"></label>`).join('')}
      ${S.users.length === 2 && mode === 'pct' ? `<input type="range" min="0" max="100" step="5" data-splitrange="${prefix}" value="${num(sp.values[S.users[0].id])}" class="full">` : ''}
      <div class="small muted full" data-splithint="${prefix}">${splitHint(mode, sum, num(total))}</div>
    </div>`;
  }
  function readSplit(prefix) {
    const box = document.querySelector(`[data-splitbox="${prefix}"]`);
    const mode = box ? box.dataset.mode : 'pct';
    const total = box ? Number(box.dataset.total) : 0;
    const values = {}; let sum = 0; let bad = false;
    document.querySelectorAll(`[data-split="${prefix}"]`).forEach((i) => {
      const v = parseAmount(i.value === '' ? '0' : i.value);
      if (!Number.isFinite(v) || v < 0) bad = true;
      values[i.dataset.uid] = Number.isFinite(v) ? v : 0; sum += values[i.dataset.uid];
    });
    const ok = !bad && (mode === 'eur' ? Math.abs(sum - total) <= 0.5 : Math.abs(sum - 100) <= 0.5);
    return { mode, values, sum, total, ok };
  }
  function refreshSplitHint(prefix) {
    const r = readSplit(prefix);
    const h = document.querySelector(`[data-splithint="${prefix}"]`);
    if (h) h.innerHTML = splitHint(r.mode, r.sum, r.total);
  }
  function setSplitTotal(prefix, total) {
    const box = document.querySelector(`[data-splitbox="${prefix}"]`);
    if (!box) return;
    box.dataset.total = num(total);
    refreshSplitHint(prefix);
  }
  function switchSplitMode(prefix, mode) {
    const box = document.querySelector(`[data-splitbox="${prefix}"]`);
    if (!box || box.dataset.mode === mode) return;
    const r = readSplit(prefix);
    const values = {};
    S.users.forEach((u) => {
      const v = num(r.values[u.id]);
      values[u.id] = mode === 'eur' ? Math.round(r.total * v) / 100 : (r.total ? Math.round((v / r.total) * 10000) / 100 : 0);
    });
    box.outerHTML = splitEditor(prefix, { mode, values }, r.total, box.dataset.alloweur === '1');
  }

  function viewSettings() {
    return `<div class="grid settings">
      <div class="card"><h2>Aufteilung &amp; Reserve</h2>
        <form id="setForm">
          <div class="small muted" style="font-weight:500">Standardaufteilung geleisteter Zahlungen</div>
          ${splitEditor('def', defaultSplit(), 100, false)}
          <div class="muted small">Gilt für alle Positionen ohne eigene Aufteilung. Pro Position änderbar im Bearbeiten-Dialog.</div>
          <label style="margin-top:8px">Reserve für Unvorhergesehenes (%)<input name="reserve" type="number" min="0" max="100" step="0.5" value="${Math.round(num(S.settings.reserve_rate) * 1000) / 10}"></label>
          <button type="submit" class="primary">Speichern</button>
        </form>
        <div class="err" id="setErr"></div><div class="okmsg" id="setOk"></div>
      </div>
      ${mailCard()}
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
  function mailCard() {
    const m = S.mail || {}; const st = m.status || {};
    return `<div class="card"><h2>E-Mail-Postfach für Rechnungen</h2>
      <div class="muted small">Rechnungen einfach an ein eigenes Postfach weiterleiten – Kassensturz holt PDF- und Bild-Anhänge regelmäßig ab, liest sie und legt sie in den Eingang unter „Kosten“. Am besten ein eigenes Postfach oder einen eigenen Ordner nutzen; die Mails werden danach in den Erledigt-Ordner verschoben.</div>
      <form id="mailForm" style="margin-top:10px">
        <label class="mrow small"><input type="checkbox" name="enabled" ${m.enabled ? 'checked' : ''}> Automatisch abrufen</label>
        <div class="splitbox">
          <label>IMAP-Server<input name="host" value="${esc(m.host || '')}" placeholder="z. B. imap.gmx.net"></label>
          <label>Port / Verschlüsselung<select name="secure"><option value="tls" ${m.secure !== false ? 'selected' : ''}>993 · SSL/TLS</option><option value="plain" ${m.secure === false ? 'selected' : ''}>143 · unverschlüsselt (nur lokal)</option></select></label>
          <label>Benutzer<input name="user" value="${esc(m.user || '')}" autocomplete="off" placeholder="rechnungen@…"></label>
          <label>Passwort<input name="pass" type="password" autocomplete="new-password" placeholder="${m.has_pass ? 'gespeichert – leer lassen' : 'App-Passwort'}"></label>
          <label>Ordner<input name="folder" value="${esc(m.folder || 'INBOX')}"></label>
          <label>Erledigt-Ordner<input name="done_folder" value="${esc(m.done_folder ?? 'Kassensturz')}" placeholder="leer = nur als gelesen markieren"></label>
          <label class="full">Nur von diesen Absendern (empfohlen)<input name="allowed" value="${esc(m.allowed || '')}" placeholder="du@…, partnerin@…, @firma.de"></label>
          <label>Abruf alle (Minuten)<input name="interval" type="number" min="5" max="1440" value="${m.interval || 15}"></label>
          <input type="hidden" name="port" value="${m.port || 993}">
        </div>
        <div class="mrow" style="flex-wrap:wrap;margin-top:6px"><button type="submit" class="primary">Speichern</button><button type="button" id="mailTest">Verbindung testen</button><button type="button" id="mailRun">Jetzt abrufen</button></div>
      </form>
      <div id="mailOut" class="small muted" style="margin-top:8px">${st.last_run ? `Letzter Abruf ${new Date(st.last_run).toLocaleString('de-DE')}: ${st.ok ? `ok, ${st.attachments || 0} Beleg(e)` : `<span class="neg">${esc(st.error || 'Fehler')}</span>`}` : 'Noch nicht abgerufen.'}</div>
      <div class="muted small" style="margin-top:8px">Gmail: IMAP aktivieren und ein App-Passwort nutzen. GMX/Web.de: IMAP in den Einstellungen freischalten. Outlook/Hotmail erlauben keine Passwort-Anmeldung per IMAP mehr. Das Passwort liegt nur im Datenordner auf der NAS.</div>
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
  function openModal(html) { $('#dlg').innerHTML = html; $('#modal').classList.add('open'); const f = $('#dlg input:not([type=radio]):not([type=checkbox]):not([type=hidden])'); if (f && !mobile) f.focus(); }
  function closeModal() { $('#modal').classList.remove('open'); $('#dlg').innerHTML = ''; if (pendingRender) render(); }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modal').classList.contains('open')) closeModal(); });

  function expenseDialog(id, scan) {
    const e = id ? S.expenses.find((x) => x.id === id) : null;
    if (id && !e) return;
    const d = { ...(e || { status: 'geplant', included: 'nein', date: '', category_id: filt.cat && filt.cat !== NOCAT ? Number(filt.cat) : null, attachments: [], split: null }) };
    const auto = new Set();
    if (scan && scan.prefill) { Object.assign(d, scan.prefill); scan = null; }
    if (scan) {
      // Erkannte Werte übernehmen – bei einer bestehenden Position bleiben Nr, Kostenpunkt, Bereich und Schätzung erhalten
      const f = scan.result.fields || {};
      const put = (k, v) => { if (v !== null && v !== undefined && v !== '') { d[k] = v; auto.add(k); } };
      if (!e) { put('title', f.title); put('category_id', scan.result.category_id); }
      put('amount', f.amount); put('status', f.status); put('date', f.date); put('due', f.due);
      if (!e || !e.vendor) put('vendor', f.vendor);
      if (f.note && !String(d.note || '').includes(f.note)) { d.note = [d.note, f.note].filter(Boolean).join(' · '); auto.add('note'); }
    }
    const custom = !!d.split;
    const scanBox = scan ? (() => {
      const r = scan.result; const f = r.fields || {}; r.matches = r.matches || [];
      const how = { 'pdf-text': 'Text aus dem PDF', 'pdf-ocr': 'Texterkennung (Scan)', 'image-ocr': 'Texterkennung (Foto)' }[r.method] || '';
      const typ = { rechnung: 'Rechnung', angebot: 'Angebot', auftrag: 'Auftragsbestätigung', quittung: 'Kassenbon' }[f.type] || 'Dokumentart nicht erkannt';
      return `<div class="scanbox">
        <div><b>${esc(scan.file.name)}</b> gelesen – ${typ}${how ? ` · ${how}` : ''}${scan.inboxId ? ` · <a href="/api/inbox/${scan.inboxId}/file" target="_blank" rel="noopener">ansehen</a>` : ''}</div>
        ${scan.inboxId ? `<div class="small muted">aus E-Mail von ${esc(scan.from || '')}${scan.subject ? ' · „' + esc(scan.subject) + '“' : ''}</div>` : ''}
        <div class="small muted"><span class="lg auto">erkannt</span> <span class="lg missing">bitte prüfen / ergänzen</span>${f.amount_confidence === 'niedrig' ? ' · <span class="neg">Betrag unsicher – bitte prüfen</span>' : ''}</div>
        <div class="scanmatch"><span class="small muted">Zuordnen zu:</span>
          <label><input type="radio" name="scanTarget" value="" ${e ? '' : 'checked'}> Neue Position</label>
          ${r.matches.map((m) => `<label><input type="radio" name="scanTarget" value="${m.id}" ${e && e.id === m.id ? 'checked' : ''}> ${m.code ? `<span class="muted">${esc(m.code)}</span> ` : ''}${esc(m.title)}</label>`).join('')}
          ${e && !r.matches.some((m) => m.id === e.id) ? `<label><input type="radio" name="scanTarget" value="${e.id}" checked> ${esc(e.title)}</label>` : ''}
        </div>
        <details><summary class="small">Erkannter Text</summary><pre class="ocrtext">${esc(r.text)}</pre></details>
      </div>`;
    })() : '';
    openModal(`<h2>${scan ? (e ? 'Beleg zu Position hinzufügen' : 'Position aus Beleg anlegen') : e ? 'Position bearbeiten' : 'Position anlegen'}</h2>
      ${scanBox}
      <form id="expForm" class="form">
        <label>Nr<input name="code" value="${esc(d.code || '')}" placeholder="z. B. A18"></label>
        <label class="wide">Bereich<select name="category_id"><option value="">Ohne Kategorie</option>${S.categories.map((c) => `<option value="${c.id}" ${d.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label class="full">Kostenpunkt *<input name="title" required value="${esc(d.title || '')}"></label>
        <label class="wide">Im Hauspreis?<select name="included">${INCL.map((s) => `<option value="${s.k}" ${d.included === s.k ? 'selected' : ''}>${s.l} – ${s.h}</option>`).join('')}</select></label>
        <label class="wide">Status<select name="status">${STATUS.map((s) => `<option value="${s.k}" ${d.status === s.k ? 'selected' : ''}>${s.l} – ${s.h}</option>`).join('')}</select></label>
        <label>Schätzung (€)<input name="estimate" inputmode="decimal" value="${esc(amtInput(d.estimate))}" placeholder="z. B. 5.000"></label>
        <label>Angebot / Ist (€)<input name="amount" inputmode="decimal" value="${esc(amtInput(d.amount))}" placeholder="leer = noch keins"></label>
        <label class="wide">Firma / Anbieter<input name="vendor" value="${esc(d.vendor || '')}"></label>
        <label>Datum<input type="date" name="date" value="${esc(d.date || '')}"></label>
        <label>Fällig am<input type="date" name="due" value="${esc(d.due || '')}"></label>
        <label class="full">Hinweis<textarea name="hint" rows="2">${esc(d.hint || '')}</textarea></label>
        <label class="full">Info / Notiz (Links werden klickbar)<textarea name="note" rows="2">${esc(d.note || '')}</textarea></label>
        <details class="full wbox" ${d.warranty_months ? 'open' : ''}><summary class="small muted" style="font-weight:500">Gewährleistung${d.warranty_months ? ` · ${durLabel(d.warranty_months)}` : ''}</summary>
          <div class="form" style="margin-top:8px">
            <label>Abnahme / Beginn<input type="date" name="warranty_start" value="${esc(d.warranty_start || '')}"></label>
            <label>Dauer<select name="warranty_preset"><option value="">keine</option>${WARRANTY.map((p) => `<option value="${p.m}" ${d.warranty_months === p.m ? 'selected' : ''}>${esc(p.l)}</option>`).join('')}
              <option value="custom" ${d.warranty_months && !WARRANTY.some((p) => p.m === d.warranty_months) ? 'selected' : ''}>eigene Dauer …</option></select></label>
            <label class="wcustom" ${d.warranty_months && !WARRANTY.some((p) => p.m === d.warranty_months) ? '' : 'hidden'}>Monate<input name="warranty_custom" inputmode="numeric" value="${d.warranty_months && !WARRANTY.some((p) => p.m === d.warranty_months) ? d.warranty_months : ''}"></label>
            <label class="full">Notiz zur Gewährleistung<input name="warranty_note" value="${esc(d.warranty_note || '')}" placeholder="z. B. Abnahmeprotokoll vom …, Herstellergarantie 10 Jahre"></label>
            <div class="full small muted" id="wInfo"></div>
          </div></details>
        ${S.users.length > 1 ? `<div class="full">
          <div class="small muted" style="font-weight:500;margin-bottom:4px">Aufteilung der Zahlung</div>
          <label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="splitDefault" ${custom ? '' : 'checked'} style="width:auto"> Standardaufteilung verwenden (${splitLabel(defaultSplit())})</label>
          <div id="splitCustom" ${custom ? '' : 'hidden'}>${splitEditor('exp', splitOf(d), has(d.amount) ? num(d.amount) : num(d.estimate), true)}</div>
        </div>` : ''}
        <div class="full">
          <div class="small muted" style="font-weight:500;margin-bottom:4px">Belege (PDF, Fotos)</div>
          <div id="attList">${(d.attachments || []).map((a) => `<div class="att"><a href="/api/attachments/${a.id}" target="_blank" rel="noopener">${esc(a.filename)}</a><span class="muted small">${fsize(a.size)}</span><button type="button" class="iconbtn" data-delatt="${a.id}">✕</button></div>`).join('')}</div>
          ${scan ? `<div class="att"><span>📄 ${esc(scan.file.name)}</span><span class="muted small">${fsize(scan.file.size || 0)} · wird beim Speichern angehängt</span></div>` : ''}
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
    if (scan) {
      // erkannt = grün, fehlt = orange
      auto.forEach((k) => { const el = form.elements[k]; if (el) el.classList.add('auto'); });
      const need = ['title', 'category_id', 'amount', 'status'].concat(d.status === 'beauftragt' ? ['due'] : []).concat(scan.result.fields.type === 'quittung' ? [] : ['vendor']);
      const mark = () => need.forEach((k) => { const el = form.elements[k]; if (el) el.classList.toggle('missing', !String(el.value || '').trim()); });
      mark();
      form.addEventListener('input', (ev) => { ev.target.classList.remove('auto'); mark(); });
      form.addEventListener('change', mark);
      document.querySelectorAll('[name=scanTarget]').forEach((r) => r.addEventListener('change', () => {
        expenseDialog(r.value ? Number(r.value) : null, scan);
      }));
    }
    if ($('#splitDefault')) $('#splitDefault').onchange = (ev) => { $('#splitCustom').hidden = ev.target.checked; };
    // Gewährleistung: Ende live anzeigen
    const wMonths = () => { const p = form.warranty_preset.value; return p === 'custom' ? Number(form.warranty_custom.value) || 0 : Number(p) || 0; };
    const wRefresh = () => {
      form.querySelector('.wcustom').hidden = form.warranty_preset.value !== 'custom';
      const m2 = wMonths(); const st = form.warranty_start.value || (form.status.value === 'bezahlt' ? form.date.value : '');
      $('#wInfo').textContent = m2 && st ? `Endet am ${fdate(addMonthsIso(st, m2))} · Begehung bis ${fdate(addMonthsIso(addMonthsIso(st, m2), -3))}${form.warranty_start.value ? '' : ' (Beginn = Rechnungsdatum, bitte Abnahme eintragen)'}`
        : m2 ? 'Bitte Abnahme-Datum eintragen (oder Status „Bezahlt“ mit Datum).' : '';
    };
    ['warranty_preset', 'warranty_custom', 'warranty_start', 'status', 'date'].forEach((n) => form.elements[n].addEventListener('input', wRefresh));
    form.warranty_preset.addEventListener('change', wRefresh);
    wRefresh();
    // Gesamtbetrag für die €-Aufteilung folgt Angebot/Ist bzw. Schätzung
    form.addEventListener('input', (ev) => {
      if (ev.target.name !== 'amount' && ev.target.name !== 'estimate') return;
      const a = parseAmount(form.amount.value), e2 = parseAmount(form.estimate.value);
      setSplitTotal('exp', Number.isFinite(a) ? a : Number.isFinite(e2) ? e2 : 0);
    });
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
        if (!r.ok) {
          $('#expErr').textContent = r.mode === 'eur'
            ? `Die Beträge ergeben ${fmt2.format(r.sum)} – sie müssen zusammen ${fmt2.format(r.total)} ergeben.`
            : `Die Aufteilung ergibt ${pct.format(r.sum)} % – sie muss 100 % ergeben.`;
          return;
        }
        split = { mode: r.mode, values: r.values };
      }
      const body = {
        code: f.get('code'), title, estimate, amount, status: f.get('status'), included: f.get('included'),
        category_id: f.get('category_id') ? Number(f.get('category_id')) : null,
        vendor: f.get('vendor'), date: f.get('date'), due: f.get('due'), hint: f.get('hint'), note: f.get('note'), split,
        warranty_start: f.get('warranty_start'), warranty_note: f.get('warranty_note'), warranty_months: wMonths() || null,
      };
      const files = [...form.querySelector('input[type=file]').files];
      if (scan && scan.file instanceof Blob) files.unshift(scan.file);
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
        if (scan && scan.inboxId) await api('POST', `/api/inbox/${scan.inboxId}/attach`, { expense_id: expId });
        closeModal();
        await load();
      } catch (err) {
        $('#saveExp').disabled = false; $('#expErr').textContent = err.message;
        await load();
      }
    }
  }

  // =====================================================================
  // Planung: Szenarien · Leistungsbeschreibung · Gewährleistung
  // =====================================================================
  function viewPlanning() {
    const seg = [['szenarien', 'Was-wäre-wenn', 'Szenarien'], ['leistungsbeschreibung', 'Leistungsbeschreibung', 'Leistungen'], ['gewaehrleistung', 'Gewährleistung', 'Gewährl.']];
    let html = `<div class="seg planseg">${seg.map(([k, l, ml]) => `<a href="#${k}" class="${planTab === k ? 'on' : ''}">${mobile ? ml : l}</a>`).join('')}</div>`;
    if (planTab === 'leistungsbeschreibung') html += viewDocuments();
    else if (planTab === 'gewaehrleistung') html += viewWarranty();
    else html += viewScenarios();
    return html;
  }

  // ---------- Was-wäre-wenn ----------
  /** Positionen mit den Kostenänderungen einer Auswahl von Optionen */
  function withEffects(effects) {
    const sets = new Map(); const adds = [];
    effects.forEach((f) => { if (f.type === 'set') sets.set(f.expense_id, num(f.amount)); else adds.push(f); });
    const list = S.expenses.map((e) => (sets.has(e.id)
      ? { ...e, amount: sets.get(e.id), included: 'nein', status: e.status === 'option' ? 'geplant' : e.status }
      : e));
    adds.forEach((f, i) => list.push({ id: -1 - i, title: f.label, included: 'nein', status: 'geplant', estimate: num(f.amount), amount: null, category_id: f.category_id ?? null, attachments: [] }));
    return list;
  }
  const openDecisions = () => (S.decisions || []).filter((d) => !d.decided_option);
  function effectsFor(choices) {
    const out = [];
    openDecisions().forEach((d) => {
      const oid = choices[d.id];
      const o = d.options.find((x) => x.id === oid);
      if (o) out.push(...o.effects);
    });
    return out;
  }
  function loanFactor() {
    // Rate je geliehenem Euro aus dem ersten Darlehen mit Rate (Annuität)
    const l = loans().find((x) => num(x.amount) > 0 && num(x.rate) > 0);
    return l ? { f: num(l.rate) / num(l.amount), name: l.name } : null;
  }
  function scenarioResult(choices) {
    const t = totals(withEffects(effectsFor(choices)));
    return { ...t, puffer: finTotal() - t.gesamt };
  }
  function effectLabel(f) {
    if (f.type === 'set') { const e = S.expenses.find((x) => x.id === f.expense_id); return `${e ? (e.code ? e.code + ' ' : '') + e.title : 'Position'} → ${fmt0.format(num(f.amount))}`; }
    return `${num(f.amount) < 0 ? 'Einsparung' : '+'} ${f.label}: ${fmt0.format(num(f.amount))}`;
  }

  function viewScenarios() {
    const base = scenarioResult({});
    const lf = loanFactor();
    const decs = S.decisions || [];
    let html = `<div class="toolbar"><div class="muted">Offene Entscheidungen mit ihren Optionen anlegen und in Szenarien kombinieren. Nichts davon ändert eure Kosten, bis ihr eine Option übernehmt.</div>
      <span class="spacer"></span><button class="primary" id="addDecision">+ Entscheidung</button></div>`;
    if (!decs.length) html += `<div class="card"><div class="empty">Noch keine Entscheidungen. Beispiele: „FingerHaus oder Büdenbender“, „Holzfaserdämmung“, „KNX komplett oder nur Vorbereitung“, „Klima-Splitgeräte“.</div></div>`;
    html += `<div class="decgrid">${decs.map((d) => {
      const decided = d.options.find((o) => o.id === d.decided_option);
      return `<div class="card dec ${decided ? 'done' : ''}">
        <div class="mrow" style="align-items:baseline"><h2 style="flex:1;margin:0">${esc(d.title)}</h2>${decided ? `<span class="chip s-bezahlt">entschieden</span>` : ''}</div>
        ${d.note ? `<div class="muted small" style="margin-top:4px">${esc(d.note)}</div>` : ''}
        <div class="opts">${d.options.map((o) => {
          const r = decided ? null : scenarioResult({ [d.id]: o.id });
          const delta = r ? r.gesamt - base.gesamt : 0;
          return `<div class="opt ${decided && decided.id === o.id ? 'chosen' : ''}">
            <div class="mrow"><b style="flex:1">${esc(o.label)}</b>${r ? `<span class="strong ${delta > 0.5 ? 'neg' : delta < -0.5 ? 'pos' : 'muted'}">${Math.abs(delta) < 0.5 ? '±0 €' : (delta > 0 ? '+' : '−') + fmt0.format(Math.abs(delta))}</span>` : ''}</div>
            ${o.note ? `<div class="muted small">${esc(o.note)}</div>` : ''}
            ${o.effects.length ? `<ul class="eff">${o.effects.map((f) => `<li>${esc(effectLabel(f))}</li>`).join('')}</ul>` : '<div class="muted small">keine Kostenänderung</div>'}
            ${r && lf && Math.abs(delta) >= 1 ? `<div class="muted small">≈ ${delta > 0 ? '+' : '−'}${fmt0.format(Math.abs(delta * lf.f))} Rate / Monat</div>` : ''}
            ${!decided && o.effects.length ? `<button class="iconbtn" data-applyopt="${d.id}:${o.id}">Übernehmen</button>` : ''}
          </div>`;
        }).join('')}</div>
        <div class="mrow" style="justify-content:flex-end;margin-top:8px">${decided ? `<button class="iconbtn" data-reopendec="${d.id}">Wieder öffnen</button>` : ''}<button class="iconbtn" data-editdec="${d.id}">Bearbeiten</button></div>
      </div>`;
    }).join('')}</div>`;

    // Szenarien vergleichen
    const scs = S.scenarios || [];
    html += `<div class="toolbar" style="margin-top:18px"><h2 style="margin:0">Szenarien vergleichen</h2><span class="spacer"></span>
      ${openDecisions().length ? '<button class="primary" id="addScenario">+ Szenario</button>' : ''}</div>`;
    if (!openDecisions().length) html += `<div class="card"><div class="muted small">Sobald es offene Entscheidungen gibt, kannst du hier Kombinationen vergleichen.</div></div>`;
    else {
      const cols = [{ name: 'Ist-Stand', choices: {}, base: true }, ...scs];
      const res = cols.map((c) => ({ c, r: scenarioResult(c.choices || {}) }));
      const line = (r) => { const d = r.gesamt - base.gesamt; return Math.abs(d) < 0.5 ? '±0 €' : (d > 0 ? '+' : '−') + fmt0.format(Math.abs(d)); };
      const picks = (c) => openDecisions().map((d) => { const o = d.options.find((x) => x.id === (c.choices || {})[d.id]); return o ? `<div class="small"><span class="muted">${esc(d.title)}:</span> ${esc(o.label)}</div>` : ''; }).join('') || '<div class="muted small">wie geplant</div>';
      if (mobile) {
        html += res.map(({ c, r }) => `<div class="mcard">
          <div class="top"><span class="ttl">${esc(c.name)}</span>${c.base ? '' : `<button class="iconbtn" data-editsc="${c.id}">Bearbeiten</button>`}</div>
          ${c.base ? '' : picks(c)}
          <div class="mstats"><div><small>Gesamtbudget</small><b>${fmt0.format(r.gesamt)}</b></div><div><small>ggü. Ist</small>${line(r)}</div>
            <div><small>Worst Case</small>${fmt0.format(r.worst)}</div><div><small>${r.puffer < 0 ? 'Lücke' : 'Puffer'}</small><span class="${r.puffer < 0 ? 'neg' : 'pos'}">${fmt0.format(Math.abs(r.puffer))}</span></div>
            ${lf ? `<div><small>Rate / Monat</small>${(r.gesamt - base.gesamt) >= 0 ? '+' : '−'}${fmt0.format(Math.abs((r.gesamt - base.gesamt) * lf.f))}</div>` : ''}</div></div>`).join('');
      } else {
        html += `<div class="card" style="padding:4px 8px;overflow-x:auto"><table class="sctable"><thead><tr><th></th>${res.map(({ c }) => `<th class="num">${esc(c.name)}${c.base ? '' : ` <button class="iconbtn" data-editsc="${c.id}">✎</button>`}</th>`).join('')}</tr></thead><tbody>
          <tr><td class="muted">Auswahl</td>${res.map(({ c }) => `<td class="num">${c.base ? '<span class="muted small">aktueller Stand</span>' : picks(c)}</td>`).join('')}</tr>
          <tr><td>Gesamtbudget</td>${res.map(({ r }) => `<td class="num"><b>${fmt0.format(r.gesamt)}</b></td>`).join('')}</tr>
          <tr><td>ggü. Ist-Stand</td>${res.map(({ r }) => { const d = r.gesamt - base.gesamt; return `<td class="num ${d > 0.5 ? 'neg' : d < -0.5 ? 'pos' : 'muted'}">${line(r)}</td>`; }).join('')}</tr>
          <tr><td>Worst Case</td>${res.map(({ r }) => `<td class="num">${fmt0.format(r.worst)}</td>`).join('')}</tr>
          <tr><td>Finanzierung: Puffer / Lücke</td>${res.map(({ r }) => `<td class="num ${r.puffer < 0 ? 'neg' : 'pos'}">${r.puffer < 0 ? 'Lücke ' : ''}${fmt0.format(Math.abs(r.puffer))}</td>`).join('')}</tr>
          ${lf ? `<tr><td>Rate / Monat (zusätzlich)</td>${res.map(({ r }) => { const d = (r.gesamt - base.gesamt) * lf.f; return `<td class="num">${Math.abs(d) < 1 ? '–' : (d > 0 ? '+' : '−') + fmt0.format(Math.abs(d))}</td>`; }).join('')}</tr>` : ''}
        </tbody></table></div>`;
      }
      html += `<div class="muted small" style="margin-top:6px">${lf ? `Ratenänderung geschätzt mit dem Verhältnis Rate/Darlehen von „${esc(lf.name)}“ (Mehrkosten werden zu denselben Bedingungen finanziert).` : 'Für eine Schätzung der Ratenänderung unter Finanzierung ein Darlehen mit Betrag und Rate anlegen.'}</div>`;
    }
    return html;
  }

  function decisionDialog(id) {
    const src = id ? (S.decisions || []).find((d) => d.id === id) : null;
    const dd = src ? JSON.parse(JSON.stringify(src)) : { title: '', note: '', options: [{ id: 'o1', label: 'Nein / wie geplant', note: '', effects: [] }, { id: 'o2', label: 'Ja', note: '', effects: [] }] };
    const posOpts = (sel) => `<option value="">– Position wählen –</option>${S.categories.map((c) => `<optgroup label="${esc(c.name)}">${S.expenses.filter((e) => e.category_id === c.id).sort(byCode).map((e) => `<option value="${e.id}" ${sel === e.id ? 'selected' : ''}>${esc((e.code ? e.code + ' ' : '') + e.title)}</option>`).join('')}</optgroup>`).join('')}`;
    const catOpts = (sel) => `<option value="">Ohne Kategorie</option>${S.categories.map((c) => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
    const read = () => {
      dd.title = $('#decTitle').value.trim(); dd.note = $('#decNote').value.trim();
      dd.options.forEach((o, oi) => {
        o.label = document.querySelector(`[data-o="${oi}"][data-k=label]`).value.trim();
        o.note = document.querySelector(`[data-o="${oi}"][data-k=note]`).value.trim();
        o.effects.forEach((f, fi) => {
          const g = (k) => document.querySelector(`[data-o="${oi}"][data-f="${fi}"][data-k="${k}"]`);
          f.type = g('type').value;
          f.amount = parseAmount(g('amount').value);
          if (g('expense')) f.expense_id = Number(g('expense').value) || null;
          if (g('label')) f.label = g('label').value.trim();
          if (g('cat')) f.category_id = g('cat').value ? Number(g('cat').value) : null;
        });
      });
    };
    const draw = () => {
      $('#decOpts').innerHTML = dd.options.map((o, oi) => `<div class="optedit">
        <div class="mrow"><input data-o="${oi}" data-k="label" value="${esc(o.label)}" placeholder="Option, z. B. „Ja, mit Holzfaser“" style="flex:1;font-weight:600">
          ${dd.options.length > 1 ? `<button type="button" class="iconbtn" data-delopt="${oi}" title="Option entfernen">✕</button>` : ''}</div>
        <input data-o="${oi}" data-k="note" value="${esc(o.note || '')}" placeholder="Notiz (optional)" style="width:100%;margin-top:6px">
        ${o.effects.map((f, fi) => `<div class="effrow">
          <select data-o="${oi}" data-f="${fi}" data-k="type"><option value="set" ${f.type === 'set' ? 'selected' : ''}>Position kostet</option><option value="add" ${f.type !== 'set' ? 'selected' : ''}>Zusätzliche Kosten</option></select>
          ${f.type === 'set' ? `<select data-o="${oi}" data-f="${fi}" data-k="expense" class="grow">${posOpts(f.expense_id)}</select>`
            : `<input data-o="${oi}" data-f="${fi}" data-k="label" value="${esc(f.label || '')}" placeholder="Bezeichnung" class="grow"><select data-o="${oi}" data-f="${fi}" data-k="cat">${catOpts(f.category_id)}</select>`}
          <input data-o="${oi}" data-f="${fi}" data-k="amount" inputmode="decimal" value="${esc(Number.isFinite(f.amount) ? amtInput(f.amount) : '')}" placeholder="€ (negativ = Einsparung)" class="amt">
          <button type="button" class="iconbtn" data-deleff="${oi}:${fi}">✕</button></div>`).join('')}
        <button type="button" class="iconbtn linkbtn" data-addeff="${oi}">+ Kostenänderung</button>
      </div>`).join('');
    };
    openModal(`<h2>${src ? 'Entscheidung bearbeiten' : 'Neue Entscheidung'}</h2>
      <div class="form">
        <label class="full">Frage *<input id="decTitle" value="${esc(dd.title)}" placeholder="z. B. Holzfaserdämmung bei FingerHaus?"></label>
        <label class="full">Notiz<input id="decNote" value="${esc(dd.note || '')}" placeholder="Worauf es ankommt, bis wann entschieden werden muss …"></label>
      </div>
      <div class="small muted" style="margin:12px 0 6px">Optionen: je Option, welche Position wie viel kostet oder welche Kosten dazukommen.</div>
      <div id="decOpts"></div>
      <button type="button" class="iconbtn" id="addOpt" style="margin-top:6px">+ Option</button>
      <div class="err" id="decErr"></div>
      <div class="actions">${src ? '<button class="danger" id="delDec">Löschen</button>' : ''}<span class="spacer"></span><button id="cancel">Abbrechen</button><button class="primary" id="saveDec">Speichern</button></div>`);
    draw();
    $('#cancel').onclick = closeModal;
    $('#dlg').addEventListener('click', (ev) => {
      const t = ev.target;
      if (t.id === 'addOpt') { read(); dd.options.push({ id: 'o' + (Math.max(0, ...dd.options.map((o) => Number(String(o.id).replace(/\D/g, '')) || 0)) + 1), label: '', note: '', effects: [] }); draw(); }
      else if (t.dataset.delopt) { read(); dd.options.splice(Number(t.dataset.delopt), 1); draw(); }
      else if (t.dataset.addeff) { read(); dd.options[Number(t.dataset.addeff)].effects.push({ type: 'set', expense_id: null, amount: NaN }); draw(); }
      else if (t.dataset.deleff) { read(); const [oi, fi] = t.dataset.deleff.split(':').map(Number); dd.options[oi].effects.splice(fi, 1); draw(); }
    });
    $('#dlg').addEventListener('change', (ev) => { if (ev.target.dataset.k === 'type') { read(); draw(); } });
    if ($('#delDec')) $('#delDec').onclick = async () => {
      const b = $('#delDec'); if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Wirklich löschen?'; return; }
      try { await api('DELETE', '/api/decisions/' + src.id); closeModal(); await load(); } catch (e) { $('#decErr').textContent = e.message; }
    };
    $('#saveDec').onclick = async () => {
      read();
      const err = (m) => { $('#decErr').textContent = m; };
      if (!dd.title) return err('Bitte die Frage eintragen.');
      for (const o of dd.options) {
        if (!o.label) return err('Bitte jeder Option einen Namen geben.');
        for (const f of o.effects) {
          if (!Number.isFinite(f.amount)) return err(`Option „${o.label}“: Betrag fehlt oder nicht erkannt.`);
          if (f.type === 'set' && !f.expense_id) return err(`Option „${o.label}“: bitte eine Position wählen.`);
        }
      }
      try {
        if (src) await api('PUT', '/api/decisions/' + src.id, { title: dd.title, note: dd.note, options: dd.options });
        else await api('POST', '/api/decisions', { title: dd.title, note: dd.note, options: dd.options });
        closeModal(); await load();
      } catch (e) { err(e.message); }
    };
  }

  function applyDecisionDialog(did, oid) {
    const d = (S.decisions || []).find((x) => x.id === did); if (!d) return;
    const o = d.options.find((x) => x.id === oid); if (!o) return;
    openModal(`<h2>„${esc(o.label)}“ übernehmen?</h2>
      <div class="muted small">Damit wird „${esc(d.title)}“ als entschieden markiert und die Kosten werden in eure Positionen geschrieben:</div>
      <ul class="eff">${o.effects.map((f) => `<li>${esc(effectLabel(f))}${f.type === 'add' ? ' <span class="muted">(neue Position)</span>' : ''}</li>`).join('')}</ul>
      <div class="muted small">Vorher wird automatisch ein Backup angelegt.</div>
      <div class="err" id="apErr"></div>
      <div class="actions"><span class="spacer"></span><button id="cancel">Abbrechen</button><button class="primary" id="doApply">Übernehmen</button></div>`);
    $('#cancel').onclick = closeModal;
    $('#doApply').onclick = async () => {
      try { await api('POST', `/api/decisions/${did}/apply`, { option_id: oid }); closeModal(); await load(); }
      catch (e) { $('#apErr').textContent = e.message; }
    };
  }

  function scenarioDialog(id) {
    const sc = id ? (S.scenarios || []).find((x) => x.id === id) : null;
    const ch = sc ? { ...sc.choices } : {};
    openModal(`<h2>${sc ? 'Szenario bearbeiten' : 'Neues Szenario'}</h2>
      <div class="form">
        <label class="full">Name *<input id="scName" value="${esc(sc ? sc.name : '')}" placeholder="z. B. „Sparvariante“ oder „Alles drin“"></label>
        ${openDecisions().map((d) => `<label class="full">${esc(d.title)}<select data-scdec="${d.id}"><option value="">– wie geplant –</option>${d.options.map((o) => `<option value="${esc(o.id)}" ${ch[d.id] === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`).join('')}
      </div>
      <div class="err" id="scErr"></div>
      <div class="actions">${sc ? '<button class="danger" id="delSc">Löschen</button>' : ''}<span class="spacer"></span><button id="cancel">Abbrechen</button><button class="primary" id="saveSc">Speichern</button></div>`);
    $('#cancel').onclick = closeModal;
    if ($('#delSc')) $('#delSc').onclick = async () => {
      const b = $('#delSc'); if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Wirklich löschen?'; return; }
      await api('DELETE', '/api/scenarios/' + sc.id); closeModal(); await load();
    };
    $('#saveSc').onclick = async () => {
      const name = $('#scName').value.trim(); if (!name) { $('#scErr').textContent = 'Bitte einen Namen eingeben.'; return; }
      const choices = {}; document.querySelectorAll('[data-scdec]').forEach((s2) => { if (s2.value) choices[s2.dataset.scdec] = s2.value; });
      try {
        if (sc) await api('PUT', '/api/scenarios/' + sc.id, { name, choices }); else await api('POST', '/api/scenarios', { name, choices });
        closeModal(); await load();
      } catch (e) { $('#scErr').textContent = e.message; }
    };
  }

  // ---------- Gewährleistung ----------
  const WARRANTY = [
    { m: 24, l: '2 Jahre – Kauf / Lieferung (z. B. Küche, Geräte)' },
    { m: 48, l: '4 Jahre – Bauvertrag nach VOB/B' },
    { m: 60, l: '5 Jahre – Bauwerk nach BGB (Werkvertrag)' },
  ];
  const isoToday = () => new Date().toISOString().slice(0, 10);
  function addMonthsIso(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1 + n, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(d, last));
    return t.toISOString().slice(0, 10);
  }
  const daysUntil = (iso) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(isoToday() + 'T00:00:00Z')) / 864e5);
  function warrantyOf(e) {
    const start = e.warranty_start || (e.status === 'bezahlt' ? e.date : '');
    if (!e.warranty_months || !start) return null;
    const end = addMonthsIso(start, e.warranty_months);
    const check = addMonthsIso(end, -3);
    const left = daysUntil(end);
    return { start, end, check, left, state: left < 0 ? 'abgelaufen' : left <= 90 ? 'bald' : daysUntil(check) <= 0 ? 'begehung' : 'laeuft', implicit: !e.warranty_start };
  }
  const W_LABEL = { abgelaufen: 'abgelaufen', bald: 'endet bald', begehung: 'Begehung fällig', laeuft: 'läuft' };
  const durLabel = (m) => (m % 12 === 0 ? `${m / 12} J.` : `${m} Mon.`);

  function viewWarranty() {
    const rows = S.expenses.map((e) => ({ e, w: warrantyOf(e) })).filter((x) => x.w).sort((a, b) => a.w.end.localeCompare(b.w.end));
    const missing = S.expenses.filter((e) => e.status === 'bezahlt' && counts(e) && !e.warranty_months).sort(byCode);
    let html = `<div class="note" style="margin-top:0">Für jede bezahlte Leistung läuft eine Gewährleistungsfrist ab der <b>Abnahme</b>. Mängel müsst ihr <b>vor</b> Ablauf schriftlich anzeigen – Kassensturz erinnert euch drei Monate vorher an eine Begehung. Die Dauer hängt vom Vertrag ab (keine Rechtsberatung).</div>`;
    html += `<div class="card" style="margin-top:12px"><h2>Fristen</h2>`;
    if (!rows.length) html += `<div class="muted small">Noch keine Gewährleistung eingetragen. Im Dialog einer Position unter „Gewährleistung“ Abnahme und Dauer wählen – oder unten mit einem Klick für bezahlte Positionen setzen.</div>`;
    else if (mobile) {
      html += rows.map(({ e, w }) => `<div class="mcard click" data-edit="${e.id}"><div class="top"><span class="ttl">${esc((e.code ? e.code + ' ' : '') + e.title)}</span><span class="chip w-${w.state}">${W_LABEL[w.state]}</span></div>
        <div class="mstats"><div><small>Ende</small><b>${fdate(w.end)}</b></div><div><small>Begehung bis</small>${fdate(w.check)}</div><div><small>Beginn${w.implicit ? ' (Rechnungsdatum)' : ''}</small>${fdate(w.start)}</div><div><small>Firma</small>${esc(e.vendor || '–')}</div></div></div>`).join('');
    } else {
      html += `<div style="overflow-x:auto"><table><thead><tr><th>Position</th><th>Firma</th><th>Beginn</th><th>Dauer</th><th>Begehung bis</th><th>Ende</th><th></th></tr></thead><tbody>
        ${rows.map(({ e, w }) => `<tr class="click" data-edit="${e.id}"><td>${esc((e.code ? e.code + ' ' : '') + e.title)}${e.warranty_note ? `<div class="muted small">${esc(e.warranty_note)}</div>` : ''}</td>
          <td class="small">${esc(e.vendor || '–')}</td><td class="small">${fdate(w.start)}${w.implicit ? '<div class="muted small">Rechnungsdatum</div>' : ''}</td>
          <td class="small">${durLabel(e.warranty_months)}</td><td class="small">${fdate(w.check)}</td><td><b>${fdate(w.end)}</b></td><td><span class="chip w-${w.state}">${W_LABEL[w.state]}</span></td></tr>`).join('')}
      </tbody></table></div>`;
    }
    html += `</div>`;
    if (missing.length) {
      html += `<div class="card" style="margin-top:12px"><h2>Bezahlt, aber ohne Gewährleistungsfrist</h2><div class="muted small" style="margin-bottom:8px">Beginn = Abnahme. Falls unbekannt, nimmt Kassensturz das Rechnungsdatum bzw. heute.</div>
        ${missing.map((e) => `<div class="mrow wrow"><span style="flex:1">${esc((e.code ? e.code + ' ' : '') + e.title)}<span class="muted small"> · ${esc(e.vendor || '')} ${e.date ? fdate(e.date) : ''}</span></span>
          ${WARRANTY.map((p) => `<button class="iconbtn" data-setw="${e.id}:${p.m}" title="${esc(p.l)}">${durLabel(p.m)}</button>`).join('')}</div>`).join('')}</div>`;
    }
    // Kalender-Abo
    html += `<div class="card" style="margin-top:12px"><h2>Fristen im Handy-Kalender</h2>
      <div class="muted small">Ein Kalender-Abo mit allen Zahlungs-Fälligkeiten, Begehungs-Terminen und Gewährleistungsenden – mit Erinnerung. Funktioniert mit iPhone/Mac-Kalender und unter Android z. B. mit ICSx⁵, solange das Gerät eure NAS erreicht (z. B. über Tailscale). Google Kalender im Browser kann die NAS nicht erreichen.</div>
      <div id="icsBox" style="margin-top:10px"><button id="icsShow">Abo-Link anzeigen</button></div></div>`;
    return html;
  }
  async function showIcs(regenerate) {
    const box = $('#icsBox'); if (!box) return;
    try {
      let t = regenerate ? (await api('POST', '/api/calendar/token')).token : (await api('GET', '/api/calendar/token')).token;
      if (!t) t = (await api('POST', '/api/calendar/token')).token;
      const http = `${location.origin}/api/calendar.ics?token=${t}`;
      const webcal = http.replace(/^https?:/, 'webcal:');
      box.innerHTML = `<div class="mrow" style="flex-wrap:wrap"><a class="btn primary" href="${esc(webcal)}">Im Kalender abonnieren</a><button id="icsCopy" data-url="${esc(http)}">Link kopieren</button><button id="icsNew">Neuen Link erzeugen</button></div>
        <div class="small muted" style="margin-top:8px;overflow-wrap:anywhere">${esc(http)}</div>
        <div class="small muted" style="margin-top:4px">Der Link ist geheim: Wer ihn kennt, sieht eure Fristen (keine Beträge der Finanzierung). „Neuen Link erzeugen“ macht den alten ungültig.</div>`;
    } catch (e) { box.textContent = e.message; }
  }

  // ---------- Leistungsbeschreibung / Angebote ----------
  let docAnalysis = null; let docAnalysisRev = -1; let docLoading = false; let docFilter = 'fund';
  const V = {
    ja: { l: '✓ enthalten', c: 'v-ja' }, nein: { l: '✗ nicht enthalten', c: 'v-nein' }, 'nein?': { l: '✗? eher nicht', c: 'v-nein' },
    teils: { l: '◐ teilweise', c: 'v-unklar' }, erwaehnt: { l: '? erwähnt', c: 'v-unklar' }, unklar: { l: '? unklar', c: 'v-unklar' }, fehlt: { l: '– nicht erwähnt', c: 'v-fehlt' },
  };
  const SUGGEST = { ja: 'ja', nein: 'nein', 'nein?': 'nein', teils: 'pruefen', erwaehnt: 'pruefen', unklar: 'pruefen', fehlt: null };
  async function loadDocAnalysis() {
    if (docLoading) return;
    docLoading = true;
    try { docAnalysis = (await api('GET', '/api/documents/analysis')).documents; docAnalysisRev = S.rev; }
    catch (e) { docAnalysis = { error: e.message }; }
    docLoading = false;
    if (tab === 'planung' && planTab === 'leistungsbeschreibung') render();
  }
  function viewDocuments() {
    const ds = S.documents || [];
    let html = `<div class="toolbar"><div class="muted">Bau- und Leistungsbeschreibung oder Angebot als PDF hochladen. Kassensturz sucht zu jeder Position die passende Textstelle und schlägt „Im Hauspreis?“ vor – mehrere Dokumente nebeneinander = Anbieter-Vergleich.</div>
      <span class="spacer"></span>${ocrOn() ? '<button class="primary" id="addDoc">+ Dokument</button>' : ''}</div>`;
    if (!ds.length) return html + `<div class="card"><div class="empty">Noch kein Dokument. Lade z. B. die Bau- und Leistungsbeschreibung von FingerHaus und von Büdenbender hoch.</div></div>`;
    if (docAnalysisRev !== S.rev) { loadDocAnalysis(); }
    html += `<div class="doclist">${ds.map((d) => `<div class="docchip"><b>${esc(d.title)}</b><span class="muted small">${esc(d.vendor || '')} · ${d.pages} S. · ${fsize(d.size)}</span>
      <a class="iconbtn" href="/api/documents/${d.id}/file" target="_blank" rel="noopener">Öffnen</a><button class="iconbtn" data-applydoc="${d.id}">Vorschläge übernehmen</button><button class="iconbtn" data-deldoc="${d.id}">✕</button></div>`).join('')}</div>`;
    if (!docAnalysis || docAnalysis.error) return html + `<div class="card"><div class="muted">${docAnalysis && docAnalysis.error ? esc(docAnalysis.error) : 'Prüfe Dokumente …'}</div></div>`;
    const A = new Map(docAnalysis.map((a) => [a.id, a]));
    const cols = ds.filter((d) => A.has(d.id));
    const keep = (e) => {
      const vs = cols.map((d) => (A.get(d.id).byExpense[e.id] || {}).verdict);
      if (docFilter === 'alle') return true;
      if (docFilter === 'diff') return vs.some((v) => SUGGEST[v] && SUGGEST[v] !== e.included) || (cols.length > 1 && new Set(vs.map((v) => SUGGEST[v] || '-')).size > 1);
      return vs.some((v) => v && v !== 'fehlt');
    };
    html += `<div class="toolbar"><select id="docFilter"><option value="fund" ${docFilter === 'fund' ? 'selected' : ''}>Nur Positionen mit Fundstelle</option><option value="diff" ${docFilter === 'diff' ? 'selected' : ''}>Nur Abweichungen</option><option value="alle" ${docFilter === 'alle' ? 'selected' : ''}>Alle Positionen</option></select>
      <span class="muted small">Klick auf ein Ergebnis zeigt die Textstelle.</span></div>`;
    const groups = S.categories.map((c) => ({ c, items: S.expenses.filter((e) => e.category_id === c.id && keep(e)).sort(byCode) })).filter((g) => g.items.length);
    const cell = (d, e) => { const r = A.get(d.id).byExpense[e.id] || { verdict: 'fehlt' }; const v = V[r.verdict] || V.fehlt;
      return `<button class="vchip ${v.c}" data-docfind="${d.id}:${e.id}">${v.l}${r.page ? `<span class="pg">S. ${r.page}</span>` : ''}</button>`; };
    if (!groups.length) html += `<div class="card"><div class="muted">Keine Positionen für diesen Filter.</div></div>`;
    else if (mobile) {
      html += groups.map((g) => `<details class="mgroup" open><summary><span class="nm">${esc(g.c.name)}</span></summary>${g.items.map((e) => `<div class="mcard">
        <div class="top"><span class="code">${esc(e.code)}</span><span class="ttl">${esc(e.title)}</span><span class="chip i-${e.included}">${IL[e.included]}</span></div>
        <div class="vlist">${cols.map((d) => `<div class="mrow"><span class="small muted" style="flex:1">${esc(d.vendor || d.title)}</span>${cell(d, e)}</div>`).join('')}</div></div>`).join('')}</details>`).join('');
    } else {
      html += `<div class="card" style="padding:4px 8px;overflow-x:auto"><table class="doctable"><thead><tr><th>Nr</th><th>Kostenpunkt</th><th>Im Hauspreis?</th>${cols.map((d) => `<th>${esc(d.vendor || d.title)}</th>`).join('')}</tr></thead>
        ${groups.map((g) => `<tbody><tr class="group"><td colspan="${3 + cols.length}">${esc(g.c.name)}</td></tr>${g.items.map((e) => `<tr><td class="small muted">${esc(e.code)}</td><td>${esc(e.title)}</td><td><span class="chip i-${e.included}">${IL[e.included]}</span></td>${cols.map((d) => `<td>${cell(d, e)}</td>`).join('')}</tr>`).join('')}</tbody>`).join('')}
      </table></div>`;
    }
    // Kostenfallen
    cols.forEach((d) => {
      const tr = A.get(d.id).traps;
      if (!tr.length) return;
      html += `<details class="card traps" style="margin-top:12px"><summary><b>Mögliche Kostenfallen in „${esc(d.title)}“</b> <span class="muted small">${tr.length} Stellen mit „nicht enthalten“, „bauseits“, „Eigenleistung“ … ohne passende Position</span></summary>
        ${tr.map((x, i) => `<div class="trap"><span class="pg">S. ${x.page}</span><span style="flex:1">${esc(x.snippet)}</span><button class="iconbtn" data-trap="${d.id}:${i}">Als Position anlegen</button></div>`).join('')}</details>`;
    });
    return html;
  }
  function docFindDialog(did, eid) {
    const d = (S.documents || []).find((x) => x.id === did); const e = S.expenses.find((x) => x.id === eid);
    const a = docAnalysis && docAnalysis.find((x) => x.id === did); if (!d || !e || !a) return;
    const r = a.byExpense[e.id] || { verdict: 'fehlt' };
    const v = V[r.verdict] || V.fehlt; const sug = SUGGEST[r.verdict];
    const mark = (t) => { let h = esc(t); [/(nicht\s+enthalten|bauseits|eigenleistung|gegen\s+aufpreis|mehrpreis|aufpreis|entf(?:ä|ae)llt|optional|sonderwunsch|nicht\s+im\s+\w+)/gi, /(enthalten|inklusive|inkl\.|im\s+lieferumfang|serienm(?:ä|ae)(?:ss|ß)ig)/gi].forEach((re, i) => { h = h.replace(re, (x) => `<mark class="${i ? 'mpos' : 'mneg'}">${x}</mark>`); }); return h; };
    openModal(`<h2>${esc((e.code ? e.code + ' ' : '') + e.title)}</h2>
      <div class="muted small">${esc(d.title)}${d.vendor ? ' · ' + esc(d.vendor) : ''}</div>
      <div style="margin:10px 0"><span class="vchip ${v.c}">${v.l}</span> <span class="muted small">aktuell „Im Hauspreis?“: <b>${IL[e.included]}</b></span></div>
      ${r.snippet ? `<blockquote class="quote"><span class="pg">S. ${r.page}</span> ${mark(r.snippet)}</blockquote>${(r.more || []).map((x) => `<blockquote class="quote dim"><span class="pg">S. ${x.page}</span> ${mark(x.snippet)}</blockquote>`).join('')}`
        : '<div class="muted">Im Dokument wurde zu dieser Position nichts gefunden. Bei einer Leistungsbeschreibung heißt das meist: nicht enthalten.</div>'}
      <div class="small muted" style="margin-top:10px">„Im Hauspreis?“ setzen:</div>
      <div class="mrow" style="margin-top:6px;flex-wrap:wrap">${INCL.map((x) => `<button class="${sug === x.k ? 'primary' : ''}" data-setincl="${x.k}">${x.l}${sug === x.k ? ' (Vorschlag)' : ''}</button>`).join('')}</div>
      <div class="err" id="dfErr"></div>
      <div class="actions"><a class="btn" href="/api/documents/${d.id}/file#page=${r.page || 1}" target="_blank" rel="noopener">Dokument öffnen</a><span class="spacer"></span><button id="cancel">Schließen</button></div>`);
    $('#cancel').onclick = closeModal;
    document.querySelectorAll('[data-setincl]').forEach((b) => { b.onclick = async () => {
      try { await api('POST', '/api/documents/apply', { changes: [{ expense_id: e.id, included: b.dataset.setincl }] }); closeModal(); await load(); }
      catch (err) { $('#dfErr').textContent = err.message; }
    }; });
  }
  function applyDocDialog(did) {
    const d = (S.documents || []).find((x) => x.id === did); const a = docAnalysis && docAnalysis.find((x) => x.id === did);
    if (!d || !a) return;
    const rows = S.expenses.map((e) => ({ e, r: a.byExpense[e.id] })).filter(({ e, r }) => r && SUGGEST[r.verdict] && SUGGEST[r.verdict] !== e.included).sort((x, y) => byCode(x.e, y.e));
    openModal(`<h2>Vorschläge aus „${esc(d.title)}“</h2>
      <div class="muted small">Nur sinnvoll für das Angebot, für das ihr euch entscheidet. Sicher erkannte Fundstellen sind vorausgewählt – bitte kurz prüfen.</div>
      ${rows.length ? `<div class="applylist">${rows.map(({ e, r }) => `<label class="mrow"><input type="checkbox" data-apply="${e.id}" data-to="${SUGGEST[r.verdict]}" ${r.verdict === 'ja' || r.verdict === 'nein' ? 'checked' : ''}>
        <span style="flex:1">${esc((e.code ? e.code + ' ' : '') + e.title)}<span class="muted small"> · S. ${r.page}</span></span><span class="chip i-${e.included}">${IL[e.included]}</span> → <span class="chip i-${SUGGEST[r.verdict]}">${IL[SUGGEST[r.verdict]]}</span></label>`).join('')}</div>`
        : '<div class="empty">Keine Abweichungen – eure Einordnung passt zu diesem Dokument.</div>'}
      <div class="err" id="adErr"></div>
      <div class="actions"><span class="spacer"></span><button id="cancel">Abbrechen</button>${rows.length ? '<button class="primary" id="doApplyDoc">Ausgewählte übernehmen</button>' : ''}</div>`);
    $('#cancel').onclick = closeModal;
    if ($('#doApplyDoc')) $('#doApplyDoc').onclick = async () => {
      const changes = [...document.querySelectorAll('[data-apply]')].filter((c) => c.checked).map((c) => ({ expense_id: Number(c.dataset.apply), included: c.dataset.to }));
      try { await api('POST', '/api/documents/apply', { changes }); closeModal(); await load(); } catch (e) { $('#adErr').textContent = e.message; }
    };
  }
  function uploadDocDialog() {
    openModal(`<h2>Dokument prüfen</h2>
      <form id="docForm" class="form">
        <label class="full">PDF (Bau- und Leistungsbeschreibung, Angebot, Vertrag) *<input type="file" name="file" accept="application/pdf,image/*" required></label>
        <label>Titel<input name="title" placeholder="z. B. Bau- und Leistungsbeschreibung"></label>
        <label>Anbieter<input name="vendor" placeholder="z. B. FingerHaus"></label>
      </form>
      <div class="scanwait" hidden><div class="spin"></div><div class="muted small">Lese das Dokument … lange PDFs oder Scans können eine Minute dauern.</div></div>
      <div class="err" id="docErr"></div>
      <div class="actions"><span class="spacer"></span><button id="cancel">Abbrechen</button><button class="primary" id="doDoc">Hochladen &amp; prüfen</button></div>`);
    $('#cancel').onclick = closeModal;
    $('#doDoc').onclick = async () => {
      const f = $('#docForm'); const file = f.file.files[0];
      if (!file) { $('#docErr').textContent = 'Bitte eine Datei wählen.'; return; }
      $('#doDoc').disabled = true; $('.scanwait').hidden = false; $('#docErr').textContent = '';
      try {
        await api('POST', '/api/documents', file, { 'Content-Type': file.type || 'application/pdf', 'X-Filename': encodeURIComponent(file.name),
          'X-Title': encodeURIComponent(f.title.value.trim()), 'X-Vendor': encodeURIComponent(f.vendor.value.trim()) });
        closeModal(); docAnalysisRev = -1; await load();
      } catch (e) { $('#doDoc').disabled = false; $('.scanwait').hidden = true; $('#docErr').textContent = e.message; }
    };
  }

  // ---------- Eingang (Belege aus dem Postfach) ----------
  function inboxCard() {
    const items = S.inbox || [];
    if (!items.length) return '';
    return `<div class="card inbox"><div class="mrow"><h2 style="flex:1;margin:0">📥 Eingang aus dem Postfach <span class="badge">${items.length}</span></h2></div>
      ${items.map((it) => { const f = (it.scan && it.scan.fields) || {};
        return `<div class="inrow"><div style="flex:1;min-width:0"><b>${esc(f.title || it.filename)}</b>
          <div class="muted small">${esc(it.mail_from)}${it.subject ? ' · ' + esc(it.subject) : ''} · ${esc(it.filename)}</div></div>
          <span class="strong">${f.amount ? fmt2.format(f.amount) : ''}</span>
          <button class="iconbtn primary" data-inbox="${it.id}">Prüfen</button><button class="iconbtn" data-inboxdel="${it.id}" title="Verwerfen">✕</button></div>`; }).join('')}</div>`;
  }
  function openInbox(id) {
    const it = (S.inbox || []).find((x) => x.id === id); if (!it) return;
    const result = it.scan && it.scan.fields ? it.scan : { method: '', text: (it.scan && it.scan.error) || '', fields: {}, matches: [], category_id: null };
    const best = result.matches && result.matches[0];
    expenseDialog(best && best.score >= 3 ? best.id : null, { result, file: { name: it.filename, size: it.size }, inboxId: it.id, from: it.mail_from, subject: it.subject });
  }

  // ---------- Nächste Fristen (Übersicht) ----------
  function deadlinesCard() {
    const items = [];
    S.expenses.forEach((e) => {
      if (e.status === 'beauftragt' && e.due && counts(e)) { const d = daysUntil(e.due); if (d <= 30) items.push({ d, date: e.due, e, kind: d < 0 ? 'Zahlung überfällig' : 'Zahlung fällig', cls: d < 0 ? 'neg' : '' }); }
      const w = warrantyOf(e);
      if (w) {
        const dc = daysUntil(w.check);
        if (w.left >= 0 && dc <= 60) items.push({ d: Math.max(dc, 0), date: dc > 0 ? w.check : w.end, e, kind: dc > 0 ? 'Begehung vor Gewährleistungsende' : 'Gewährleistung endet', cls: w.left <= 30 ? 'neg' : '' });
      }
    });
    items.sort((a, b) => a.date.localeCompare(b.date));
    const nIn = (S.inbox || []).length;
    if (!items.length && !nIn) return '';
    return `<div class="card"><h2>Nächste Fristen</h2>
      ${nIn ? `<a class="inlink" href="#kosten">📥 ${nIn} neue${nIn === 1 ? 'r Beleg' : ' Belege'} im Eingang</a>` : ''}
      ${items.length ? `<table><tbody>${items.slice(0, 8).map((x) => `<tr class="click" data-edit="${x.e.id}"><td>${esc(x.e.title)}<div class="small ${x.cls || 'muted'}">${x.kind}</div></td><td class="num small">${fdate(x.date)}<div class="muted">${x.d < 0 ? `seit ${-x.d} T.` : x.d === 0 ? 'heute' : `in ${x.d} T.`}</div></td></tr>`).join('')}</tbody></table>` : ''}
    </div>`;
  }

  // ---------- Beleg scannen ----------
  const ocrOn = () => !!(S.ocr && (S.ocr.pdftotext || S.ocr.tesseract));
  function pickScanFile() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/pdf,image/*';
    inp.onchange = () => { if (inp.files[0]) startScan(inp.files[0]); };
    inp.click();
  }
  async function startScan(file) {
    if (file.size > 25 * 1024 * 1024) { setSync('Datei zu groß (max. 25 MB)', 'warn'); return; }
    let aborted = false;
    openModal(`<h2>Beleg wird gelesen …</h2><div class="muted small">${esc(file.name)} · ${fsize(file.size)}</div>
      <div class="scanwait"><div class="spin"></div><div class="muted small">Fotos und Scans dauern ein paar Sekunden.</div></div>
      <div class="err" id="scanErr"></div>
      <div class="actions"><span class="spacer"></span><button id="cancel">Abbrechen</button></div>`);
    $('#cancel').onclick = () => { aborted = true; closeModal(); };
    try {
      const r = await api('POST', '/api/scan', file, { 'Content-Type': file.type || 'application/octet-stream' });
      if (aborted) return;
      const best = r.matches[0];
      expenseDialog(best && best.score >= 3 ? best.id : null, { result: r, file });
    } catch (err) {
      if (aborted) return;
      $('.scanwait').hidden = true;
      $('#scanErr').textContent = err.message;
      $('#cancel').textContent = 'Schließen';
    }
  }
  // Datei auf die Kostenliste ziehen = Beleg scannen
  document.addEventListener('dragover', (ev) => { if (tab === 'kosten' && ocrOn() && !$('#modal').classList.contains('open')) { ev.preventDefault(); document.body.classList.add('dropping'); } });
  document.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) document.body.classList.remove('dropping'); });
  document.addEventListener('drop', (ev) => {
    document.body.classList.remove('dropping');
    if (tab !== 'kosten' || !ocrOn() || $('#modal').classList.contains('open')) return;
    ev.preventDefault();
    const f = ev.dataTransfer.files[0]; if (f) startScan(f);
  });

  // ---------- Events ----------
  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (t.closest('a')) return; // Links in Zeilen öffnen, nicht den Dialog
    const row = t.closest('[data-edit]'); if (row) { expenseDialog(Number(row.dataset.edit)); return; }
    const ld = t.closest('[data-loandetail]');
    if (ld) { const k = ld.dataset.loandetail; if (openLoans.has(k)) openLoans.delete(k); else openLoans.add(k); render(); return; }
    if (t.closest('details.plan') || t.closest('.loanbox')) return;
    const sr = t.closest('[data-editsrc]'); if (sr) { sourceDialog(Number(sr.dataset.editsrc)); return; }
    try {
      if (t.id === 'addExp') { expenseDialog(null); return; }
      if (t.id === 'scanDoc') { pickScanFile(); return; }
      if (t.id === 'addDecision') { decisionDialog(null); return; }
      if (t.dataset.editdec) { decisionDialog(Number(t.dataset.editdec)); return; }
      if (t.dataset.reopendec) { await mutate('PUT', '/api/decisions/' + t.dataset.reopendec, { reopen: true }); return; }
      if (t.dataset.applyopt) { const [a, b] = t.dataset.applyopt.split(':'); applyDecisionDialog(Number(a), b); return; }
      if (t.id === 'addScenario') { scenarioDialog(null); return; }
      if (t.dataset.editsc) { scenarioDialog(Number(t.dataset.editsc)); return; }
      if (t.dataset.setw) {
        const [eid, months] = t.dataset.setw.split(':').map(Number); const e = S.expenses.find((x) => x.id === eid); if (!e) return;
        await mutate('PUT', '/api/expenses/' + eid, { ...e, category_id: e.category_id, warranty_months: months, warranty_start: e.warranty_start || e.date || isoToday() });
        return;
      }
      if (t.id === 'icsShow') { showIcs(false); return; }
      if (t.id === 'icsNew') { if (!t.dataset.armed) { t.dataset.armed = '1'; t.textContent = 'Alter Link wird ungültig – sicher?'; return; } showIcs(true); return; }
      if (t.id === 'icsCopy') { try { await navigator.clipboard.writeText(t.dataset.url); t.textContent = 'Kopiert ✓'; } catch (e) { t.textContent = 'Bitte manuell kopieren'; } return; }
      if (t.id === 'addDoc') { uploadDocDialog(); return; }
      if (t.dataset.deldoc) { if (!t.dataset.armed) { t.dataset.armed = '1'; t.textContent = 'Löschen?'; t.classList.add('danger'); return; } await mutate('DELETE', '/api/documents/' + t.dataset.deldoc); docAnalysisRev = -1; return; }
      if (t.dataset.applydoc) { applyDocDialog(Number(t.dataset.applydoc)); return; }
      if (t.closest('[data-docfind]')) { const [a, b] = t.closest('[data-docfind]').dataset.docfind.split(':').map(Number); docFindDialog(a, b); return; }
      if (t.dataset.trap) {
        const [did, i] = t.dataset.trap.split(':').map(Number); const a = docAnalysis.find((x) => x.id === did); const d = (S.documents || []).find((x) => x.id === did);
        const tr = a && a.traps[i]; if (!tr) return;
        expenseDialog(null, { prefill: { title: tr.snippet.replace(/\s+/g, ' ').slice(0, 80), hint: `Laut „${d ? d.title : 'Dokument'}“, S. ${tr.page}: ${tr.snippet}`, included: 'nein', status: 'geplant' } });
        return;
      }
      if (t.dataset.inbox) { openInbox(Number(t.dataset.inbox)); return; }
      if (t.dataset.inboxdel) { if (!t.dataset.armed) { t.dataset.armed = '1'; t.textContent = 'Verwerfen?'; t.classList.add('danger'); return; } await mutate('POST', `/api/inbox/${t.dataset.inboxdel}/dismiss`); return; }
      if (t.id === 'mailTest' || t.id === 'mailRun') {
        const out = $('#mailOut'); out.className = 'small muted'; out.textContent = t.id === 'mailTest' ? 'Verbinde …' : 'Rufe ab …'; t.disabled = true;
        try {
          if (t.id === 'mailTest') { const r = await api('POST', '/api/mail/test'); out.className = 'okmsg'; out.textContent = `Verbindung ok – ${r.messages} Nachricht(en) im Ordner, ${r.unseen} ungelesen.`; }
          else { const r = await api('POST', '/api/mail/run'); out.className = 'okmsg'; out.textContent = `${r.attachments} Beleg(e) aus ${r.messages} Nachricht(en) übernommen${r.ignoredSenders ? `, ${r.ignoredSenders} von unbekannten Absendern ignoriert` : ''}.`; await load(); }
        } catch (e) { out.className = 'err'; out.textContent = e.message; }
        t.disabled = false; return;
      }
      if (t.id === 'filtToggle') { filtOpen = !filtOpen; render(); return; }
      if (t.dataset.splitmode) { switchSplitMode(t.dataset.for, t.dataset.splitmode); return; }
      if (t.dataset.savesplit) {
        const r = readSplit('src' + t.dataset.savesplit);
        if (!r.ok) { $('#finErr').textContent = r.mode === 'eur' ? `Die Beträge ergeben ${fmt2.format(r.sum)} – sie müssen zusammen ${fmt2.format(r.total)} ergeben.` : `Die Aufteilung ergibt ${pct.format(r.sum)} % – sie muss 100 % ergeben.`; return; }
        t.blur();
        await mutate('PUT', '/api/sources/' + t.dataset.savesplit, { split: { mode: r.mode, values: r.values } });
        $('#finErr').textContent = '';
        return;
      }
      if (t.id === 'filtReset') { filt.cat = ''; filt.inc = ''; filt.st = ''; render(); return; }
      if (t.id === 'addCat') { await mutate('POST', '/api/categories', { name: 'Neuer Bereich', budget: 0 }); return; }
      if (t.id === 'addSrc') { sourceDialog(null); return; }
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
      refreshSplitHint(t.dataset.splitrange);
      return;
    }
    if (t.dataset.split) {
      const prefix = t.dataset.split;
      const box = document.querySelector(`[data-splitbox="${prefix}"]`);
      if (S.users.length === 2 && box) {
        const ins = document.querySelectorAll(`[data-split="${prefix}"]`);
        const other = ins[t.dataset.idx === '0' ? 1 : 0];
        const whole = box.dataset.mode === 'eur' ? Number(box.dataset.total) : 100;
        const v = parseAmount(t.value);
        if (Number.isFinite(v)) other.value = splitVal(Math.max(0, whole - v), box.dataset.mode);
        const range = document.querySelector(`[data-splitrange="${prefix}"]`);
        if (range) range.value = parseAmount(ins[0].value) || 0;
      }
      refreshSplitHint(prefix);
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
    if (t.id === 'docFilter') { docFilter = t.value; render(); return; }
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
    if (t.dataset.splitdef) {
      const id = t.dataset.splitdef.replace('src', '');
      const wrap = document.querySelector(`[data-splitwrap="${t.dataset.splitdef}"]`);
      if (t.checked) { try { t.blur(); await mutate('PUT', '/api/sources/' + id, { split: null }); } catch (err) { $('#finErr').textContent = err.message; } }
      else if (wrap) wrap.hidden = false;
      return;
    }
    if (t.dataset.src) {
      const s = S.sources.find((x) => x.id === Number(t.dataset.src)); if (!s) return;
      const fld = t.dataset.f; let v = t.value;
      const err = (m) => { $('#finErr').textContent = m; };
      if (fld === 'amount' || fld === 'rate') { v = v.trim() === '' ? (fld === 'rate' ? null : 0) : parseAmount(v); if (Number.isNaN(v)) return err('Betrag nicht erkannt.'); }
      else if (fld === 'interest') { v = parseNum(v); if (Number.isNaN(v)) return err('Zinssatz nicht erkannt (z. B. 3,45).'); }
      else if (fld === 'fixed_years' || fld === 'grace_months') { v = v.trim() === '' ? null : Number(v); if (v != null && !Number.isInteger(v)) return err('Bitte eine ganze Zahl eingeben.'); }
      else if (fld === 'start') { v = parseMonth(v); if (v === null) return err('Erste Rate bitte als Monat angeben, z. B. 03.2027.'); }
      if ((s[fld] ?? null) === v) return;
      const body = { [fld]: v };
      // Aufteilung in € passt nach Ratenänderung nicht mehr → auf Standard zurück
      const ref = s.kind === 'darlehen' ? 'rate' : 'amount';
      if ((fld === ref || fld === 'kind') && s.split && normSplit(s.split).mode === 'eur') body.split = null;
      try { if (fld === 'kind') t.blur(); await mutate('PUT', '/api/sources/' + s.id, body); err(''); }
      catch (e2) { err(e2.message); }
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
        if (!r.ok) { $('#setErr').textContent = `Die Aufteilung ergibt ${pct.format(r.sum)} % – sie muss 100 % ergeben.`; return; }
        body.default_split = { mode: 'pct', values: r.values };
      }
      try { await mutate('PUT', '/api/settings', body); const ok = $('#setOk'); if (ok) ok.textContent = 'Gespeichert.'; }
      catch (e) { $('#setErr').textContent = e.message; }
      return;
    }
    if (f.id === 'mailForm') {
      ev.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      const secure = d.secure !== 'plain';
      const out = $('#mailOut');
      try {
        await api('PUT', '/api/mail', { enabled: !!d.enabled, host: d.host, port: secure ? 993 : 143, secure, user: d.user, pass: d.pass || '', folder: d.folder, done_folder: d.done_folder, allowed: d.allowed, interval: Number(d.interval) });
        await load(); const o2 = $('#mailOut'); if (o2) { o2.className = 'okmsg'; o2.textContent = 'Gespeichert.'; }
      } catch (e) { out.className = 'err'; out.textContent = e.message; }
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
    if (PLAN_TABS.includes(h)) { planTab = h; h = 'planung'; }
    tab = TABS.includes(h) ? h : 'uebersicht'; render();
  }
  window.addEventListener('hashchange', route);

  start();
})();
