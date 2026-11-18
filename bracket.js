'use strict';
// Single-elimination bracket layout.
//
// Teams come in seed order (index 0 = seed 1). We use the standard bracket where seed 1
// plays the lowest seed, 2 plays the second-lowest, and so on; when the field isn't a
// power of two, the top seeds get byes.
//
// To avoid rematches of teams that already played each other in pool play, we then
// shuffle WHICH low seed each top seed faces (only the low seeds move; the top seeds
// keep their protected spots). Cost = heavy penalty for same-pool first-round games,
// lighter penalties for same-pool teams that could meet in later rounds, plus a small
// penalty for drifting from the standard pairing.

const WEIGHTS = [0, 1000, 40, 12, 4, 1]; // by round; round 1 matters most

const nextPow2 = (n) => { let p = 2; while (p < n) p *= 2; return p; };

function seedOrder(n) {
  let o = [1];
  while (o.length < n) {
    const len = o.length * 2;
    o = o.flatMap((s) => [s, len + 1 - s]);
  }
  return o; // o[position] = seed
}

function sameTeamCost(pos, poolOf) {
  const N = pos.length;
  let c = 0;
  for (let size = 2, r = 1; size <= N; size *= 2, r++) {
    const w = WEIGHTS[Math.min(r, 5)];
    const half = size / 2;
    for (let start = 0; start < N; start += size) {
      for (let i = start; i < start + half; i++) {
        if (pos[i] == null) continue;
        for (let j = start + half; j < start + size; j++) {
          if (pos[j] != null && poolOf[pos[i]] === poolOf[pos[j]]) c += w;
        }
      }
    }
  }
  return c;
}

// teams: [{ id, pool }] in seed order. Returns { size, pairs: [[idA|null, idB|null], ...] }
function arrange(teams) {
  const T = teams.length;
  const N = nextPow2(T);
  const half = N / 2;
  const order = seedOrder(N);
  const poolOf = teams.map((t) => t.pool);

  const tops = []; for (let s = N + 1 - T; s <= half; s++) tops.push(s); // top seeds that play in round 1
  const lows = []; for (let s = half + 1; s <= T; s++) lows.push(s);     // their (standard) opponents

  const build = (assign) => {
    const pos = new Array(N).fill(null);
    for (let j = 0; j < N / 2; j++) {
      const x = order[2 * j], y = order[2 * j + 1]; // x is the top seed of the pair
      pos[2 * j] = x <= T ? x - 1 : null;
      if (y > T) pos[2 * j + 1] = null; // bye
      else pos[2 * j + 1] = assign[tops.indexOf(x)] - 1;
    }
    return pos;
  };
  const score = (assign) => {
    let dev = 0;
    assign.forEach((s, k) => { dev += Math.abs(s - (N + 1 - tops[k])); });
    return sameTeamCost(build(assign), poolOf) + dev;
  };

  let best = tops.map((s) => N + 1 - s); // standard pairing
  let bestScore = score(best);

  if (lows.length <= 8) {
    // brute force every way of matching top seeds to low seeds
    const cur = [], used = new Array(lows.length).fill(false);
    const rec = () => {
      if (cur.length === lows.length) {
        const sc = score(cur);
        if (sc < bestScore) { bestScore = sc; best = cur.slice(); }
        return;
      }
      for (let i = 0; i < lows.length; i++) {
        if (used[i]) continue;
        used[i] = true; cur.push(lows[i]); rec(); cur.pop(); used[i] = false;
      }
    };
    rec();
  } else {
    // big brackets: hill-climb with pairwise swaps
    let improved = true, passes = 0;
    while (improved && passes++ < 60) {
      improved = false;
      for (let i = 0; i < best.length; i++) {
        for (let j = i + 1; j < best.length; j++) {
          const trial = best.slice(); [trial[i], trial[j]] = [trial[j], trial[i]];
          const sc = score(trial);
          if (sc < bestScore) { bestScore = sc; best = trial; improved = true; }
        }
      }
    }
  }

  const pos = build(best);
  const pairs = [];
  for (let j = 0; j < N / 2; j++) {
    const a = pos[2 * j], b = pos[2 * j + 1];
    pairs.push([a == null ? null : teams[a].id, b == null ? null : teams[b].id]);
  }
  return { size: N, pairs };
}

// name of a round given the bracket size: "Final", "Semifinals", ...
function roundName(size, round, singular) {
  const left = size / Math.pow(2, round - 1); // teams still alive at the start of this round
  if (left === 2) return 'Final';
  if (left === 4) return singular ? 'Semifinal' : 'Semifinals';
  if (left === 8) return singular ? 'Quarterfinal' : 'Quarterfinals';
  return `Round of ${left}`;
}

module.exports = { arrange, roundName, nextPow2 };
