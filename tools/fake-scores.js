#!/usr/bin/env node
'use strict';
// Fill a TEST tournament with random scores (pool play, then every bracket round) through the running
// server, so you can preview the playoffs. It only talks to the server's normal admin API.
//
//   ADMIN_PASSWORD=xxxx node tools/fake-scores.js [tournament-id] [http://localhost:3000]
//
// With no tournament id it picks the first tournament whose name starts with "Dig Pink".
// To undo, use "Reset scores" for that tournament in the admin page.

const pw = process.env.ADMIN_PASSWORD;
const BASE = (process.argv[3] || 'http://localhost:3000').replace(/\/$/, '');
if (!pw) { console.error('Set ADMIN_PASSWORD first, e.g.  ADMIN_PASSWORD=xxxx node tools/fake-scores.js'); process.exit(1); }

async function api(method, path, body) {
  const r = await fetch(BASE + '/api' + path, { method, headers: { 'content-type': 'application/json', 'x-admin-password': pw }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${j.error || ''}`);
  return j;
}
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const score = (target) => { const lose = rnd(Math.max(3, Math.round(target * 0.4)), target - 2); return Math.random() < 0.5 ? { sa: target, sb: lose } : { sa: lose, sb: target }; };

(async () => {
  let id = process.argv[2];
  if (!id) {
    const list = await api('GET', '/admin/tournaments');
    const t = (list.tournaments || list).find((x) => /^dig pink/i.test(x.name));
    if (!t) throw new Error('No tournament named "Dig Pink…" found; pass its id.');
    id = t.id;
  }
  let v = await api('GET', `/admin/t/${id}`);
  console.log(`Filling "${v.name}" (${id})`);

  let pool = 0;
  for (const m of v.matches.filter((x) => !x.final)) { await api('PATCH', `/admin/t/${id}/matches/${m.id}`, score(v.settings.target)); pool++; }
  console.log(`  pool games scored: ${pool}`);

  let bracket = 0;
  for (let pass = 0; pass < 12; pass++) {
    v = await api('GET', `/admin/t/${id}`);
    const todo = [];
    for (const b of (v.bracket && v.bracket.brackets) || []) for (const r of b.rounds) {
      const target = Number((/to (\d+)/.exec(r.rules) || [])[1]) || 21;
      for (const m of r.matches) if (!m.bye && !m.final && m.a && m.b) todo.push({ m, target });
    }
    if (!todo.length) break;
    for (const { m, target } of todo) { await api('PATCH', `/admin/t/${id}/matches/${m.id}`, score(target)); bracket++; }
  }
  console.log(`  bracket games scored: ${bracket}`);
  console.log('Done. Reload the Playoffs tab.');
})().catch((e) => { console.error(e.message); process.exit(1); });
