'use strict';
// Orders a pool's matches so teams rest between games.
//
// A "violation" is two consecutive games that share a team (a back-to-back).
// We search for an ordering with zero violations first, then allow 1, 2, ...
// only if a clean ordering does not exist (e.g. pools of 3 or 4 can't avoid them).
// Among equally clean orderings we prefer the one where teams rest the longest.

const NODE_LIMIT = 200000;

function orderMatches(matches, prevTeams) {
  const n = matches.length;
  if (n <= 1) return matches.slice();
  const before = prevTeams || new Set();

  for (let maxViolations = 0; maxViolations <= n; maxViolations++) {
    const used = new Array(n).fill(false);
    const seq = [];
    let nodes = 0;

    // how many games ago did this team last play? (large number = never / long ago)
    const gamesSinceLast = (team) => {
      for (let i = seq.length - 1, d = 1; i >= 0; i--, d++) {
        if (seq[i].a === team || seq[i].b === team) return d;
      }
      return before.has(team) ? 1 : 99;
    };

    const dfs = (violations) => {
      if (seq.length === n) return true;
      if (++nodes > NODE_LIMIT) return false;

      const candidates = [];
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        const m = matches[i];
        const ra = gamesSinceLast(m.a), rb = gamesSinceLast(m.b);
        const clash = ra === 1 || rb === 1 ? 1 : 0;
        if (violations + clash > maxViolations) continue;
        candidates.push({ i, clash, restMin: Math.min(ra, rb), restSum: ra + rb });
      }
      // clean games first, then whoever has rested the longest
      candidates.sort((x, y) => x.clash - y.clash || y.restMin - x.restMin || y.restSum - x.restSum || x.i - y.i);

      for (const c of candidates) {
        used[c.i] = true; seq.push(matches[c.i]);
        if (dfs(violations + c.clash)) return true;
        seq.pop(); used[c.i] = false;
        if (nodes > NODE_LIMIT) return false;
      }
      return false;
    };

    if (dfs(0)) return seq;
  }
  return matches.slice();
}

module.exports = { orderMatches };
