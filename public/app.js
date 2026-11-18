'use strict';

const app = document.getElementById('app');
const LOGO = '<svg viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1a2236"/><path d="M20 14h24v10c0 8-5 14-12 14S20 32 20 24V14z" fill="#f5b942"/><path d="M20 18h-6c0 8 3 12 8 13M44 18h6c0 8-3 12-8 13" fill="none" stroke="#f5b942" stroke-width="3" stroke-linecap="round"/><rect x="29" y="38" width="6" height="8" fill="#f5b942"/><rect x="22" y="46" width="20" height="5" rx="2" fill="#f5b942"/></svg>';

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
  if (r.headers.get('x-app-version') !== '4') {
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
  if ((m = p.match(/^\/t\/([^/]+)$/))) return pageTournament(m[1]);
  if ((m = p.match(/^\/g\/([^/]+)$/))) return pageGame(m[1]);
  if ((m = p.match(/^\/b\/([^/]+)$/))) return pageBracket(m[1]);
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
            <div><div class="name">${esc(t.name)}</div><div class="meta">${plural(t.pools, 'pool')} · ${plural(t.teams, 'team')} · ${dateStr(t.createdAt)}</div></div>
            <span class="pill">${t.played}/${t.matches} played</span>
          </a>`).join('')}</div>`
      : '<div class="card empty">No tournaments yet.</div>';
    app.innerHTML = shell(`<h1>Tournaments</h1><p class="sub">Pick one to see the live standings.</p>${body}`, '<a href="/admin" data-link>Organizer</a>');
  } catch (e) { app.innerHTML = shell(`<div class="empty">${esc(e.message)}</div>`); }
}

// ---------------- public scoreboard ----------------
function standingsTable(pool) {
  if (!pool.standings.length) return '<div class="card empty">No teams in this pool yet.</div>';
  const rows = pool.standings.map((r) => `
    <tr class="${r.rank === 1 && r.p > 0 ? 'first' : ''}">
      <td class="rank">${r.rank}</td><td class="left pname">${esc(r.name)}</td>
      <td>${r.p}</td><td class="wl">${r.w}</td><td>${r.l}</td>
      <td class="${r.diff > 0 ? 'pos' : r.diff < 0 ? 'neg' : ''}">${r.diff > 0 ? '+' : ''}${r.diff}</td></tr>`).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>#</th><th class="left">Team</th><th>P</th><th>W</th><th>L</th><th>+/−</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="legend">P played · W won · L lost · +/− point difference</p>`;
}

function poolMatches(pool) {
  if (!pool.matches.length) return '<div class="card empty">Matches appear here once the pool has at least two teams.</div>';
  const name = Object.fromEntries(pool.teams.map((x) => [x.id, x.name]));
  const nextId = (pool.matches.find((m) => !m.final) || {}).id;
  return pool.matches.map((m) => {
    const live = !m.final && (m.sa > 0 || m.sb > 0);
    const state = m.final ? 'final' : live ? 'live' : '';
    const status = m.final ? 'Final' : live ? 'Live' : m.id === nextId ? 'Up next' : '';
    return `<a class="match ${state}" href="/g/${esc(m.id)}" data-link>
      <div class="mhead">
        <span class="gnum">G${m.order}</span>
        ${status ? `<span class="mstate ${state || 'next'}">${live ? '<span class="dot"></span>' : ''}${status}</span>` : ''}
        ${m.ref ? `<span class="mref">Ref: <b>${esc(m.ref.name)}</b></span>` : ''}
      </div>
      <div class="mbody">
        <div class="side ${m.final && m.sa > m.sb ? 'win' : ''}">${esc(name[m.a] || '?')}</div>
        <div class="score ${m.final || live ? '' : 'todo'}">${m.final || live ? `${m.sa} – ${m.sb}` : 'VS'}</div>
        <div class="side r ${m.final && m.sb > m.sa ? 'win' : ''}">${esc(name[m.b] || '?')}</div>
      </div>
    </a>`;
  }).join('');
}

async function pageTournament(id) {
  let last = '', data = null;
  let sel = new URLSearchParams(location.search).get('pool');

  function draw() {
    const pools = data.pools;
    if (!pools.length) { app.innerHTML = shell(`<h1>${esc(data.name)}</h1><div class="card empty">No pools yet.</div>`, '<a href="/" data-link>All tournaments</a>'); return; }
    const pool = pools.find((p) => p.id === sel) || pools[0];
    const played = pools.reduce((n, p) => n + p.matches.filter((m) => m.final).length, 0);
    const total = pools.reduce((n, p) => n + p.matches.length, 0);
    app.innerHTML = shell(`
      <h1>${esc(data.name)}</h1>
      <p class="sub">Pool play: ${esc(data.rules.poolText.toLowerCase())} · ${played} of ${total} games played</p>
      <div class="actions"><a class="btn small ${data.bracketReady ? 'primary' : ''}" href="/b/${esc(data.id)}" data-link>🏆 Playoff brackets${data.bracketReady ? '' : ' (after pool play)'}</a></div>
      ${pools.length > 1 ? `<div class="tabs">${pools.map((p) => `<button class="tab ${p.id === pool.id ? 'on' : ''}" data-pool="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>` : ''}
      <h2>${esc(pool.name)} standings</h2>${standingsTable(pool)}
      <h2>${esc(pool.name)} matches</h2><div class="mlist">${poolMatches(pool)}</div>
      <p class="hint">Tap a match to open its scoreboard.</p>`, '<a href="/" data-link>All tournaments</a>');
  }

  async function load(first) {
    try {
      data = await api('/api/t/' + encodeURIComponent(id));
      const sig = JSON.stringify(data);
      if (sig === last) return;
      last = sig; draw();
    } catch (e) {
      if (first) app.innerHTML = shell(`<div class="card empty">${esc(e.message)}</div>`);
    }
  }

  app.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pool]');
    if (!b || !data) return;
    sel = b.dataset.pool;
    history.replaceState({}, '', `${location.pathname}?pool=${encodeURIComponent(sel)}`);
    draw();
  }, { signal: routeAbort.signal });

  app.innerHTML = shell('<div class="empty">Loading…</div>');
  await load(true);
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
    $('#meta').textContent = `${d.label} · ${d.rulesText}`;
    $('#gref').innerHTML = d.ref ? `Referee: <b>${esc(d.ref.name)}</b>` : '';
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

// ---------------- bracket page ----------------
async function pageBracket(id) {
  let last = '', data = null;
  let sel = new URLSearchParams(location.search).get('bracket');

  const team = (x, sa, sb, final, side) => {
    if (!x) return '<div class="bt tbd"><span class="bn">TBD</span></div>';
    const win = final && (side === 'a' ? sa > sb : sb > sa);
    const lose = final && !win;
    return `<div class="bt ${win ? 'win' : ''} ${lose ? 'lose' : ''}"><span class="seed">${x.seed == null ? '' : x.seed}</span><span class="bn">${esc(x.name)}</span><span class="bpool">${esc(x.pool)}</span><span class="bs">${final || sa || sb ? (side === 'a' ? sa : sb) : ''}</span></div>`;
  };

  function bracketHtml(b) {
    const cols = b.rounds.map((r) => `
      <div class="bcol"><div class="bcol-title">${esc(r.name)}</div><div class="bcol-body">
        ${r.matches.map((m) => {
          if (m.bye) {
            const t = m.a || m.b;
            return `<div class="bm bye"><div class="bt"><span class="seed">${t.seed}</span><span class="bn">${esc(t.name)}</span><span class="bpool">${esc(t.pool)}</span><span class="bs bye-tag">BYE</span></div></div>`;
          }
          return `<a class="bm ${m.live ? 'live' : ''} ${m.final ? 'done' : ''}" href="/g/${esc(m.id)}" data-link>
            ${team(m.a, m.sa, m.sb, m.final, 'a')}${team(m.b, m.sa, m.sb, m.final, 'b')}
            <div class="bref">${m.ref ? `Ref: <b>${esc(m.ref.name)}</b>` : 'Ref: to be decided'}</div></a>`;
        }).join('')}
      </div></div>`).join('');
    return `${b.champion ? `<div class="champ">🏆 ${esc(b.name)} champion: <b>${esc(b.champion.name)}</b></div>` : ''}
      <div class="bracket-scroll"><div class="bracket">${cols}</div></div>`;
  }

  function draw() {
    const crumbs = `<a href="/t/${esc(data.id)}" data-link>Pool standings</a>`;
    if (!data.ready) {
      app.innerHTML = shell(`<h1>${esc(data.name)} — Playoffs</h1>
        <div class="card empty">Brackets fill in automatically once every pool game is finished.<br><b>${data.progress.played} of ${data.progress.total}</b> pool games played.<br><br>
        Gold: top ${data.goldCount} of each pool · Silver: everyone else · single elimination, ${esc(data.bracketText.toLowerCase())}.</div>`, crumbs);
      return;
    }
    const b = data.brackets.find((x) => x.key === sel) || data.brackets[0];
    app.innerHTML = shell(`<h1>${esc(data.name)} — Playoffs</h1>
      <p class="sub">Single elimination · ${esc(data.bracketText.toLowerCase())}. Tap a game to open its scoreboard.</p>
      ${data.brackets.length > 1 ? `<div class="tabs">${data.brackets.map((x) => `<button class="tab ${x.key === b.key ? 'on' : ''}" data-br="${x.key}">${esc(x.name)}</button>`).join('')}</div>` : ''}
      ${b ? bracketHtml(b) : '<div class="card empty">No bracket yet.</div>'}`, crumbs);
  }

  async function load(first) {
    try {
      data = await api('/api/b/' + encodeURIComponent(id));
      const sig = JSON.stringify(data);
      if (sig === last) return;
      last = sig; draw();
    } catch (e) { if (first) app.innerHTML = shell(`<div class="card empty">${esc(e.message)}</div>`); }
  }

  app.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-br]');
    if (!b || !data) return;
    sel = b.dataset.br;
    history.replaceState({}, '', `${location.pathname}?bracket=${encodeURIComponent(sel)}`);
    draw();
  }, { signal: routeAbort.signal });

  app.innerHTML = shell('<div class="empty">Loading…</div>');
  await load(true);
  pollTimer = setInterval(() => load(false), 4000);
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
        <div class="hint" style="margin:0 0 14px">Pool play is first to the score above, win by 2, capped at 23. Playoffs: top 3 of each pool play in a Gold bracket, the rest in Silver — single elimination, first to 21, win by 2, no cap. You can change any of this after creating the tournament.</div>
        <button class="btn primary" type="submit">Create tournament</button>
        <div class="err" id="err"></div>
      </form>
      <h2>Your tournaments</h2>
      ${list.length ? `<div class="tlist">${list.map((t) => `
        <a class="card tcard" href="/admin/t/${esc(t.id)}" data-link>
          <div><div class="name">${esc(t.name)}</div><div class="meta">${plural(t.pools, 'pool')} · ${plural(t.teams, 'team')} · ${dateStr(t.createdAt)}</div></div>
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

    const openGames = new Set();
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
          <button class="btn small" data-a="renamepool">Rename</button>
          <button class="btn small" data-a="respace" title="Re-order unplayed games so teams rest between matches">Re-space games</button>
          <button class="btn small danger" data-a="delpool">Delete pool</button>
        </div>
        ${teams.length ? teams.map((x) => `
          <div class="trow" data-tid="${esc(x.id)}">
            <span class="tn">${esc(x.name)}</span>
            <select data-move aria-label="Move ${esc(x.name)} to pool">${opts(x.pool)}</select>
            <button class="btn small" data-a="renameteam" title="Rename">✎</button>
            <button class="btn small danger" data-a="delteam" title="Remove team">✕</button>
          </div>`).join('') : '<div class="empty" style="padding:12px">No teams yet — add some below.</div>'}
        <form class="addt row" data-pid="${esc(pool.id)}">
          <div><label>Add teams (one per line)</label><textarea rows="2" style="min-height:44px"></textarea></div>
          <button class="btn" type="submit">Add</button>
        </form>
        ${ms.length ? `<details class="games" data-key="pool-${esc(pool.id)}" ${openGames.has('pool-' + pool.id) ? 'open' : ''}><summary>Games (${ms.length}) — in play order</summary>
          ${ms.map((m) => `
          <div class="amatch" data-mid="${esc(m.id)}">
            <div class="l1">
              <span class="g">G${m.order}</span>
              <div class="vs">${esc(name[m.a] || '?')} <small>vs</small> ${esc(name[m.b] || '?')} ${m.final ? '<span class="lock">final</span>' : ''}</div>
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
              <span class="g" style="width:auto;min-width:34px">${esc(r.name.replace(/s$/, ''))}</span>
              <div class="vs">${esc(name(m.a))} <small>vs</small> ${esc(name(m.b))} ${m.final ? '<span class="lock">final</span>' : ''}</div>
            </div>
            ${m.a && m.b ? `<div class="arow"><input type="number" min="0" inputmode="numeric" data-f="sa" value="${m.sa}" aria-label="score A"><span>–</span><input type="number" min="0" inputmode="numeric" data-f="sb" value="${m.sb}" aria-label="score B"><button class="btn small" data-a="setscore">Save</button><a class="btn small" href="/g/${esc(m.id)}" data-link>Open</a></div>` : ''}
            ${m.a && m.b ? refSelect(m.id, m.a.id, m.b.id, m.ref, m.refLocked) : ''}
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
        <p class="sub">View: <a href="/t/${esc(t.id)}" data-link>Scoreboard page</a> · <a href="/b/${esc(t.id)}" data-link>Bracket page</a></p>
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

        <h2>Playoff brackets</h2>
        ${bracketCard()}

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
            <div><label for="gold">Gold spots per pool</label><input type="number" id="gold" min="1" max="7" value="${t.settings.goldCount}"></div>
          </div>
          <label class="check"><input type="checkbox" id="bwb2" ${t.settings.bWinByTwo ? 'checked' : ''}> Win by 2</label>
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
    app.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      const poolEl = b.closest('.pool'), pid = poolEl && poolEl.dataset.pid;
      const pool = pid && t.pools.find((p) => p.id === pid);
      const tid = b.closest('.trow') && b.closest('.trow').dataset.tid;
      const mEl = b.closest('.amatch');

      if (a === 'copyboard') return copyText(`${location.origin}/t/${t.id}`);
      if (a === 'copybracket') return copyText(`${location.origin}/b/${t.id}`);
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
      if (a === 'delpool' && pool) { if (confirm(`Delete ${pool.name}, its teams and its matches?`)) act('/pools/' + pid, 'DELETE'); return; }
      if (a === 'respace' && pool) return act('/pools/' + pid + '/schedule', 'POST');
      if (a === 'renameteam' && tid) { const cur = t.teams.find((x) => x.id === tid); const n = prompt('Team name', cur.name); if (n) act('/teams/' + tid, 'PATCH', { name: n }); return; }
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
      if (f.id === 'rules') act('', 'PATCH', {
        target: $('#rt').value, cap: $('#rcap').value, winByTwo: $('#rwb2').checked,
        bTarget: $('#bt').value, bCap: $('#bcap').value, bWinByTwo: $('#bwb2').checked,
        goldCount: $('#gold').value, refPin: $('#rpin').value });
    }, sig);

    draw();
  });
}

route();
