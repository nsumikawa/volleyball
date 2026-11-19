'use strict';
// Volleyball Tournament Scoreboard — zero-dependency Node server.
// Run:  node server.js     (needs Node 18+)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { orderMatches } = require('./schedule');
const { arrange, roundName } = require('./bracket');
const { assignPoolRefs } = require('./referees');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const POOL_SIZE = 5;      // teams per pool (shown in the UI as the target)
const MAX_POOL = 8;       // hard limit the server will accept
const DEFAULT_TARGET = 21;
const DEFAULT_CAP = 23;       // pool play: win by 2, but the first team to 23 wins
const DEFAULT_GOLD = 3;       // top N of each pool go to Gold; everyone else goes to Silver
const APP_VERSION = '5'; // the page checks this so a stale server is reported clearly

// ---------- storage ----------
let db = { config: {}, tournaments: [] };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  db.config = db.config || {};
  db.tournaments = db.tournaments || [];
} catch (e) { /* first run */ }

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

let adminPassword = process.env.ADMIN_PASSWORD;
let generatedPassword = false;
if (!adminPassword) {
  if (!db.config.adminPassword) {
    db.config.adminPassword = crypto.randomBytes(5).toString('hex');
    generatedPassword = true;
    save();
  }
  adminPassword = db.config.adminPassword;
}

// ---------- helpers ----------
const hex = (n) => crypto.randomBytes(n).toString('hex');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 't';
const pairKey = (a, b) => [a, b].sort().join('|');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 200 * 1024) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-App-Version': APP_VERSION });
  res.end(JSON.stringify(obj));
}

const cleanName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 40);

function parseScore(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 999) throw new HttpError(400, 'Scores must be whole numbers from 0 to 999');
  return n;
}

function parseTarget(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : fallback;
}

function parseCap(v, target) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || n === 0) return 0;
  if (!Number.isInteger(n) || n < 1 || n > 199) throw new HttpError(400, 'Cap must be a whole number (or 0 for no cap).');
  if (n <= target) throw new HttpError(400, 'The cap has to be higher than the play-to score.');
  return n;
}

function findTournament(id) {
  const t = db.tournaments.find((x) => x.id === id);
  if (!t) throw new HttpError(404, 'Tournament not found');
  return t;
}
function findPool(t, pid) {
  const p = t.pools.find((x) => x.id === pid);
  if (!p) throw new HttpError(404, 'Pool not found');
  return p;
}
function findTeam(t, id) {
  const x = t.teams.find((y) => y.id === id);
  if (!x) throw new HttpError(404, 'Team not found');
  return x;
}
function findMatch(mid) {
  for (const t of db.tournaments) {
    const m = t.matches.find((x) => x.id === mid) || (t.bracket && t.bracket.matches.find((x) => x.id === mid));
    if (m) return { t, m };
  }
  throw new HttpError(404, 'Match not found');
}

function isAdmin(req) {
  const pw = req.headers['x-admin-password'];
  return !!pw && safeEqual(pw, adminPassword);
}
function requireAdmin(req) { if (!isAdmin(req)) throw new HttpError(401, 'Wrong admin password'); }

// ---------- match rules ----------
// Pool play and bracket play have separate rules (play-to score, win by 2, optional cap).
const poolRules = (t) => ({ target: t.target, winByTwo: !!t.winByTwo, cap: t.cap || 0 });
const bracketRules = (t) => ({ target: t.bTarget, winByTwo: !!t.bWinByTwo, cap: t.bCap || 0 });
// Gold's first round (the games between non-bye teams) can be shorter: default one game to 15, hard cap 15.
const g1Target = (t) => (t.g1Target === undefined ? 15 : t.g1Target);
const g1Cap = (t) => (t.g1Cap === undefined ? 15 : t.g1Cap);
const goldFirstRules = (t) => ({ target: g1Target(t), winByTwo: !!t.bWinByTwo, cap: g1Cap(t) });
const rulesFor = (t, m) => (!m.br ? poolRules(t) : (m.br === 'gold' && m.round === 1 && g1Target(t) > 0 ? goldFirstRules(t) : bracketRules(t)));
const rulesText = (r) => (r.cap && r.cap <= r.target) ? `One game to ${r.target}, hard cap ${r.cap}` : `First to ${r.target}${r.winByTwo ? ', win by 2' : ''}${r.cap ? `, cap ${r.cap}` : ''}`;

// A game is over when a side has reached the target and either leads by 2 (if win-by-2 is on)
// or has hit the cap (the first team to the cap wins outright).
function isFinal(r, m) {
  const hi = Math.max(m.sa, m.sb), lo = Math.min(m.sa, m.sb);
  if (hi < r.target || hi === lo) return false;
  if (r.cap && hi >= r.cap) return true;
  return r.winByTwo ? hi - lo >= 2 : true;
}
const isStarted = (m) => m.final || m.sa > 0 || m.sb > 0;

function standings(t, poolId) {
  const teams = t.teams.filter((x) => x.pool === poolId);
  const rows = new Map(teams.map((x) => [x.id, { id: x.id, name: x.name, p: 0, w: 0, l: 0, pf: 0, pa: 0 }]));
  for (const m of t.matches) {
    if (m.pool !== poolId || !m.final) continue;
    const A = rows.get(m.a), B = rows.get(m.b);
    if (!A || !B) continue;
    A.p++; B.p++;
    A.pf += m.sa; A.pa += m.sb; B.pf += m.sb; B.pa += m.sa;
    if (m.sa > m.sb) { A.w++; B.l++; } else { B.w++; A.l++; }
  }
  const arr = [...rows.values()].map((r) => ({ ...r, diff: r.pf - r.pa }));
  arr.sort((x, y) => y.w - x.w || y.diff - x.diff || y.pf - x.pf || x.name.localeCompare(y.name));
  arr.forEach((r, i) => {
    const prev = arr[i - 1];
    r.rank = prev && prev.w === r.w && prev.diff === r.diff && prev.pf === r.pf ? prev.rank : i + 1;
  });
  return arr;
}

// ---------- pool schedule ----------
// Keeps a pool's matches in sync with its teams: every team plays every other team once,
// matches for teams that left are dropped, and unplayed games are re-ordered so teams
// don't play back-to-back where that can be avoided.
function syncPool(t, pool) {
  const ids = t.teams.filter((x) => x.pool === pool.id).map((x) => x.id);
  const inPool = new Set(ids);

  // drop matches for teams that left, and any duplicate pairings
  const seen = new Set();
  t.matches = t.matches.filter((m) => {
    if (m.pool !== pool.id) return true;
    if (!inPool.has(m.a) || !inPool.has(m.b)) return false;
    const k = pairKey(m.a, m.b);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // add missing pairings
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (!seen.has(pairKey(ids[i], ids[j]))) {
        t.matches.push({ id: hex(4), pool: pool.id, order: 0, a: ids[i], b: ids[j], sa: 0, sb: 0, final: false, updatedAt: null });
      }
    }
  }

  // started games keep their place at the front; the rest get spaced out after them
  const mine = t.matches.filter((m) => m.pool === pool.id);
  const started = mine.filter(isStarted).sort((x, y) => x.order - y.order);
  const pending = mine.filter((m) => !isStarted(m)).sort((x, y) => x.order - y.order);
  const last = started[started.length - 1];
  const prevTeams = last ? new Set([last.a, last.b]) : new Set();
  const seq = orderMatches(pending, prevTeams);
  started.concat(seq).forEach((m, i) => { m.order = i + 1; });
  refreshPoolRefs(t, pool);
}

// ---------- referees ----------
// Pool games: a team from the previous game (see referees.js). Bracket games: first round uses teams that
// have a bye; later rounds use a team that just got knocked out of the previous round.
// An admin can override any game's ref by hand (refLocked); finished/started games keep theirs.
const teamExists = (t, id) => t.teams.some((x) => x.id === id);
const refValid = (t, m, id) => !!id && teamExists(t, id) && id !== m.a && id !== m.b;
function refRef(t, id) {
  if (!id) return null;
  const x = t.teams.find((y) => y.id === id);
  return x ? { id, name: x.name } : null;
}

function refreshPoolRefs(t, pool) {
  const ms = t.matches.filter((m) => m.pool === pool.id).sort((x, y) => x.order - y.order);
  const ids = t.teams.filter((x) => x.pool === pool.id).map((x) => x.id);
  const games = ms.map((m) => ({
    a: m.a, b: m.b,
    fixed: (m.refLocked || isStarted(m)) && refValid(t, m, m.ref) ? m.ref : null,
  }));
  const refs = assignPoolRefs(games, ids);
  ms.forEach((m, i) => {
    m.ref = refs[i];
    if (m.refLocked && games[i].fixed !== m.ref) m.refLocked = false;
  });
}

function refreshBracketRefs(t) {
  const br = t.bracket;
  if (!br) return;
  const all = br.matches;
  const counts = new Map();
  const bump = (id) => counts.set(id, (counts.get(id) || 0) + 1);
  const fixedOk = (m) => (m.refLocked || isStarted(m)) && refValid(t, m, m.ref);
  all.forEach((m) => { if (!m.bye && fixedOk(m)) bump(m.ref); });

  const inBracket = (key) => all.filter((m) => m.br === key);
  const loserOf = (m) => (m.bye || !m.final ? [] : [m.sa > m.sb ? m.b : m.a].filter(Boolean));
  const byeTeams = (key) => inBracket(key).filter((m) => m.round === 1 && m.bye).map((m) => m.a || m.b).filter(Boolean);
  const eliminatedBefore = (key, round) => inBracket(key).filter((m) => m.round < round).flatMap(loserOf);
  const otherKey = (key) => (key === 'gold' ? 'silver' : 'gold');

  for (const key of ['gold', 'silver']) {
    for (const m of inBracket(key).sort((x, y) => x.round - y.round || x.idx - y.idx)) {
      if (m.bye) { m.ref = null; m.refLocked = false; continue; }
      if (fixedOk(m)) continue;
      m.refLocked = false;
      let cands;
      if (m.round === 1) {
        // teams sitting out round 1 on a bye; if this bracket has none, borrow from the other bracket
        cands = byeTeams(key);
        if (!cands.length && br[otherKey(key)]) cands = byeTeams(otherKey(key));
        if (!cands.length && br[otherKey(key)]) cands = inBracket(otherKey(key)).filter((x) => x.round === 1 && !x.bye).flatMap((x) => [x.a, x.b]).filter(Boolean);
      } else {
        const feeders = inBracket(key).filter((x) => x.round === m.round - 1 && (x.idx === 2 * m.idx || x.idx === 2 * m.idx + 1));
        const real = feeders.filter((x) => !x.bye);
        if (real.length) {
          cands = real.flatMap(loserOf);                               // the loser of a game that feeds this one (none until it's played)
        } else {                                                       // both feeders were byes: use anyone knocked out so far
          cands = inBracket(key).filter((x) => x.round === m.round - 1).flatMap(loserOf);
          if (!cands.length) cands = eliminatedBefore(key, m.round);
        }
      }
      cands = [...new Set(cands)].filter((id) => refValid(t, m, id));
      if (cands.includes(m.ref)) { bump(m.ref); continue; }            // keep the current pick when it's still good
      cands.sort((x, y) => (counts.get(x) || 0) - (counts.get(y) || 0));
      m.ref = cands[0] || null;
      if (m.ref) bump(m.ref);
    }
  }
}

// ---------- schedule: start time, courts, game numbers ----------
const DEFAULT_START = '09:00', DEFAULT_GAME_MIN = 30;
const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : 9 * 60; };
const fmtTime = (mins) => { const x = ((mins % 1440) + 1440) % 1440; const h = Math.floor(x / 60); return `${h % 12 || 12}:${String(x % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
const startMin = (t) => toMin(t.startTime || DEFAULT_START);
const gameMin = (t) => t.gameMinutes || DEFAULT_GAME_MIN;
const ordinal = (n) => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };
const courtLabel = (c) => (c ? (/^court\b/i.test(c) ? c : 'Court ' + c) : '');
const poolTime = (t, m) => fmtTime(startMin(t) + (m.order - 1) * gameMin(t));

// Bracket games run after the longest pool finishes. Each round is spread over the pool courts
// (Gold games first); if a round has more games than courts, the rest wait for the next time slot.
function bracketSlots(t) {
  const out = new Map();
  if (!t.bracket) return out;
  const longest = Math.max(0, ...t.pools.map((p) => t.matches.filter((m) => m.pool === p.id).length));
  let clock = startMin(t) + longest * gameMin(t);
  const courts = [...new Set(t.pools.map((p) => p.court).filter(Boolean))];
  const lanes = courts.length || Math.max(1, t.pools.length);
  const maxRound = Math.max(0, ...t.bracket.matches.map((m) => m.round));
  let num = 0;
  for (let r = 1; r <= maxRound; r++) {
    const games = [];
    for (const key of ['gold', 'silver']) games.push(...t.bracket.matches.filter((m) => m.br === key && m.round === r && !m.bye).sort((x, y) => x.idx - y.idx));
    games.forEach((m, k) => {
      out.set(m.id, { num: ++num, time: fmtTime(clock + Math.floor(k / lanes) * gameMin(t)), court: courts.length ? courtLabel(courts[k % lanes]) : '' });
    });
    clock += Math.ceil(games.length / lanes) * gameMin(t);
  }
  return out;
}

// Finishing place of every team that is out (or champion) in the playoffs: losers of a round with
// R rounds to go finish 2^(R-round)+1; Silver places start after Gold.
function teamPlaces(t) {
  const places = {};
  if (!t.bracket) return places;
  const goldN = t.bracket.gold ? t.bracket.gold.seeds.length : 0;
  for (const key of ['gold', 'silver']) {
    const info = t.bracket[key];
    if (!info) continue;
    const off = key === 'gold' ? 0 : goldN;
    for (const m of t.bracket.matches) {
      if (m.br !== key || m.bye || !m.final) continue;
      const winner = m.sa > m.sb ? m.a : m.b, loser = m.sa > m.sb ? m.b : m.a;
      places[loser] = off + Math.pow(2, info.rounds - m.round) + 1;
      if (m.round === info.rounds) places[winner] = off + 1;
    }
  }
  return places;
}

// ---------- views ----------
const matchView = (t, m) => ({ id: m.id, order: m.order, a: m.a, b: m.b, sa: m.sa, sb: m.sb, final: !!m.final, ref: refRef(t, m.ref), refLocked: !!m.refLocked,
  time: poolTime(t, m), court: courtLabel((t.pools.find((p) => p.id === m.pool) || {}).court) });

function allTeams(t) {
  const places = teamPlaces(t);
  const inBr = {};
  if (t.bracket) for (const key of ['gold', 'silver']) if (t.bracket[key]) t.bracket[key].seeds.forEach((x) => { inBr[x.id] = key; });
  const out = [];
  for (const p of t.pools) {
    standings(t, p.id).forEach((r) => out.push({
      id: r.id, name: r.name, pool: p.id, poolName: p.name, court: courtLabel(p.court),
      rank: r.rank, w: r.w, l: r.l, pf: r.pf, pa: r.pa, diff: r.diff, played: r.p,
      place: places[r.id] || null, bracket: inBr[r.id] || null,
    }));
  }
  return out;
}

function publicView(t) {
  return {
    id: t.id, name: t.name, hasPin: !!t.refPin, bracketReady: !!t.bracket,
    info: { date: t.date || '', location: t.location || '', notes: t.notes || '', startTime: t.startTime || DEFAULT_START, gameMinutes: gameMin(t) },
    rules: { poolText: rulesText(poolRules(t)), bracketText: rulesText(bracketRules(t)), goldFirstText: g1Target(t) > 0 ? rulesText(goldFirstRules(t)) : '' },
    progress: { played: t.matches.filter((m) => m.final).length, total: t.matches.length }, goldCount: t.goldCount,
    teams: allTeams(t),
    pools: t.pools.map((p) => ({
      id: p.id, name: p.name, court: courtLabel(p.court), courtRaw: p.court || '',
      teams: t.teams.filter((x) => x.pool === p.id).map((x) => ({ id: x.id, name: x.name })),
      standings: standings(t, p.id),
      matches: t.matches.filter((m) => m.pool === p.id).sort((x, y) => x.order - y.order).map((m) => matchView(t, m)),
    })),
  };
}

function adminView(t) {
  const v = publicView(t);
  v.refPin = t.refPin || '';
  v.poolSize = POOL_SIZE;
  v.settings = {
    target: t.target, winByTwo: !!t.winByTwo, cap: t.cap || 0,
    bTarget: t.bTarget, bWinByTwo: !!t.bWinByTwo, bCap: t.bCap || 0, goldCount: t.goldCount, g1Target: g1Target(t), g1Cap: g1Cap(t),
    date: t.date || '', location: t.location || '', notes: t.notes || '', startTime: t.startTime || DEFAULT_START, gameMinutes: gameMin(t),
  };
  v.bracket = bracketView(t);
  v.bracketManual = !!(t.bracket && t.bracket.manual);
  v.teams = t.teams;
  v.matches = t.matches.slice().sort((x, y) => x.order - y.order).map((m) => ({ ...matchView(t, m), pool: m.pool }));
  return v;
}

function gameView(t, m) {
  const teamName = (id) => { const x = t.teams.find((y) => y.id === id); return x ? x.name : '?'; };
  const team = (id) => (id ? { id, name: teamName(id) } : { id: null, name: 'TBD' });
  const rules = rulesFor(t, m);
  const slot = m.br ? bracketSlots(t).get(m.id) : null;
  const base = {
    id: m.id, tournamentId: t.id, tournament: t.name, a: team(m.a), b: team(m.b), sa: m.sa, sb: m.sb, final: !!m.final,
    rulesText: rulesText(rules), needsPin: !!t.refPin, waiting: !!(m.br && (!m.a || !m.b)), ref: refRef(t, m.ref),
    time: slot ? slot.time : poolTime(t, m),
    court: slot ? slot.court : courtLabel((t.pools.find((p) => p.id === m.pool) || {}).court),
  };
  if (m.br) {
    const info = t.bracket[m.br];
    const inRound = t.bracket.matches.filter((x) => x.br === m.br && x.round === m.round).length;
    const rn = roundName(info.size, m.round, true);
    return { ...base, num: slot ? slot.num : null, label: `${m.br === 'gold' ? 'Gold' : 'Silver'} · ${rn}${inRound > 1 ? ' ' + (m.idx + 1) : ''}`,
      back: `/t/${t.id}/playoffs?bracket=${m.br}`, backText: 'Back' };
  }
  const pool = t.pools.find((p) => p.id === m.pool);
  return { ...base, label: `${pool ? pool.name : ''}, Match ${m.order}`,
    back: `/t/${t.id}/games?pool=${m.pool}`, backText: 'Back' };
}

// ---------- mutations ----------
function addTeams(t, pool, names) {
  const have = new Set(t.teams.map((x) => x.name.toLowerCase()));
  const fresh = [];
  for (const raw of names) {
    const name = cleanName(raw);
    if (!name || have.has(name.toLowerCase())) continue;
    have.add(name.toLowerCase());
    fresh.push(name);
  }
  const current = t.teams.filter((x) => x.pool === pool.id).length;
  if (current + fresh.length > MAX_POOL) throw new HttpError(400, `A pool can hold at most ${MAX_POOL} teams.`);
  fresh.forEach((name) => t.teams.push({ id: hex(3), name, pool: pool.id }));
  syncPool(t, pool);
}

function newPool(t, name) {
  const idx = t.pools.length;
  const label = idx < 26 ? String.fromCharCode(65 + idx) : String(idx + 1);
  const pool = { id: 'p' + hex(2), name: cleanName(name) || `Pool ${label}` };
  t.pools.push(pool);
  return pool;
}

// ---------- playoff brackets ----------
// Gold = top N of every pool, Silver = everyone else. Each bracket is single elimination and
// combines teams from ALL pools. Seeds: pool winners first, then 2nd places, then 3rds...
// (ties between pools broken by wins, point differential, points scored).
function seedLists(t) {
  const gold = [], silver = [];
  for (const pool of t.pools) {
    standings(t, pool.id).forEach((r, i) => {
      const e = { id: r.id, pool: pool.id, place: i + 1, w: r.w, diff: r.diff, pf: r.pf, name: r.name };
      (i < t.goldCount ? gold : silver).push(e);
    });
  }
  const cmp = (x, y) => x.place - y.place || y.w - x.w || y.diff - x.diff || y.pf - x.pf || x.name.localeCompare(y.name);
  return { gold: gold.sort(cmp), silver: silver.sort(cmp) };
}

const poolPlayComplete = (t) => t.matches.length > 0 && t.matches.every((m) => m.final);
const bracketStarted = (t) => !!t.bracket && t.bracket.matches.some((m) => !m.bye && isStarted(m));

function generateBrackets(t, manual) {
  const lists = seedLists(t);
  const out = { createdAt: new Date().toISOString(), manual: !!manual, gold: null, silver: null, matches: [] };
  for (const key of ['gold', 'silver']) {
    const list = lists[key];
    if (list.length < 2) continue;
    const { size, pairs } = arrange(list.map((e) => ({ id: e.id, pool: e.pool })));
    const rounds = Math.round(Math.log2(size));
    out[key] = { size, rounds, seeds: list.map((e, i) => ({ seed: i + 1, id: e.id, pool: e.pool, place: e.place })) };
    pairs.forEach(([a, b], i) => out.matches.push({ id: hex(4), br: key, round: 1, idx: i, a, b, bye: !a || !b, sa: 0, sb: 0, final: false, updatedAt: null }));
    for (let r = 2; r <= rounds; r++) {
      for (let i = 0; i < size / Math.pow(2, r); i++) {
        out.matches.push({ id: hex(4), br: key, round: r, idx: i, a: null, b: null, bye: false, sa: 0, sb: 0, final: false, updatedAt: null });
      }
    }
  }
  t.bracket = out;
  propagate(t);
}

// Moves winners forward. If a result changes after the next game was already started,
// that next game's score is cleared (its opponent is no longer the same team).
function propagate(t) {
  if (!t.bracket) return;
  for (const key of ['gold', 'silver']) {
    const info = t.bracket[key];
    if (!info) continue;
    const at = (r, i) => t.bracket.matches.find((m) => m.br === key && m.round === r && m.idx === i);
    for (let r = 1; r < info.rounds; r++) {
      for (let i = 0; i < info.size / Math.pow(2, r); i++) {
        const m = at(r, i), next = at(r + 1, Math.floor(i / 2));
        const w = m.bye ? (m.a || m.b) : m.final ? (m.sa > m.sb ? m.a : m.b) : null;
        const slot = i % 2 === 0 ? 'a' : 'b';
        if (next[slot] !== w) {
          next[slot] = w;
          if (isStarted(next)) { next.sa = 0; next.sb = 0; next.final = false; }
        }
      }
    }
  }
  refreshBracketRefs(t);
}

// Brackets fill themselves in once every pool game is finished, and re-seed if a pool result is
// corrected -- until the first bracket game is played, after which they are left alone.
function maybeAutoBracket(t) {
  if (bracketStarted(t)) return;
  if (poolPlayComplete(t)) generateBrackets(t, false);
  else if (t.bracket && t.bracket.manual) generateBrackets(t, true);
  else t.bracket = null;
}

function bracketView(t) {
  const total = t.matches.length, played = t.matches.filter((m) => m.final).length;
  const view = {
    ready: !!t.bracket, progress: { played, total }, goldCount: t.goldCount,
    poolText: rulesText(poolRules(t)), bracketText: rulesText(bracketRules(t)), brackets: [],
  };
  if (!t.bracket) return view;
  const tag = (pid) => { const p = t.pools.find((x) => x.id === pid); return p ? p.name.replace(/^pool\s+/i, '').slice(0, 3) : ''; };
  for (const key of ['gold', 'silver']) {
    const info = t.bracket[key];
    if (!info) continue;
    const seedOf = Object.fromEntries(info.seeds.map((x) => [x.id, x]));
    const slots = bracketSlots(t);
    const off = key === 'gold' ? 0 : (t.bracket.gold ? t.bracket.gold.seeds.length : 0);
    const ref = (id) => {
      if (!id) return null;
      const team = t.teams.find((x) => x.id === id);
      const sd = seedOf[id];
      const pl = sd ? t.pools.find((p) => p.id === sd.pool) : null;
      return { id, name: team ? team.name : '?', seed: sd ? sd.seed : null, pool: sd ? tag(sd.pool) : '', from: sd && pl ? `${ordinal(sd.place)} in ${pl.name}` : '' };
    };
    const rounds = [];
    for (let r = 1; r <= info.rounds; r++) {
      rounds.push({
        name: roundName(info.size, r, false),
        rules: rulesText(rulesFor(t, { br: key, round: r })),
        matches: t.bracket.matches.filter((m) => m.br === key && m.round === r).sort((x, y) => x.idx - y.idx).map((m) => ({
          id: m.id, idx: m.idx, a: ref(m.a), b: ref(m.b), bye: !!m.bye, sa: m.sa, sb: m.sb, final: !!m.final,
          live: !m.final && (m.sa > 0 || m.sb > 0), ref: refRef(t, m.ref), refLocked: !!m.refLocked,
          num: (slots.get(m.id) || {}).num || null, time: (slots.get(m.id) || {}).time || '', court: (slots.get(m.id) || {}).court || '',
          losersFinish: m.bye ? '' : ordinal(off + Math.pow(2, info.rounds - r) + 1),
        })),
      });
    }
    const last = t.bracket.matches.find((m) => m.br === key && m.round === info.rounds);
    const champId = last && last.final ? (last.sa > last.sb ? last.a : last.b) : null;
    view.brackets.push({
      key, name: key === 'gold' ? 'Gold' : 'Silver', size: info.size, rounds,
      seeds: info.seeds.map((x) => ({ seed: x.seed, name: (ref(x.id) || {}).name, pool: tag(x.pool), place: x.place })),
      champion: champId ? ref(champId) : null,
    });
  }
  return view;
}

// ---------- migration from the earlier (single list, per-match link) format ----------
for (const t of db.tournaments) {
  if (t.teams) continue;
  const pool = { id: 'p' + hex(2), name: 'Pool A' };
  t.pools = [pool];
  t.teams = (t.players || []).map((p) => ({ id: p.id, name: p.name, pool: pool.id }));
  t.matches = (t.matches || []).map((m, i) => ({
    id: m.id, pool: pool.id, order: i + 1, a: m.a, b: m.b,
    sa: m.sa == null ? 0 : m.sa, sb: m.sb == null ? 0 : m.sb, final: m.sa != null && m.sb != null, updatedAt: m.updatedAt || null,
  }));
  t.target = DEFAULT_TARGET; t.refPin = '';
  delete t.players; delete t.winPts; delete t.drawPts;
  syncPool(t, pool);
}
for (const t of db.tournaments) {
  if (t.cap === undefined) { // introduced with brackets: pool play is win-by-2 with a cap at 23
    t.cap = DEFAULT_CAP; t.winByTwo = true;
    t.bTarget = DEFAULT_TARGET; t.bWinByTwo = true; t.bCap = 0; t.goldCount = DEFAULT_GOLD;
    t.matches.forEach((m) => { m.final = isFinal(poolRules(t), m); });
  }
  maybeAutoBracket(t);
  t.pools.forEach((p) => refreshPoolRefs(t, p));
  refreshBracketRefs(t);
}
save();

// ---------- API ----------
async function api(req, res, pathname) {
  const method = req.method;
  const parts = pathname.split('/').filter(Boolean).slice(1); // drop "api"

  // ---- public ----
  if (method === 'GET' && parts[0] === 'tournaments' && parts.length === 1) {
    return send(res, 200, listTournaments());
  }
  if (method === 'GET' && parts[0] === 't' && parts.length === 2) {
    return send(res, 200, publicView(findTournament(parts[1])));
  }
  if (method === 'GET' && parts[0] === 'b' && parts.length === 2) {
    const t = findTournament(parts[1]);
    return send(res, 200, { id: t.id, name: t.name, ...bracketView(t) });
  }
  if (parts[0] === 'g' && parts[1]) {
    const { t, m } = findMatch(parts[1]);
    if (method === 'GET' && parts.length === 2) return send(res, 200, gameView(t, m));

    const canScore = (pin) => isAdmin(req) || !t.refPin || (pin && safeEqual(pin, t.refPin));

    if (method === 'POST' && parts[2] === 'check') {
      const body = await readBody(req);
      if (!canScore(body.pin)) throw new HttpError(401, 'Wrong PIN');
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && parts[2] === 'score') {
      const body = await readBody(req);
      if (!canScore(body.pin)) throw new HttpError(401, 'Referee PIN required');
      if (m.br && (!m.a || !m.b)) throw new HttpError(409, 'This game is waiting on earlier results.');
      if (body.side !== 'a' && body.side !== 'b') throw new HttpError(400, 'Bad side');
      if (body.delta !== 1 && body.delta !== -1) throw new HttpError(400, 'Bad change');
      const key = body.side === 'a' ? 'sa' : 'sb';
      if (body.delta === 1) {
        if (m.final) throw new HttpError(409, 'This match is over. Tap −1 to correct a mistake.');
        m[key] += 1;
      } else if (m[key] > 0) {
        m[key] -= 1;
      }
      m.final = isFinal(rulesFor(t, m), m);
      m.updatedAt = new Date().toISOString();
      if (m.br) propagate(t); else maybeAutoBracket(t);
      save();
      return send(res, 200, gameView(t, m));
    }
  }

  // ---- admin ----
  if (parts[0] === 'admin') {
    requireAdmin(req);
    const rest = parts.slice(1);

    if (method === 'GET' && rest[0] === 'check') return send(res, 200, { ok: true });

    if (rest[0] === 'tournaments' && rest.length === 1) {
      if (method === 'GET') return send(res, 200, listTournaments());
      if (method === 'POST') {
        const body = await readBody(req);
        const name = cleanName(body.name);
        if (!name) throw new HttpError(400, 'Give the tournament a name.');
        const t = {
          id: slug(name) + '-' + hex(2), name, createdAt: new Date().toISOString(),
          target: parseTarget(body.target, DEFAULT_TARGET), winByTwo: body.winByTwo !== false, cap: DEFAULT_CAP,
          bTarget: DEFAULT_TARGET, bWinByTwo: true, bCap: 0, goldCount: DEFAULT_GOLD,
          refPin: String(body.refPin || '').trim().slice(0, 20),
          pools: [], teams: [], matches: [], bracket: null,
        };
        t.cap = parseCap(body.cap === undefined ? DEFAULT_CAP : body.cap, t.target);
        const count = Math.max(1, Math.min(12, parseInt(body.pools, 10) || 1));
        for (let i = 0; i < count; i++) newPool(t, '');
        db.tournaments.push(t);
        save();
        return send(res, 200, { id: t.id });
      }
    }

    if (rest[0] === 't' && rest[1]) {
      const t = findTournament(rest[1]);
      const sub = rest[2];
      const reply = (skipAuto) => { if (!skipAuto) maybeAutoBracket(t); save(); return send(res, 200, adminView(t)); };

      if (!sub) {
        if (method === 'GET') return send(res, 200, adminView(t));
        if (method === 'PATCH') {
          const body = await readBody(req);
          if (body.name !== undefined) { const n = cleanName(body.name); if (n) t.name = n; }
          if (body.target !== undefined) t.target = parseTarget(body.target, t.target);
          if (body.winByTwo !== undefined) t.winByTwo = !!body.winByTwo;
          if (body.cap !== undefined) t.cap = parseCap(body.cap, t.target);
          if (body.bTarget !== undefined) t.bTarget = parseTarget(body.bTarget, t.bTarget);
          if (body.bWinByTwo !== undefined) t.bWinByTwo = !!body.bWinByTwo;
          if (body.bCap !== undefined) t.bCap = parseCap(body.bCap, t.bTarget);
          if (body.g1Target !== undefined || body.g1Cap !== undefined) {
            const g = body.g1Target === undefined ? g1Target(t) : Number(body.g1Target);
            if (!Number.isInteger(g) || g < 0 || g > 99) throw new HttpError(400, 'Gold first round should be 0 (same as other games) or a whole number up to 99.');
            const c = body.g1Cap === undefined || body.g1Cap === '' || body.g1Cap === null ? (body.g1Cap === undefined ? g1Cap(t) : 0) : Number(body.g1Cap);
            if (!Number.isInteger(c) || c < 0 || c > 199 || (c > 0 && g > 0 && c < g)) throw new HttpError(400, 'The Gold first-round cap must be 0 (none) or at least the play-to score. A cap equal to the score means the first team to reach it wins.');
            t.g1Target = g; t.g1Cap = c;
          }
          if (body.goldCount !== undefined) {
            const g = Number(body.goldCount);
            if (!Number.isInteger(g) || g < 1 || g >= MAX_POOL) throw new HttpError(400, 'Gold spots per pool must be a whole number from 1 to ' + (MAX_POOL - 1) + '.');
            t.goldCount = g;
          }
          if (body.refPin !== undefined) t.refPin = String(body.refPin).trim().slice(0, 20);
          if (body.date !== undefined) t.date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) ? String(body.date) : '';
          if (body.location !== undefined) t.location = String(body.location).trim().slice(0, 120);
          if (body.notes !== undefined) t.notes = String(body.notes).slice(0, 4000);
          if (body.startTime !== undefined) {
            if (!/^\d{1,2}:\d{2}$/.test(String(body.startTime))) throw new HttpError(400, 'Start time should look like 09:00.');
            t.startTime = String(body.startTime).padStart(5, '0');
          }
          if (body.gameMinutes !== undefined) {
            const g = Number(body.gameMinutes);
            if (!Number.isInteger(g) || g < 5 || g > 240) throw new HttpError(400, 'Minutes per game should be a whole number from 5 to 240.');
            t.gameMinutes = g;
          }
          t.matches.forEach((m) => { m.final = isFinal(poolRules(t), m); }); // rules may have changed
          if (t.bracket) { t.bracket.matches.forEach((m) => { if (!m.bye) m.final = isFinal(rulesFor(t, m), m); }); propagate(t); }
          return reply();
        }
        if (method === 'DELETE') {
          db.tournaments = db.tournaments.filter((x) => x !== t);
          save();
          return send(res, 200, { ok: true });
        }
      }

      if (sub === 'reset' && method === 'POST') {
        t.matches.forEach((m) => { m.sa = 0; m.sb = 0; m.final = false; m.updatedAt = null; });
        t.bracket = null;
        t.pools.forEach((p) => syncPool(t, p));
        return reply();
      }

      if (sub === 'bracket') {
        if (method === 'POST') {
          const body = await readBody(req);
          if (bracketStarted(t) && !body.force) throw new HttpError(409, 'Bracket games have already been played. Re-creating the bracket would erase them.');
          generateBrackets(t, !poolPlayComplete(t));
          return reply(true);
        }
        if (method === 'DELETE') { t.bracket = null; return reply(true); }
      }

      if (sub === 'pools') {
        if (method === 'POST' && !rest[3]) {
          const body = await readBody(req);
          newPool(t, body.name);
          return reply();
        }
        const pool = rest[3] ? findPool(t, rest[3]) : null;
        if (pool && !rest[4]) {
          if (method === 'PATCH') {
            const body = await readBody(req);
            const n = cleanName(body.name); if (n) pool.name = n;
            if (body.court !== undefined) pool.court = cleanName(body.court).slice(0, 20);
            return reply();
          }
          if (method === 'DELETE') {
            t.teams = t.teams.filter((x) => x.pool !== pool.id);
            t.matches = t.matches.filter((m) => m.pool !== pool.id);
            t.pools = t.pools.filter((p) => p !== pool);
            return reply();
          }
        }
        if (pool && rest[4] === 'teams' && method === 'POST') {
          const body = await readBody(req);
          const names = Array.isArray(body.names) ? body.names : String(body.names || '').split('\n');
          addTeams(t, pool, names);
          return reply();
        }
        if (pool && rest[4] === 'schedule' && method === 'POST') {
          syncPool(t, pool);
          return reply();
        }
      }

      if (sub === 'teams' && rest[3]) {
        const team = findTeam(t, rest[3]);
        if (method === 'PATCH') {
          const body = await readBody(req);
          if (body.name !== undefined) { const n = cleanName(body.name); if (n) team.name = n; }
          if (body.pool !== undefined && body.pool !== team.pool) {
            const dest = findPool(t, body.pool);
            if (t.teams.filter((x) => x.pool === dest.id).length >= MAX_POOL) throw new HttpError(400, `A pool can hold at most ${MAX_POOL} teams.`);
            const from = findPool(t, team.pool);
            team.pool = dest.id;
            syncPool(t, from); syncPool(t, dest);
          }
          return reply();
        }
        if (method === 'DELETE') {
          const from = findPool(t, team.pool);
          t.teams = t.teams.filter((x) => x !== team);
          syncPool(t, from);
          return reply();
        }
      }

      if (sub === 'matches' && rest[3] && method === 'PATCH') {
        const m = t.matches.find((x) => x.id === rest[3]) || (t.bracket && t.bracket.matches.find((x) => x.id === rest[3]));
        if (!m) throw new HttpError(404, 'Match not found');
        if (m.br && (!m.a || !m.b)) throw new HttpError(409, 'That game is waiting on earlier results.');
        const body = await readBody(req);
        if ('sa' in body || 'sb' in body) {
          m.sa = parseScore(body.sa); m.sb = parseScore(body.sb);
          m.final = isFinal(rulesFor(t, m), m);
          m.updatedAt = new Date().toISOString();
        }
        if ('ref' in body) {
          if (body.ref === 'auto' || body.ref === null || body.ref === '') m.refLocked = false;
          else {
            if (!refValid(t, m, body.ref)) throw new HttpError(400, 'Pick a team that is not playing in this game.');
            m.ref = body.ref; m.refLocked = true;
          }
        }
        if (m.br) { propagate(t); return reply(true); }
        refreshPoolRefs(t, t.pools.find((p) => p.id === m.pool));
        return reply();
      }
    }
  }

  throw new HttpError(404, 'Not found');
}

function listTournaments() {
  return db.tournaments.slice().reverse().map((t) => ({
    id: t.id, name: t.name, createdAt: t.createdAt, date: t.date || '', location: t.location || '',
    pools: t.pools.length, teams: t.teams.length,
    matches: t.matches.length, played: t.matches.filter((m) => m.final).length,
  }));
}

// ---------- static files ----------
const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

// Dev live-reload (only with DEV=1): browsers reload when anything in public/ changes.
const DEV = process.env.DEV === '1';
const reloadClients = new Set();
if (DEV) {
  let timer = null;
  fs.watch(PUBLIC_DIR, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => reloadClients.forEach((r) => r.write('data: reload\n\n')), 80);
  });
}
const RELOAD_SNIPPET = '<script>new EventSource("/__reload").onmessage=()=>location.reload();</script>';

function serveStatic(req, res, pathname) {
  if (DEV && pathname === '/__reload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    reloadClients.add(res);
    req.on('close', () => reloadClients.delete(res));
    return;
  }
  const entry = STATIC[pathname] || ['index.html', 'text/html; charset=utf-8'];
  fs.readFile(path.join(PUBLIC_DIR, entry[0]), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
    res.end(DEV && entry[0] === 'index.html' ? buf.toString().replace('</body>', RELOAD_SNIPPET + '</body>') : buf);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) return await api(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    return serveStatic(req, res, pathname);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error' : e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal);
  console.log('\n  Tournament Scoreboard is running\n');
  console.log(`  On this computer:  http://localhost:${PORT}`);
  nets.forEach((n) => console.log(`  On your network:   http://${n.address}:${PORT}`));
  console.log(`\n  Admin page:        http://localhost:${PORT}/admin`);
  console.log(`  Admin password:    ${adminPassword}${generatedPassword ? '   (generated; saved in data.json — or set ADMIN_PASSWORD)' : ''}\n`);
});
