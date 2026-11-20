#!/usr/bin/env node
'use strict';
// Creates a new, empty scoreboard database (used by create-db.sh).
//   node tools/create-db.js <file.sqlite> [--import old-data.json] [--password secret]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store, importJsonOnce } = require('../store');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
if (!file) { console.error('usage: create-db.js <file.sqlite> [--import data.json] [--password secret]'); process.exit(2); }
if (fs.existsSync(file)) { console.error(`${file} already exists; not touching it.`); process.exit(3); }
fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

let store;
try { store = new Store(file); } catch (e) { console.error(e.message); process.exit(1); }
store.begin();
try {
  let db = { config: {}, tournaments: [] };
  const from = opt('--import');
  if (from) {
    db = importJsonOnce(store, from);
    if (!db) throw new Error(`Could not import ${from} (file missing?)`);
    console.log(`Imported ${db.tournaments.length} tournament(s) from ${from}`);
  }
  let pw = opt('--password') || process.env.ADMIN_PASSWORD || db.config.adminPassword;
  if (!pw) pw = crypto.randomBytes(5).toString('hex');
  db.config.adminPassword = pw;
  store.write(db);
  store.commit();
  console.log(`Created ${path.resolve(file)}`);
  console.log(`Admin password: ${pw}`);
} catch (e) {
  store.rollback(); store.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
  console.error(e.message); process.exit(1);
}
store.close();
