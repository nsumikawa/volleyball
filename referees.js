'use strict';
// Picks a referee for every game in a pool.
//
// Rules, in order of importance:
//   1. The ref is never one of the two teams playing.
//   2. Refereeing is spread evenly (nobody refs more than ceil(games / teams) unless that's impossible).
//   3. Prefer a team from the PREVIOUS game — they are already at the court.
//   4. Prefer someone who isn't playing the very next game, so refs aren't thrown straight back in.
//
// games: [{ a, b, fixed }] in play order. `fixed` is a team id for games whose ref is already
// settled (played, or set by hand) — those are kept and counted, never changed.

const NOT_PREVIOUS = 10;
const PLAYS_NEXT = 1;
const NODE_LIMIT = 300000;

function assignPoolRefs(games, teamIds) {
  const n = games.length;
  const refs = new Array(n).fill(null);
  if (!n || !teamIds.length) return refs;

  const playsIn = (i, t) => i >= 0 && i < n && (games[i].a === t || games[i].b === t);
  const options = games.map((g) => (g.fixed ? [g.fixed] : teamIds.filter((t) => t !== g.a && t !== g.b)));
  const cost = (i, t) => (i > 0 && !playsIn(i - 1, t) ? NOT_PREVIOUS : 0) + (playsIn(i + 1, t) ? PLAYS_NEXT : 0);

  let best = null, bestCost = Infinity;
  for (let cap = Math.ceil(n / teamIds.length); cap <= n && !best; cap++) {
    const counts = new Map();
    const cur = new Array(n).fill(null);
    let nodes = 0;
    const dfs = (i, total) => {
      if (total >= bestCost) return;
      if (i === n) { best = cur.slice(); bestCost = total; return; }
      if (++nodes > NODE_LIMIT) return;
      if (!options[i].length) { cur[i] = null; dfs(i + 1, total); return; }
      const opts = options[i]
        .map((t) => ({ t, c: cost(i, t), k: counts.get(t) || 0 }))
        .filter((o) => games[i].fixed || o.k < cap)
        .sort((x, y) => x.c - y.c || x.k - y.k);
      for (const o of opts) {
        counts.set(o.t, o.k + 1); cur[i] = o.t;
        dfs(i + 1, total + o.c);
        counts.set(o.t, o.k);
        if (nodes > NODE_LIMIT) return;
      }
    };
    dfs(0, 0);
  }
  return best || refs;
}

module.exports = { assignPoolRefs };
