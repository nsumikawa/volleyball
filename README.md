# Volleyball Tournament Scoreboard

A small, reusable site for running pool play. No database, no `npm install` — just Node 18+.

## Run it

    node server.js

It prints your local address, your network address, and the admin password.
(The password is generated on first run and saved in `data.json`. To choose your own:
`ADMIN_PASSWORD=mypass node server.js`. Change the port with `PORT=8080`.)

## How it works

**Organizer** (`/admin`, password-protected)
- Create a tournament: name, number of pools, play-to score (default 21), optional referee PIN,
  optional "win by 2".
- Each pool holds up to 5 teams (the counter turns gold if you go over; the hard limit is 8).
  Add teams to a pool, and move a team to another pool with the dropdown next to its name.
- **Matches are created automatically** — every team plays every other team in its pool once.
  Games are ordered so no team plays back-to-back where that's possible
  (a 5-team pool gets 10 games with a rest between every game for every team).
  Pools of 3 or 4 can't avoid back-to-backs mathematically; they get the fewest possible.
- Games that already have points keep their place when you change a pool; only unplayed games are re-ordered.
  "Re-space games" re-runs the ordering on demand.
- You can fix any score by hand from the pool's game list.

**Rules**
- Pool play: first to 21, win by 2, **cap at 23** (the first team to 23 wins outright).
- Playoffs: first to 21, win by 2, **no cap**. All of these can be changed per tournament under "Rules".

**Playoff brackets** (`/b/<tournament>`)
- The top 3 teams of every pool go to a **Gold** bracket; everyone else (4th and 5th) goes to **Silver**.
  Both are single elimination and combine teams from *all* pools.
- Brackets **fill in automatically** when the last pool game is finished (you can also create them early from the admin page).
- Seeding: pool winners are the top seeds, then 2nd places, then 3rds (ties between pools: wins, point differential, points scored).
  Seed 1 plays the lowest seed, 2 plays the second-lowest, and so on; top seeds get byes if the field isn't a power of two.
  Then the lower seeds are shuffled where needed so teams that already played each other in pool play
  don't meet in round 1 (and are kept apart in later rounds where possible).
- Until the first bracket game is played, a corrected pool score re-seeds the brackets. After that they're locked.

**Everyone** (`/t/<tournament>`)
- Pool tabs, each with its own standings (wins, then point differential, then points scored)
  and its games in play order. Updates every few seconds — good for a TV.
- Tap a game to open its scoreboard.

**Referees** (`/g/<game>`)
- Big scores with a **+1** and **−1** button for each team. The game ends by the rules above
  (win by 2 / cap). A finished game can be corrected with −1; bracket games open once both teams are known.
- If you set a referee PIN, everyone can watch a game but only people who enter the PIN get the buttons
  (the phone remembers it). With no PIN, anyone who opens a game can change its score.

### Referees

Every game gets a suggested ref, shown on the scoreboard, bracket and game pages.

- **Pool games:** the ref is a team from a nearby game (preferably the one just before), spread evenly so nobody refs too often, and never a team in the game itself.
- **First bracket round:** teams with a bye ref first (own bracket, then the other bracket).
- **Later bracket rounds:** a team that just lost into that game. Until that's known, the ref shows as to be decided.
- **Override:** in the admin game list, pick any team from the Ref dropdown (or "Auto" to go back to automatic).

### Pages (modeled on CBVA tournament pages)

Each tournament has five tabs: **Information** (director notes, schedule, format), **Teams** (tap a team for its record and final place), **Pools** (choose a pool, tap a row for details), **Games** (match cards per pool with time, court and ref) and **Playoffs** (Gold/Silver brackets with round buttons and zoom). Set the date, location, notes, first game time and minutes per game under *Event details* in the admin page, and give each pool a court with its *Set court* button. Game times are estimates: pool games run back to back on each pool's court, and playoffs start once the longest pool is done.

### Phone layout

Built phone-first: big tap targets, sticky pool tabs, vertical bracket lists, and a scoring screen that fits portrait and landscape without scrolling. Admin game lists are collapsible.

### Developing

Run `./dev.sh` (same as `DEV=1 node --watch server.js`). The server restarts when its code changes and open browser pages reload when anything in `public/` changes. Use plain `node server.js` for the real tournament.

## Your data

Everything lives in `data.json`. Copy it to back up or move. Older data from the first version of this app
(a single list of players) is converted automatically into "Pool A" on first start.

## Letting people join

- **Same Wi-Fi / in person:** give people the "On your network" address. Open `/admin` using that
  address (not `localhost`) before copying links.
- **Anyone, anywhere:** use a tunnel, e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`.
  Keep the computer awake while the event runs.
