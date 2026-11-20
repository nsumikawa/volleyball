'use strict';
// SQLite storage for the scoreboard.
//
// Uses Node's built-in `node:sqlite` (Node 22.13+), or `better-sqlite3` if you have installed it.
//
// Layout: one row per tournament (its whole document as JSON) plus a small key/value table.
// - WAL mode, so readers never block the writer and the writer never blocks readers.
// - Every change happens inside BEGIN IMMEDIATE ... COMMIT, so a second process (or a second
//   copy of the server by mistake) waits its turn instead of overwriting the first one's work.
// - Only the tournaments that actually changed are written, never the whole database.
// - PRAGMA data_version tells us when ANOTHER connection has committed, so we know to reload.

const fs = require('fs');

function openDatabase(file) {
  const realEmit = process.emitWarning;
  process.emitWarning = function (w, ...rest) { // node:sqlite prints an "experimental" notice; keep the console clean
    if (/sqlite/i.test(String((w && w.message) || w))) return;
    return realEmit.call(process, w, ...rest);
  };
  try {
    try { return new (require('node:sqlite').DatabaseSync)(file); } catch (e) { if (e.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && e.code !== 'MODULE_NOT_FOUND') throw e; }
    try { return new (require('better-sqlite3'))(file); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  } finally { process.emitWarning = realEmit; }
  throw new Error(
    `This app now stores its data in SQLite, which needs Node 22.13 or newer (you have ${process.version}).\n` +
    '  Fix: install the current Node LTS from https://nodejs.org, then run the server again.\n' +
    '  (Alternative on older Node: run "npm install better-sqlite3" in this folder.)');
}

class Store {
  constructor(file) {
    this.file = file;
    this.d = openDatabase(file);
    this.d.exec('PRAGMA busy_timeout = 15000'); // wait up to 15 s for another writer instead of failing
    this.d.exec('PRAGMA journal_mode = WAL');
    this.d.exec('PRAGMA synchronous = NORMAL');  // safe in WAL mode; a power cut can only lose the last instant, never corrupt
    this.d.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tournaments (
        id TEXT PRIMARY KEY,
        pos INTEGER NOT NULL,
        doc TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`);
    this.inTx = false;
    this.saved = new Map();   // id -> "pos:json" as last read from / written to the database
    this.savedConfig = null;
    this.seen = null;         // data_version when we last loaded
  }

  version() { return this.d.prepare('PRAGMA data_version').get().data_version; }
  changedByOthers() { return this.version() !== this.seen; }

  begin() { if (!this.inTx) { this.d.exec('BEGIN IMMEDIATE'); this.inTx = true; } }
  commit() { if (this.inTx) { this.inTx = false; this.d.exec('COMMIT'); } }
  rollback() { if (this.inTx) { this.inTx = false; try { this.d.exec('ROLLBACK'); } catch { /* already rolled back */ } } }

  getKv(key) { const r = this.d.prepare('SELECT value FROM kv WHERE key = ?').get(key); return r ? r.value : null; }
  setKv(key, value) { this.d.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }

  // Read everything into a plain { config, tournaments } object.
  load() {
    const db = { config: {}, tournaments: [] };
    const cfg = this.getKv('config');
    if (cfg) db.config = JSON.parse(cfg);
    this.savedConfig = cfg;
    this.saved = new Map();
    for (const r of this.d.prepare('SELECT id, pos, doc FROM tournaments ORDER BY pos, id').all()) {
      db.tournaments.push(JSON.parse(r.doc));
      this.saved.set(r.id, r.pos + ':' + r.doc);
    }
    this.seen = this.version();
    return db;
  }

  isEmpty() { return this.getKv('config') === null && this.d.prepare('SELECT COUNT(*) AS n FROM tournaments').get().n === 0; }

  // Write whatever changed. Joins the open transaction if there is one, otherwise makes its own.
  write(db) {
    const own = !this.inTx;
    if (own) this.begin();
    try {
      const cfg = JSON.stringify(db.config || {});
      if (cfg !== this.savedConfig) { this.setKv('config', cfg); this.savedConfig = cfg; }
      const up = this.d.prepare(`INSERT INTO tournaments (id, pos, doc, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET pos = excluded.pos, doc = excluded.doc, updated_at = excluded.updated_at`);
      const now = new Date().toISOString();
      const keep = new Set();
      db.tournaments.forEach((t, i) => {
        keep.add(t.id);
        const doc = JSON.stringify(t);
        const sig = i + ':' + doc;
        if (this.saved.get(t.id) !== sig) { up.run(t.id, i, doc, now); this.saved.set(t.id, sig); }
      });
      const del = this.d.prepare('DELETE FROM tournaments WHERE id = ?');
      for (const id of [...this.saved.keys()]) if (!keep.has(id)) { del.run(id); this.saved.delete(id); }
      if (own) this.commit();
    } catch (e) { if (own) this.rollback(); throw e; }
  }

  close() { try { this.rollback(); this.d.close(); } catch { /* ignore */ } }
}

// First run on the new storage: bring over the old data.json, once.
function importJsonOnce(store, jsonFile) {
  if (!store.isEmpty() || store.getKv('imported_from') || !fs.existsSync(jsonFile)) return null;
  const old = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  const db = { config: old.config || {}, tournaments: old.tournaments || [] };
  store.setKv('imported_from', jsonFile + ' @ ' + new Date().toISOString());
  store.write(db);
  return db;
}

module.exports = { Store, importJsonOnce };
