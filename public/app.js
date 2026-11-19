'use strict';

const app = document.getElementById('app');
const RIBBON = '<svg class="ribbon" viewBox="0 0 64 64" aria-hidden="true"><g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="7"><path d="M31 8C21 8 19 21 28 31L41 55" stroke="#e0287f"/><path d="M33 8c10 0 12 13 3 23L23 55" stroke="#f06aa6"/></g></svg>';
// "Dig Pink ..." puts the awareness ribbon between the first two words; other names get it above the title
const titleHtml = (name) => {
  const m = /^(\S+)\s+(Pink)\b(.*)$/i.exec(name);
  return m && /^dig$/i.test(m[1]) ? `${esc(m[1])}${RIBBON.replace('class="ribbon"', 'class="ribbon inline"')}${esc(m[2] + m[3])}` : esc(name);
};
const LOGO = '<svg viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#b0145c"/><path d="M32 11c-9 0-14 10-8 19l15 21 6-4-12-17c8-8 6-19-1-19z" fill="#fff"/><path d="M24 30l-8 21 6 2 10-17z" fill="#ffd0e3"/></svg>';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = app) => root.querySelector(sel);

let pollTimer = null;
let routeAbort = new AbortController(); // listeners added on #app per page are dropped on navigation
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const pw = sessionStorage.getItem('adminpw');
  if (pw) headers['x-admin-password'] = pw;
  const r = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.headers.get('x-app-version') !== '5') {
    const e = new Error('The server is still running an older version. Stop it (Ctrl+C in Terminal), then run  node server.js  again and refresh.');
    e.status = 0; throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || r.statusText); e.status = r.status; throw e; }
  return data;
}

function copyText(text) {
  const done = () => toast('Copied');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('Press Ctrl/Cmd+C to copy'); }
  ta.remove();
}

function shell(inner, crumbs = '') {
  return `<div class="wrap">
    <div class="top">
      <a class="brand" href="/" data-link>${LOGO}<span>Scoreboard</span></a>
      <div class="crumbs">${crumbs}</div>
    </div>${inner}</div>`;
}

const dateStr = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------------- router ----------------
function navigate(path) { history.pushState({}, '', path); route(); }
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); navigate(a.getAttribute('href')); }
});
window.addEventListener('popstate', route);

function route() {
  stopPolling();
  document.body.classList.remove('game');
  routeAbort.abort(); routeAbort = new AbortController();
  const p = location.pathname.replace(/\/+$/, '') || '/';
  let m;
  if (p === '/') return pageHome();
  if ((m = p.match(/^\/t\/([^/]+)(?:\/([a-z]+))?$/))) return pageTournament(m[1], m[2] || '');
  if ((m = p.match(/^\/g\/([^/]+)$/))) return pageGame(m[1]);
  if ((m = p.match(/^\/b\/([^/]+)$/))) { history.replaceState({}, '', `/t/${m[1]}/playoffs${location.search}`); return pageTournament(m[1], 'playoffs'); }
  if (p === '/admin') return pageAdminHome();
  if ((m = p.match(/^\/admin\/t\/([^/]+)$/))) return pageAdminTournament(m[1]);
  app.innerHTML = shell('<div class="empty">Page not found.</div>');
}

// ---------------- home ----------------
async function pageHome() {
  app.innerHTML = shell('<h1>Tournaments</h1><p class="sub">Pick one to see the live standings.</p><div class="empty">Loading…</div>');
  try {
    const list = await api('/api/tournaments');
    const body = list.length
      ? `<div class="tlist">${list.map((t) => `
          <a class="card tcard" href="/t/${esc(t.id)}" data-link>
            <div><div class="name">${esc(t.name)}</div><div class="meta">${t.date ? longDate(t.date) + ' · ' : ''}${t.location ? esc(t.location) + ' · ' : ''}${plural(t.pools, 'pool')} · ${plural(t.teams, 'team')}</div></div>
            <span class="pill">${t.played}/${t.matches} played</span>
          </a>`).join('')}</div>`
      : '<div class="card empty">No tournaments yet.</div>';
    app.innerHTML = shell(`<h1>Tournaments</h1><p class="sub">Pick one to see the live standings.</p>${body}`, '<a href="/admin" data-link>Organizer</a>');
  } catch (e) { app.innerHTML = shell(`<div class="empty">${esc(e.message)}</div>`); }
}

// ---------------- public tournament pages (Information / Teams / Pools / Games / Playoffs) ----------------
const TABS = [['info', 'Information'], ['teams', 'Teams'], ['pools', 'Pools'], ['games', 'Games'], ['playoffs', 'Playoffs']];
const ord = (n) => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };
const longDate = (d) => { if (!d) return ''; const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); };
const clock12 = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
const poolLabel = (p) => p.name + (p.court ? ' — ' + p.court : '');
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');

async function pageTournament(id, tab) {
  if (!TABS.some((t) => t[0] === tab)) tab = '';
  let last = '', data = null, bdata = null, jump = true;
  const q = new URLSearchParams(location.search);
  let selPool = q.get('pool') || sessionStorage.getItem('pool:' + id) || '';
  let selBr = q.get('bracket') || '';
  let selRound = null, zoom = 1;
  const openRows = new Set();
  const base = '/t/' + encodeURIComponent(id);

  // ----- tab contents -----
  function infoHtml() {
    const i = data.info;
    const rows = [
      ['First game', clock12(i.startTime)],
      ['Pace', `About ${i.gameMinutes} minutes per game`],
      ['Pool play', data.rules.poolText],
      ['Playoffs', `Top ${data.goldCount} of each pool go to Gold, everyone else to Silver. Single elimination. ${data.rules.bracketText}`],
      data.rules.goldFirstText && ['Gold first round', data.rules.goldFirstText],
      data.rules.silverText && ['Silver bracket', data.rules.silverText],
      ['Progress', `${data.progress.played} of ${data.progress.total} pool games played`],
    ].filter(Boolean);
    return `<section class="panel"><h2>Director Notes</h2>${i.notes ? `<p class="notes">${nl2br(i.notes)}</p>` : '<p class="muted">No notes yet.</p>'}</section>
      <section class="panel"><h2>Format</h2><dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>`;
  }

  function rowDetails(key, summary, fields) {
    return `<details class="drow" data-key="${esc(key)}" ${openRows.has(key) ? 'open' : ''}><summary>${summary}</summary>
      <dl class="facts">${fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></details>`;
  }
  const signed = (n) => (n > 0 ? '+' : '') + n;

  function teamsHtml() {
    if (!data.teams.length) return '<div class="panel muted">No teams yet.</div>';
    // Numbered 1..N. Once the playoffs are over that is the final standing; until then it is the seed order:
    // pool finish, then record, then point differential, then points scored.
    const done = data.teams.every((t) => t.place);
    const bySeed = (x, y) => x.rank - y.rank || y.w - x.w || y.diff - x.diff || y.pf - x.pf || x.poolName.localeCompare(y.poolName) || x.name.localeCompare(y.name);
    const manual = data.teams.some((x) => x.tb);
    const list = data.teams.slice().sort(manual ? (x, y) => (x.tb || 1e9) - (y.tb || 1e9) || bySeed(x, y) : done ? (x, y) => x.place - y.place : bySeed);
    return `<div class="count">${plural(list.length, 'team')} · ${manual ? 'ranked by the tournament director' : done ? 'final standings' : 'ranked by pool finish, record and point differential'}</div><div class="dlist">${list.map((t, i) => rowDetails('team-' + t.id,
      `<span class="num">${i + 1}</span><span class="who">${esc(t.name)}</span><span class="tag">${esc(t.poolName)}</span>`,
      [['Pool', esc(t.poolName + (t.court ? ' · ' + t.court : ''))], ['Pool finish', ord(t.rank)], ['Record', `${t.w}–${t.l}`], ['Point diff', signed(t.diff)],
       ['Playoffs', t.bracket ? (t.bracket === 'gold' ? 'Gold' : 'Silver') : 'Not seeded yet'], ['Final place', t.place ? ord(t.place) : '—']])).join('')}</div>`;
  }

  const chips = (items, cur, attr) => `<div class="chips">${items.map(([v, label]) => `<button class="chip ${v === cur ? 'on' : ''}" data-${attr}="${esc(v)}">${esc(label)}</button>`).join('')}</div>`;
  const curPool = (allowAll) => (allowAll && selPool === 'all') ? null : (data.pools.find((p) => p.id === selPool) || data.pools[0]);

  function poolsHtml() {
    if (!data.pools.length) return '<div class="panel muted">No pools yet.</div>';
    const pool = curPool(false);
    const rows = pool.standings.map((r) => rowDetails('pr-' + r.id,
      `<span class="num">${r.rank}</span><span class="who">${esc(r.name)}</span><span class="wl">${r.w}/${r.l}</span>`,
      [['Played', r.p], ['Wins', r.w], ['Losses', r.l], ['Points for', r.pf], ['Points against', r.pa], ['Point diff', signed(r.diff)]])).join('');
    return `${data.pools.length > 1 ? chips(data.pools.map((p) => [p.id, poolLabel(p)]), pool.id, 'pool') : ''}
      <div class="phead"><h2>${esc(pool.name)}</h2><span class="muted">${plural(pool.standings.length, 'team')}</span></div>
      ${pool.court ? `<div class="court">${esc(pool.court)}</div>` : ''}
      ${rows ? `<div class="dtable"><div class="dhead"><span></span><span>Team</span><span>W/L</span></div>${rows}</div>
        <p class="legend">Ranked by wins, then point differential, then points scored.</p>` : '<div class="panel muted">No teams in this pool yet.</div>'}`;
  }

  function matchCard(pool, m, nextId) {
    const name = Object.fromEntries(pool.teams.map((x) => [x.id, x.name]));
    const live = !m.final && (m.sa > 0 || m.sb > 0);
    const status = m.final ? '' : live ? '<span class="chip-live"><span class="dot"></span>Live</span>' : m.id === nextId ? '<span class="chip-next">Up next</span>' : '';
    const row = (nm, sc, win, lose) => `<div class="mc-row ${win ? 'win' : ''} ${lose ? 'lose' : ''}"><span class="nm">${esc(nm)}</span><span class="sc">${m.final || live ? sc : ''}</span></div>`;
    return `<div class="mcard ${live ? 'live' : ''}">
      <div class="mc-head"><a class="mnum" href="/g/${esc(m.id)}" data-link>Match ${m.order}</a><span class="mtime">${esc(m.time)}</span>${status}
        <span class="mc-ref">${m.ref ? `Ref: <b>${esc(m.ref.name)}</b>` : ''}</span></div>
      ${row(name[m.a] || '?', m.sa, m.final && m.sa > m.sb, m.final && m.sa < m.sb)}
      ${row(name[m.b] || '?', m.sb, m.final && m.sb > m.sa, m.final && m.sb < m.sa)}
    </div>`;
  }

  function gamesHtml() {
    if (!data.pools.length) return '<div class="panel muted">No pools yet.</div>';
    const cur = curPool(true);
    const shown = cur ? [cur] : data.pools;
    const filter = data.pools.length > 1 ? chips([['all', 'All pools'], ...data.pools.map((p) => [p.id, poolLabel(p)])], cur ? cur.id : 'all', 'pool') : '';
    return filter + shown.map((p) => {
      const done = p.matches.filter((m) => m.final).length;
      const nextId = (p.matches.find((m) => !m.final) || {}).id;
      return `<section class="gpool"><div class="gp-head"><h2>${esc(poolLabel(p))}</h2>
        <div class="gp-sub"><span>${done}/${p.matches.length} complete</span><a href="${base}/pools?pool=${esc(p.id)}" data-link>≡ Standings</a></div></div>
        ${p.matches.length ? p.matches.map((m) => matchCard(p, m, nextId)).join('') : '<div class="panel muted">Matches appear once the pool has two teams.</div>'}</section>`;
    }).join('');
  }

  // ----- playoffs -----
  function bteam(x, sc, show, win, lose) {
    if (!x) return '<div class="bt-row tbd"><span class="sd"></span><span class="tn2"><b>TBD</b></span><span class="sc"></span></div>';
    return `<div class="bt-row ${win ? 'win' : ''} ${lose ? 'lose' : ''}"><span class="sd">${x.seed == null ? '' : x.seed}</span>
      <span class="tn2"><b>${esc(x.name)}</b>${x.from ? `<small>${esc(x.from)}</small>` : ''}</span><span class="sc">${show ? sc : ''}</span></div>`;
  }
  function slot(m, i, ri, nr) {
    const out = ri < nr - 1;
    let inner;
    if (m.bye) {
      const t = m.a || m.b;
      inner = `<div class="bgame"><div class="bcard bye">${bteam(t, '', false)}<div class="byetag">BYE</div></div></div>`;
    } else {
      const show = m.final || m.live;
      inner = `<div class="bgame"><div class="bg-ref">${m.ref ? `Ref: <b>${esc(m.ref.name)}</b>` : 'Ref: to be decided'}</div>
        <div class="bcard ${m.live ? 'live' : ''}"><div class="bg-head"><a class="mnum" href="/g/${esc(m.id)}" data-link>Game ${m.num}</a><span>${esc(m.time)}</span>${m.court ? `<span>${esc(m.court)}</span>` : ''}</div>
          ${bteam(m.a, m.sa, show, m.final && m.sa > m.sb, m.final && m.sa < m.sb)}${bteam(m.b, m.sb, show, m.final && m.sb > m.sa, m.final && m.sb < m.sa)}</div>
        <div class="bg-foot">Losers finish ${esc(m.losersFinish)}</div></div>`;
    }
    return `<div class="bslot ${ri > 0 ? 'hasin' : ''} ${out ? 'hasout' : ''}" style="--span:${1 << ri}">${inner}${out && i % 2 === 0 ? '<i class="vline"></i>' : ''}</div>`;
  }
  const firstOpenRound = (b) => { const i = b.rounds.findIndex((r) => r.matches.some((m) => !m.bye && !m.final)); return i < 0 ? b.rounds.length - 1 : i; };

  function playoffsHtml() {
    if (!bdata) return '<div class="panel muted">Loading…</div>';
    if (!bdata.ready) {
      return `<div class="panel"><p><b>${bdata.progress.played} of ${bdata.progress.total}</b> pool games played.</p>
        <p class="muted">Brackets fill in automatically once every pool game is finished. Gold: top ${bdata.goldCount} of each pool. Silver: everyone else. Single elimination, ${esc(bdata.bracketText.toLowerCase())}.</p></div>`;
    }
    const b = bdata.brackets.find((x) => x.key === selBr) || bdata.brackets[0];
    if (selRound == null || selRound >= b.rounds.length) selRound = firstOpenRound(b);
    const cols = b.rounds.map((r, ri) => `<div class="bcol" data-col="${ri}"><div class="bcol-title">${esc(r.name)}${b.key === 'gold' && ri === 0 ? `<small>${esc(r.rules)}</small>` : ''}</div>
      <div class="bcol-body">${r.matches.map((m, i) => slot(m, i, ri, b.rounds.length)).join('')}</div></div>`).join('');
    return `${bdata.brackets.length > 1 ? chips(bdata.brackets.map((x) => [x.key, x.name]), b.key, 'br') : ''}
      ${b.champion ? `<div class="champ">🏆 ${esc(b.name)} champion: <b>${esc(b.champion.name)}</b></div>` : ''}
      <div class="rounds">${b.rounds.map((r, ri) => `<button class="chip round ${ri === selRound ? 'on' : ''}" data-round="${ri}">${esc(r.name)}</button>`).join('')}</div>
      <div class="zoombar"><button class="zbtn" data-zoom="-1" aria-label="Zoom out">−</button><button class="zbtn" data-zoom="0">Fit</button><button class="zbtn" data-zoom="1" aria-label="Zoom in">+</button></div>
      <div class="bscroll"><div class="bz"><div class="bz-inner">${cols}</div></div></div>`;
  }

  function applyZoom() {
    const inner = $('.bz-inner'), wrap = $('.bz');
    if (!inner || !wrap) return;
    inner.style.transform = `scale(${zoom})`;
    wrap.style.width = Math.ceil(inner.scrollWidth * zoom) + 'px';
    wrap.style.height = Math.ceil(inner.scrollHeight * zoom) + 'px';
  }
  function scrollToRound(smooth) {
    const sc = $('.bscroll'), col = $(`[data-col="${selRound}"]`);
    if (sc && col) sc.scrollTo({ left: Math.max(0, col.offsetLeft * zoom - 10), behavior: smooth ? 'smooth' : 'auto' });
  }

  // ----- page -----
  function draw() {
    const sc0 = $('.bscroll'), keep = sc0 ? sc0.scrollLeft : 0;
    const i = data.info;
    const body = { info: infoHtml, teams: teamsHtml, pools: poolsHtml, games: gamesHtml, playoffs: playoffsHtml }[tab]();
    app.innerHTML = shell(`
      <div class="hero">${/^dig\s+pink\b/i.test(data.name) ? '' : RIBBON}<h1>${titleHtml(data.name)}</h1>${i.date ? `<div class="hdate">${esc(longDate(i.date))}</div>` : ''}${i.location ? `<div class="hloc">${esc(i.location)}</div>` : ''}</div>
      <nav class="ttabs" aria-label="Tournament sections">${TABS.map(([k, label]) => `<a class="ttab ${k === tab ? 'on' : ''}" href="${base}/${k}" data-link>${label}</a>`).join('')}</nav>
      <div class="tbody tab-${tab}">${body}</div>`, '<a href="/" data-link>All tournaments</a>');
    if (tab === 'playoffs') { applyZoom(); if (jump) { scrollToRound(false); jump = false; } else { const sc = $('.bscroll'); if (sc) sc.scrollLeft = keep; } }
  }

  async function load(first) {
    try {
      data = await api('/api/t/' + encodeURIComponent(id));
      if (tab === 'playoffs') bdata = await api('/api/b/' + encodeURIComponent(id));
      const sig = JSON.stringify([data, bdata]);
      if (sig === last) return;
      last = sig; draw();
    } catch (e) { if (first) app.innerHTML = shell(`<div class="card empty">${esc(e.message)}</div>`, '<a href="/" data-link>All tournaments</a>'); }
  }

  app.addEventListener('click', (e) => {
    if (!data) return;
    const el = e.target.closest('button[data-pool],button[data-br],button[data-round],button[data-zoom]');
    if (!el) return;
    if (el.dataset.pool !== undefined) {
      selPool = el.dataset.pool; sessionStorage.setItem('pool:' + id, selPool);
      history.replaceState({}, '', `${location.pathname}?pool=${encodeURIComponent(selPool)}`); draw();
    } else if (el.dataset.br !== undefined) {
      selBr = el.dataset.br; selRound = null; jump = true;
      history.replaceState({}, '', `${location.pathname}?bracket=${encodeURIComponent(selBr)}`); draw();
    } else if (el.dataset.round !== undefined) {
      selRound = Number(el.dataset.round);
      app.querySelectorAll('.round').forEach((c) => c.classList.toggle('on', c === el));
      scrollToRound(true);
    } else {
      const d = Number(el.dataset.zoom), sc = $('.bscroll'), inner = $('.bz-inner');
      zoom = d === 0 ? Math.max(0.35, Math.min(1, (sc.clientWidth - 4) / inner.scrollWidth)) : Math.max(0.35, Math.min(1.6, +(zoom + d * 0.2).toFixed(2)));
      applyZoom(); if (d === 0) sc.scrollLeft = 0; else scrollToRound(false);
    }
  }, { signal: routeAbort.signal });
  app.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d && d.matches && d.matches('details[data-key]')) { if (d.open) openRows.add(d.dataset.key); else openRows.delete(d.dataset.key); }
  }, { capture: true, signal: routeAbort.signal });

  app.innerHTML = shell('<div class="empty">Loading…</div>');
  await load(true);
  if (!tab && data) { // no tab in the address: open Information when the director left notes, otherwise Pools
    tab = (data.info.notes || data.info.date || data.info.location) ? 'info' : 'pools';
    history.replaceState({}, '', `${base}/${tab}${location.search}`); last = ''; await load(false);
  }
  pollTimer = setInterval(() => load(false), 4000);
}

// ---------------- referee scoreboard ----------------
async function pageGame(mid) {
  let d;
  try { d = await api('/api/g/' + encodeURIComponent(mid)); }
  catch (e) { app.innerHTML = shell(`<div class="card empty">${esc(e.message)}</div>`); return; }

  const pinKey = () => 'refpin:' + d.tournamentId;
  const isAdminSession = !!sessionStorage.getItem('adminpw');
  let pin = localStorage.getItem(pinKey()) || '';
  let canScore = !d.needsPin || isAdminSession; // with a PIN set, scoring unlocks after the PIN is checked
  let inflight = 0;

  document.body.classList.add('game');
  app.innerHTML = shell(`
    <div class="gm">
      <div class="gm-meta" id="meta"></div>
      <div class="gm-rules" id="grules"></div>
      <div class="gm-ref" id="gref"></div>
      <div class="gm-board">
        ${['a', 'b'].map((s) => `
        <div class="gm-side" id="side-${s}">
          <div class="gm-team" id="team-${s}"></div>
          <div class="gm-score" id="sc-${s}">0</div>
          <button class="gm-plus ctl" data-score="${s}:1" aria-label="Add a point">+1</button>
          <button class="gm-minus ctl" data-score="${s}:-1" aria-label="Remove a point">−1</button>
        </div>`).join('')}
      </div>
      <div class="gm-status" id="status"></div>
      <form class="card pinbox" id="pinform" hidden>
        <label for="pin">Referee PIN — enter it to keep score</label>
        <div class="row"><input type="password" id="pin" inputmode="numeric" autocomplete="off"><button class="btn primary" type="submit">Unlock</button></div>
        <div class="err" id="pinerr"></div>
      </form>
      <p class="hint" style="text-align:center"><a id="back" href="#" data-link>Back</a></p>
    </div>`);

  const stop = { signal: routeAbort.signal };

  function paint(g) {
    d = { ...d, ...g };
    $('#meta').innerHTML = `<span class="gm-title">${esc(d.num ? `Game ${d.num} · ${d.label}` : d.label)}</span>
      <span class="gm-sub">${[d.court, d.time].filter(Boolean).map(esc).join(' · ')}</span>`;
    $('#grules').textContent = d.rulesText;
    $('#gref').innerHTML = d.ref ? `Refs: <b>${esc(d.ref.name)}</b>` : '';
    $('#team-a').textContent = d.a.name; $('#team-b').textContent = d.b.name;
    $('#sc-a').textContent = d.sa; $('#sc-b').textContent = d.sb;
    const winner = d.final ? (d.sa > d.sb ? d.a : d.b) : null;
    $('#side-a').classList.toggle('win', !!winner && winner === d.a);
    $('#side-b').classList.toggle('win', !!winner && winner === d.b);
    $('#status').innerHTML = d.final
      ? `<span class="final-badge">Final</span> ${esc(winner.name)} wins ${Math.max(d.sa, d.sb)}–${Math.min(d.sa, d.sb)}`
      : d.waiting ? 'Waiting for earlier games to finish'
      : (d.sa || d.sb) ? '<span class="dot"></span> Live' : 'Not started';
    $('#back').setAttribute('href', d.back);
    $('#back').textContent = d.backText;
    app.querySelectorAll('.ctl').forEach((b) => { b.hidden = !canScore || d.waiting; });
    app.querySelectorAll('.gm-plus').forEach((b) => { b.disabled = d.final; });
    $('#pinform').hidden = canScore;
  }

  async function verifyPin() {
    if (!d.needsPin || isAdminSession || !pin) return;
    try { await api(`/api/g/${encodeURIComponent(mid)}/check`, { method: 'POST', body: { pin } }); canScore = true; }
    catch { localStorage.removeItem(pinKey()); pin = ''; }
  }
  await verifyPin();
  paint(d);

  app.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-score]');
    if (!b) return;
    const [side, delta] = b.dataset.score.split(':');
    if (navigator.vibrate) navigator.vibrate(12);
    inflight++;
    try {
      paint(await api(`/api/g/${encodeURIComponent(mid)}/score`, { method: 'POST', body: { side, delta: Number(delta), pin } }));
    } catch (err) {
      toast(err.message);
      if (err.status === 401) { canScore = false; localStorage.removeItem(pinKey()); pin = ''; paint(d); }
    }
    inflight--;
  }, stop);

  $('#pinform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const attempt = $('#pin').value.trim();
    try {
      await api(`/api/g/${encodeURIComponent(mid)}/check`, { method: 'POST', body: { pin: attempt } });
      pin = attempt; localStorage.setItem(pinKey(), pin); canScore = true; paint(d);
    } catch { $('#pinerr').textContent = 'That PIN is not right.'; }
  });

  // keep spectators (and a second ref) in sync
  pollTimer = setInterval(async () => {
    if (inflight) return;
    try { const g = await api('/api/g/' + encodeURIComponent(mid)); if (!inflight) paint(g); } catch { /* ignore */ }
  }, 3000);
}

// ---------------- admin ----------------
function adminLogin(message) {
  app.innerHTML = shell(`
    <h1>Organizer</h1><p class="sub">Enter the admin password to manage tournaments.</p>
    <form class="card" id="login">
      <div class="field"><label for="pw">Admin password</label><input type="password" id="pw" autocomplete="current-password" autofocus></div>
      <button class="btn primary" type="submit">Sign in</button>
      <div class="err" id="err">${esc(message || '')}</div>
    </form>`, '<a href="/" data-link>Scoreboard</a>');
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    sessionStorage.setItem('adminpw', $('#pw').value);
    try { await api('/api/admin/check'); route(); }
    catch (err) { sessionStorage.removeItem('adminpw'); $('#err').textContent = err.status === 401 ? 'Wrong password.' : err.message; }
  });
}

async function adminGuard(fn) {
  if (!sessionStorage.getItem('adminpw')) return adminLogin();
  try { await fn(); }
  catch (e) {
    if (e.status === 401) { sessionStorage.removeItem('adminpw'); return adminLogin('Session expired — sign in again.'); }
    app.innerHTML = shell(`<div class="card empty">${esc(e.message)}</div>`, '<a href="/admin" data-link>Organizer</a>');
  }
}

function pageAdminHome() {
  adminGuard(async () => {
    const list = await api('/api/admin/tournaments');
    app.innerHTML = shell(`
      <h1>Organizer</h1><p class="sub">Create a tournament, put teams into pools, and the matches schedule themselves.</p>
      <h2>New tournament</h2>
      <form class="card" id="new">
        <div class="field"><label for="name">Name</label><input type="text" id="name" placeholder="Saturday Volleyball Classic" maxlength="40" required></div>
        <div class="row">
          <div class="field"><label for="pools">Number of pools</label><input type="number" id="pools" value="2" min="1" max="12"></div>
          <div class="field"><label for="target">Play to</label><input type="number" id="target" value="21" min="1" max="99"></div>
          <div class="field"><label for="pin">Referee PIN (optional)</label><input type="text" id="pin" maxlength="20" placeholder="e.g. 4821" autocomplete="off"></div>
        </div>
        <div class="hint" style="margin:0 0 14px">Pool play is one game to the score above with a hard cap at the same score (no win-by-2), so 21–20 is a final. Pools are ranked by record, then point differential, then head-to-head. Playoffs: top 3 of each pool play in a Gold bracket, the rest in Silver — single elimination, first to 21, win by 2, no cap. You can change any of this after creating the tournament.</div>
        <button class="btn primary" type="submit">Create tournament</button>
        <div class="err" id="err"></div>
      </form>
      <h2>Your tournaments</h2>
      ${list.length ? `<div class="tlist">${list.map((t) => `
        <a class="card tcard" href="/admin/t/${esc(t.id)}" data-link>
          <div><div class="name">${esc(t.name)}</div><div class="meta">${t.date ? longDate(t.date) + ' · ' : ''}${t.location ? esc(t.location) + ' · ' : ''}${plural(t.pools, 'pool')} · ${plural(t.teams, 'team')}</div></div>
          <span class="pill">${t.played}/${t.matches} played</span></a>`).join('')}</div>` : '<div class="card empty">Nothing yet.</div>'}
      <p class="hint" style="margin-top:24px"><a href="#" id="signout">Sign out</a></p>`, '<a href="/" data-link>Public scoreboard</a>');

    $('#signout').addEventListener('click', (e) => { e.preventDefault(); sessionStorage.removeItem('adminpw'); route(); });
    $('#new').addEventListener('submit', async (e) => {
      e.preventDefault(); $('#err').textContent = '';
      try {
        const r = await api('/api/admin/tournaments', { method: 'POST', body: {
          name: $('#name').value, pools: $('#pools').value, target: $('#target').value, refPin: $('#pin').value } });
        navigate('/admin/t/' + r.id);
      } catch (err) { $('#err').textContent = err.message; }
    });
  });
}

function pageAdminTournament(id) {
  adminGuard(async () => {
    let t = await api('/api/admin/t/' + encodeURIComponent(id));
    const base = '/api/admin/t/' + encodeURIComponent(id);
    const act = async (path, method, body) => {
      try { t = await api(base + path, { method, body }); draw(); }
      catch (e) { toast(e.message); }
    };
    const started = (m) => m.final || m.sa > 0 || m.sb > 0;

    const openGames = new Set(['br-gold', 'br-silver']); // bracket games start expanded
    function refSelect(mid, aId, bId, ref, locked) {
      const groups = t.pools.map((p) => {
        const opts = t.teams.filter((x) => x.pool === p.id && x.id !== aId && x.id !== bId)
          .map((x) => `<option value="${esc(x.id)}" ${locked && ref && ref.id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
        return opts ? `<optgroup label="${esc(p.name)}">${opts}</optgroup>` : '';
      }).join('');
      return `<div class="arow refrow"><label>Referee</label>
        <select data-ref aria-label="Referee">
          <option value="auto" ${locked ? '' : 'selected'}>Auto${!locked ? ' · ' + (ref ? esc(ref.name) : 'to be decided') : ''}</option>${groups}
        </select></div>`;
    }

    function poolCard(pool) {
      const teams = t.teams.filter((x) => x.pool === pool.id);
      const ms = t.matches.filter((m) => m.pool === pool.id);
      const name = Object.fromEntries(t.teams.map((x) => [x.id, x.name]));
      const opts = (cur) => t.pools.map((p) => `<option value="${esc(p.id)}" ${p.id === cur ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
      const count = teams.length;
      return `<div class="card pool" data-pid="${esc(pool.id)}">
        <div class="pool-head">
          <h3>${esc(pool.name)}</h3>
          <span class="pill ${count > t.poolSize ? 'warn' : count === t.poolSize ? 'full' : ''}">${count}/${t.poolSize} teams</span>
          <span class="grow"></span>
          <button class="btn small" data-a="setcourt">${pool.court ? esc(pool.court) : 'Set court'}</button>
          <button class="btn small" data-a="renamepool">Rename</button>
          <button class="btn small" data-a="respace" title="Put unplayed games back in the automatic order (pools of five follow the fixed rank order)">Reset game order</button>
          <button class="btn small danger" data-a="delpool">Delete pool</button>
        </div>
        ${teams.length ? `<div class="tlist" data-pid="${esc(pool.id)}">${teams.slice().sort((x, y) => (x.tb || 999) - (y.tb || 999)).map((x, i, arr) => `
          <div class="trow" data-tid="${esc(x.id)}">
            <span class="rk" title="Rank in this pool">${i + 1}</span>
            <span class="tn">${esc(x.name)}</span>
            <span class="drag" title="Drag to re-rank" aria-label="Drag to re-rank ${esc(x.name)}">⠿</span>
            <button class="btn small" data-a="rkup" aria-label="Rank higher" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button class="btn small" data-a="rkdown" aria-label="Rank lower" ${i === arr.length - 1 ? 'disabled' : ''}>▼</button>
            <select data-move aria-label="Move ${esc(x.name)} to pool">${opts(x.pool)}</select>
            <button class="btn small" data-a="renameteam" title="Rename">✎</button>
            <button class="btn small danger" data-a="delteam" title="Remove team">✕</button>
          </div>`).join('')}</div>` : '<div class="empty" style="padding:12px">No teams yet — add some below.</div>'}
        <form class="addt row" data-pid="${esc(pool.id)}">
          <div><label>Add teams (one per line)</label><textarea rows="2" style="min-height:44px"></textarea></div>
          <button class="btn" type="submit">Add</button>
        </form>
        ${ms.length ? `<details class="games" data-key="pool-${esc(pool.id)}" ${openGames.has('pool-' + pool.id) ? 'open' : ''}><summary>Games (${ms.length}) — in play order${pool.manualOrder ? ' · custom order' : ''}</summary>
          ${ms.map((m) => `
          <div class="amatch" data-mid="${esc(m.id)}">
            <div class="l1">
              <button class="g gpos" data-a="gopos" title="Move this game to another spot">G${m.order}</button>
              <div class="vs">${esc(name[m.a] || '?')} <small>vs</small> ${esc(name[m.b] || '?')} ${m.final ? '<span class="lock">final</span>' : ''}</div>
              <span class="mv"><button class="btn small" data-a="mvup" aria-label="Move game up" ${m.order === 1 ? 'disabled' : ''}>▲</button><button class="btn small" data-a="mvdown" aria-label="Move game down" ${m.order === ms.length ? 'disabled' : ''}>▼</button></span>
            </div>
            <div class="arow">
              <input type="number" min="0" inputmode="numeric" data-f="sa" value="${m.sa}" aria-label="score A">
              <span>–</span>
              <input type="number" min="0" inputmode="numeric" data-f="sb" value="${m.sb}" aria-label="score B">
              <button class="btn small" data-a="setscore">Save</button>
              <a class="btn small" href="/g/${esc(m.id)}" data-link>Open</a>
            </div>
            ${refSelect(m.id, m.a, m.b, m.ref, m.refLocked)}
          </div>`).join('')}</details>` : ''}
      </div>`;
    }

    function rankCard() {
      const rt = t.rankTable || [];
      if (!rt.length) return '';
      const manual = rt.some((x) => x.tb);
      const bySeed = (x, y) => x.rank - y.rank || y.w - x.w || y.diff - x.diff || y.pf - x.pf || x.poolName.localeCompare(y.poolName) || x.name.localeCompare(y.name);
      const list = rt.slice().sort(manual ? (x, y) => (x.tb || 1e9) - (y.tb || 1e9) || bySeed(x, y) : bySeed);
      return `<div class="card">
        <p class="hint" style="margin:0 0 6px">Drag teams (or use ▲ ▼) to rank all ${list.length} teams 1 to ${list.length}. This is the order on the public Teams tab. It also sets each team's rank inside its pool, so it decides pool ties and, in pools of four or five, the game order.</p>
        <div class="actions" style="margin:0 0 4px"><button class="btn small" data-a="resetrank" ${manual ? '' : 'disabled'}>Reset to automatic order</button><span class="muted" style="align-self:center;font-size:14px">${manual ? 'Custom order' : 'Automatic order (pool finish, record, point diff)'}</span></div>
        <div class="tlist" data-all="1">${list.map((x, i, arr) => `
          <div class="trow" data-tid="${esc(x.id)}">
            <span class="rk">${i + 1}</span>
            <span class="tn">${esc(x.name)} <small class="muted">· ${esc(x.poolName)}</small></span>
            <span class="drag" aria-label="Drag to re-rank ${esc(x.name)}">⠿</span>
            <button class="btn small" data-a="rkup" aria-label="Rank higher" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button class="btn small" data-a="rkdown" aria-label="Rank lower" ${i === arr.length - 1 ? 'disabled' : ''}>▼</button>
          </div>`).join('')}</div></div>`;
    }

    function bracketCard() {
      const br = t.bracket, pr = br.progress;
      const status = br.ready
        ? (t.bracketManual ? 'Brackets were created early from the current standings and will update until bracket play starts.' : 'Brackets are set from the final pool standings.')
        : `Brackets fill in automatically once every pool game is finished (${pr.played} of ${pr.total} done).`;
      const name = (x) => (x ? x.name : 'TBD');
      const lists = br.brackets.map((b) => `
        <div class="round-title" style="margin-top:14px">${b.name} bracket — seeds</div>
        <div class="seedlist">${b.seeds.map((x) => `<span class="seed-chip"><b>${x.seed}</b> ${esc(x.name)} <small>${esc(x.pool)}${x.place}</small></span>`).join('')}</div>
        <details class="games" data-key="br-${b.key}" ${openGames.has('br-' + b.key) ? 'open' : ''}><summary>${b.name} games</summary>
        ${b.rounds.map((r) => r.matches.filter((m) => !m.bye).map((m) => `
          <div class="amatch" data-mid="${esc(m.id)}">
            <div class="l1">
              <span class="g" style="width:auto;min-width:34px">${m.num ? 'G' + m.num : ''}</span>
              <div class="vs">${esc(name(m.a))} <small>vs</small> ${esc(name(m.b))} ${m.final ? '<span class="lock">final</span>' : ''}</div>
            </div>
            <div class="hint" style="margin:2px 0 6px">${esc(r.name.replace(/s$/, ''))}${m.time ? ' · ' + esc(m.time) : ''}${m.court ? ' · ' + esc(m.court) : ''}</div>
            ${m.a && m.b ? `<div class="arow"><input type="number" min="0" inputmode="numeric" data-f="sa" value="${m.sa}" aria-label="score A"><span>–</span><input type="number" min="0" inputmode="numeric" data-f="sb" value="${m.sb}" aria-label="score B"><button class="btn small" data-a="setscore">Save</button><a class="btn small" href="/g/${esc(m.id)}" data-link>Open</a></div>` : '<div class="hint" style="margin:0 0 6px">Scores can be entered once both teams are decided.</div>'}
            ${refSelect(m.id, m.a && m.a.id, m.b && m.b.id, m.ref, m.refLocked)}
          </div>`).join('')).join('')}</details>`).join('');
      return `<div class="card">
        <p style="margin:0 0 12px">${esc(status)}</p>
        <div class="actions" style="margin-top:0">
          <button class="btn small" data-a="genbracket">${br.ready ? 'Re-seed brackets now' : 'Create brackets now'}</button>
          ${br.ready ? '<button class="btn small danger" data-a="clearbracket">Clear brackets</button>' : ''}
          <a class="btn small" href="/b/${esc(t.id)}" data-link>Open bracket page</a>
        </div>${lists}</div>`;
    }

    function draw() {
      app.innerHTML = shell(`
        <h1>${esc(t.name)}</h1>
        <p class="sub">View: <a href="/t/${esc(t.id)}/info" data-link>Public page</a> · <a href="/t/${esc(t.id)}/playoffs" data-link>Playoffs</a></p>
        ${['localhost', '127.0.0.1'].includes(location.hostname) ? '<div class="card" style="border-color:var(--accent);margin-bottom:12px;font-size:14px"><b>Heads up:</b> you opened this as <code>localhost</code>, so copied links only work on this computer. Open the admin from your network address (printed when the server starts) before sharing links.</div>' : ''}
        <div class="actions">
          <button class="btn small" data-a="copyboard">Copy scoreboard link</button>
          <button class="btn small" data-a="copybracket">Copy bracket link</button>
          <button class="btn small" data-a="rename">Rename tournament</button>
          <button class="btn small" data-a="reset">Reset all scores</button>
          <button class="btn small danger" data-a="deltourn">Delete tournament</button>
        </div>

        <h2>Pools</h2>
        <p class="hint" style="margin:-4px 0 12px">Matches are created automatically for every team in a pool. Move a team with its dropdown and both pools update.</p>
        ${t.pools.map(poolCard).join('') || '<div class="card empty">No pools yet.</div>'}
        <div class="actions"><button class="btn" data-a="addpool">+ Add a pool</button></div>

        <h2>Team ranking</h2>
        ${rankCard()}

        <h2>Playoff brackets</h2>
        ${bracketCard()}

        <h2>Event details</h2>
        <form class="card" id="details">
          <div class="row">
            <div><label for="ddate">Date</label><input type="date" id="ddate" value="${esc(t.settings.date)}"></div>
            <div><label for="dstart">First game</label><input type="time" id="dstart" value="${esc(t.settings.startTime)}"></div>
            <div><label for="dmin">Minutes per game</label><input type="number" id="dmin" min="5" max="240" value="${t.settings.gameMinutes}"></div>
          </div>
          <div class="field"><label for="dloc">Location</label><input type="text" id="dloc" maxlength="120" value="${esc(t.settings.location)}" placeholder="Beach, park or gym"></div>
          <div class="field"><label for="dnotes">Director notes (shown on the Information tab)</label><textarea id="dnotes" rows="5" maxlength="4000" placeholder="Check-in time, parking, food, rules…">${esc(t.settings.notes)}</textarea></div>
          <div class="hint" style="margin-bottom:14px">Game times on the Games and Playoffs tabs are estimates: first game time plus minutes per game, in play order. Playoffs start after the longest pool finishes.</div>
          <button class="btn primary" type="submit">Save details</button>
        </form>

        <h2>Rules &amp; referee access</h2>
        <form class="card" id="rules">
          <div class="round-title">Pool play</div>
          <div class="row">
            <div><label for="rt">Play to</label><input type="number" id="rt" min="1" max="99" value="${t.settings.target}"></div>
            <div><label for="rcap">Cap (0 = none)</label><input type="number" id="rcap" min="0" max="199" value="${t.settings.cap}"></div>
          </div>
          <label class="check"><input type="checkbox" id="rwb2" ${t.settings.winByTwo ? 'checked' : ''}> Win by 2</label>
          <div class="round-title">Brackets</div>
          <div class="row">
            <div><label for="bt">Play to</label><input type="number" id="bt" min="1" max="99" value="${t.settings.bTarget}"></div>
            <div><label for="bcap">Cap (0 = none)</label><input type="number" id="bcap" min="0" max="199" value="${t.settings.bCap}"></div>
            <div><label for="scap">Silver cap (0 = none)</label><input type="number" id="scap" min="0" max="199" value="${t.settings.sCap}"></div>
            <div><label for="gold">Gold spots per pool</label><input type="number" id="gold" min="1" max="7" value="${t.settings.goldCount}"></div>
          </div>
          <label class="check"><input type="checkbox" id="bwb2" ${t.settings.bWinByTwo ? 'checked' : ''}> Win by 2</label>
          <div class="round-title">Gold first round</div>
          <div class="row">
            <div><label for="g1t">Play to (0 = same as other games)</label><input type="number" id="g1t" min="0" max="99" value="${t.settings.g1Target}"></div>
            <div><label for="g1c">Cap (0 = none)</label><input type="number" id="g1c" min="0" max="199" value="${t.settings.g1Cap}"></div>
          </div>
          <div class="hint" style="margin:-6px 0 14px">Applies to the Gold games played before the byes: first to ${t.settings.g1Target || '…'}${t.settings.g1Cap ? ', hard cap ' + t.settings.g1Cap : ''}. Cap equal to the target means the first team to reach it wins, even 15–14.</div>
          <div class="hint" style="margin:-6px 0 14px">The top ${t.settings.goldCount} of each pool go to Gold; everyone else goes to Silver.</div>
          <div class="round-title">Referees</div>
          <div class="row">
            <div><label for="rpin">Referee PIN</label><input type="text" id="rpin" maxlength="20" value="${esc(t.refPin)}" placeholder="none — anyone can keep score" autocomplete="off"></div>
          </div>
          <div class="hint" style="margin-bottom:14px">${t.refPin ? 'Anyone can watch a game; only people who enter the PIN get the +1 / −1 buttons.' : 'No PIN set: anyone who opens a game can change its score. Set a PIN to restrict that to your referees.'}</div>
          <button class="btn primary" type="submit">Save rules</button>
        </form>
      `, '<a href="/admin" data-link>All tournaments</a>');
    }

    const sig = { signal: routeAbort.signal };
    // drag a team by its handle to re-rank it (works with a finger or a mouse)
    app.addEventListener('pointerdown', (e) => {
      const h = e.target.closest('.drag');
      if (!h) return;
      const row = h.closest('.trow'), list = row.parentElement;
      e.preventDefault();
      row.classList.add('dragging');
      const move = (ev) => {
        const rows = [...list.querySelectorAll('.trow')].filter((r) => r !== row);
        const after = rows.find((r) => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
        if (after) list.insertBefore(row, after); else list.appendChild(row);
        list.querySelectorAll('.rk').forEach((n, i) => { n.textContent = i + 1; });
      };
      const done = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', done); window.removeEventListener('pointercancel', done);
        row.classList.remove('dragging');
        act(list.dataset.all ? '/teams/rank' : '/pools/' + list.dataset.pid + '/rank', 'POST', { order: [...list.querySelectorAll('.trow')].map((r) => r.dataset.tid) });
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', done); window.addEventListener('pointercancel', done);
    }, sig);
    app.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      const poolEl = b.closest('.pool'), pid = poolEl && poolEl.dataset.pid;
      const pool = pid && t.pools.find((p) => p.id === pid);
      const tid = b.closest('.trow') && b.closest('.trow').dataset.tid;
      const mEl = b.closest('.amatch');

      if (a === 'copyboard') return copyText(`${location.origin}/t/${t.id}`);
      if (a === 'copybracket') return copyText(`${location.origin}/t/${t.id}/playoffs`);
      if (a === 'rename') { const n = prompt('Tournament name', t.name); if (n) act('', 'PATCH', { name: n }); return; }
      if (a === 'reset') { if (confirm('Set every score back to 0-0?')) act('/reset', 'POST'); return; }
      if (a === 'deltourn') {
        if (confirm(`Delete "${t.name}", its pools and all scores? This cannot be undone.`)) {
          try { await api(base, { method: 'DELETE' }); navigate('/admin'); } catch (er) { toast(er.message); }
        } return;
      }
      if (a === 'genbracket') {
        const pr = t.bracket.progress;
        if (pr.played < pr.total && !confirm(`Pool play isn't finished (${pr.played} of ${pr.total} games). Create brackets from the standings so far? They'll keep updating until bracket play starts.`)) return;
        const anyStarted = t.bracket.brackets.some((b) => b.rounds.some((r) => r.matches.some((m) => !m.bye && (m.final || m.live))));
        if (anyStarted && !confirm('Bracket games have already been played. Re-seeding erases every bracket score. Continue?')) return;
        return act('/bracket', 'POST', { force: anyStarted });
      }
      if (a === 'clearbracket') { if (confirm('Remove both brackets and their scores? They will be rebuilt automatically when pool play is finished.')) act('/bracket', 'DELETE'); return; }
      if (a === 'addpool') return act('/pools', 'POST', {});
      if (a === 'renamepool' && pool) { const n = prompt('Pool name', pool.name); if (n) act('/pools/' + pid, 'PATCH', { name: n }); return; }
      if (a === 'setcourt' && pool) { const n = prompt('Court for ' + pool.name + ' (for example 41 or Court 41)', pool.courtRaw || ''); if (n !== null) act('/pools/' + pid, 'PATCH', { court: n }); return; }
      if (a === 'delpool' && pool) { if (confirm(`Delete ${pool.name}, its teams and its matches?`)) act('/pools/' + pid, 'DELETE'); return; }
      if (a === 'respace' && pool) return act('/pools/' + pid + '/schedule', 'POST');
      if (a === 'renameteam' && tid) { const cur = t.teams.find((x) => x.id === tid); const n = prompt('Team name', cur.name); if (n) act('/teams/' + tid, 'PATCH', { name: n }); return; }
      if ((a === 'rkup' || a === 'rkdown') && tid) {
        const ids = [...b.closest('.tlist').querySelectorAll('.trow')].map((r) => r.dataset.tid);
        const k = ids.indexOf(tid), n = a === 'rkup' ? k - 1 : k + 1;
        if (n < 0 || n >= ids.length) return;
        [ids[k], ids[n]] = [ids[n], ids[k]];
        return act(b.closest('.tlist').dataset.all ? '/teams/rank' : '/pools/' + pid + '/rank', 'POST', { order: ids });
      }
      if (a === 'resetrank') return act('/teams/rank', 'POST', { reset: true });
      if ((a === 'mvup' || a === 'mvdown' || a === 'gopos') && mEl) {
        const pm = t.matches.find((x) => x.id === mEl.dataset.mid);
        if (!pm) return;
        if (a === 'gopos') { const n = prompt(`Move game G${pm.order} to which spot? (1 to ${t.matches.filter((x) => x.pool === pm.pool).length})`, pm.order); if (n === null) return; return act('/matches/' + pm.id + '/move', 'POST', { to: n }); }
        return act('/matches/' + pm.id + '/move', 'POST', { to: pm.order + (a === 'mvup' ? -1 : 1) });
      }
      if (a === 'delteam' && tid) {
        const cur = t.teams.find((x) => x.id === tid);
        const hasScores = t.matches.some((m) => (m.a === tid || m.b === tid) && started(m));
        if (confirm(`Remove ${cur.name}?${hasScores ? ' Their recorded scores will be deleted too.' : ''}`)) act('/teams/' + tid, 'DELETE');
        return;
      }
      if (a === 'setscore' && mEl) {
        return act('/matches/' + mEl.dataset.mid, 'PATCH', { sa: $('[data-f=sa]', mEl).value, sb: $('[data-f=sb]', mEl).value });
      }
    }, sig);

    app.addEventListener('toggle', (e) => {
      const d = e.target;
      if (d && d.matches && d.matches('details[data-key]')) { if (d.open) openGames.add(d.dataset.key); else openGames.delete(d.dataset.key); }
    }, { capture: true, signal: routeAbort.signal });

    app.addEventListener('change', (e) => {
      const rs = e.target.closest('select[data-ref]');
      if (rs) return act('/matches/' + rs.closest('.amatch').dataset.mid, 'PATCH', { ref: rs.value });
      const sel = e.target.closest('select[data-move]');
      if (!sel) return;
      const row = sel.closest('.trow'), tid = row.dataset.tid;
      const cur = t.teams.find((x) => x.id === tid);
      const hasScores = t.matches.some((m) => (m.a === tid || m.b === tid) && started(m));
      if (hasScores && !confirm(`${cur.name} already has recorded scores in this pool. Moving them deletes those scores. Move anyway?`)) { sel.value = cur.pool; return; }
      act('/teams/' + tid, 'PATCH', { pool: sel.value });
    }, sig);

    app.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.classList.contains('addt')) {
        const ta = f.querySelector('textarea');
        if (ta.value.trim()) act('/pools/' + f.dataset.pid + '/teams', 'POST', { names: ta.value.split('\n') });
      }
      if (f.id === 'details') act('', 'PATCH', { date: $('#ddate').value, startTime: $('#dstart').value || '09:00', gameMinutes: $('#dmin').value, location: $('#dloc').value, notes: $('#dnotes').value });
      if (f.id === 'rules') act('', 'PATCH', {
        target: $('#rt').value, cap: $('#rcap').value, winByTwo: $('#rwb2').checked,
        bTarget: $('#bt').value, bCap: $('#bcap').value, bWinByTwo: $('#bwb2').checked, sCap: $('#scap').value, g1Target: $('#g1t').value, g1Cap: $('#g1c').value,
        goldCount: $('#gold').value, refPin: $('#rpin').value });
    }, sig);

    draw();
  });
}

route();
