/**
 * Hot-journal recovery on the host's read-only outbound.db path.
 *
 * A container is the sole writer of outbound.db. When the host SIGKILLs one
 * past the heartbeat ceiling, it can leave a hot rollback journal. The host
 * opens outbound.db read-only, and a read-only handle cannot perform the
 * rollback SQLite needs to read past that journal — so reads throw
 * "attempt to write a readonly database". openOutboundDbRecovered() recovers.
 */
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isReadonlyRollbackError,
  openOutboundDb,
  openOutboundDbRecovered,
  recoverOutboundHotJournal,
} from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-recover-test';
const DB_PATH = path.join(TEST_DIR, 'outbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function freshDir(): void {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

describe('isReadonlyRollbackError', () => {
  it('matches the readonly-database error message', () => {
    expect(isReadonlyRollbackError(new Error('attempt to write a readonly database'))).toBe(true);
    expect(isReadonlyRollbackError(new Error('SQLITE_READONLY: read-only'))).toBe(true);
    expect(isReadonlyRollbackError(new Error('database is locked'))).toBe(false);
    expect(isReadonlyRollbackError('something else')).toBe(false);
  });
});

describe('openOutboundDbRecovered on a clean DB', () => {
  it('returns a working read-only handle (no regression) and stays read-only', () => {
    freshDir();
    const seed = new Database(DB_PATH);
    seed.pragma('journal_mode = DELETE');
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    seed.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
    seed.close();

    const db = openOutboundDbRecovered(DB_PATH);
    try {
      expect((db.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('hello');
      // Still a read-only handle — writes must be rejected.
      expect(() => db.prepare('INSERT INTO t (v) VALUES (?)').run('nope')).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('recoverOutboundHotJournal on a clean DB', () => {
  it('is a harmless no-op (data intact, no journal created)', () => {
    freshDir();
    const seed = new Database(DB_PATH);
    seed.pragma('journal_mode = DELETE');
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    seed.prepare('INSERT INTO t (v) VALUES (?)').run('keep');
    seed.close();

    recoverOutboundHotJournal(DB_PATH);

    expect(fs.existsSync(`${DB_PATH}-journal`)).toBe(false);
    const db = openOutboundDb(DB_PATH);
    try {
      expect((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });
});

// Child that commits a baseline row, then opens an uncommitted transaction
// that spills pages to disk (cache_size=1 + bulk insert), signals READY, and
// hangs. SIGKILLing it leaves a genuine hot rollback journal.
const CHILD = `
const Database = require('better-sqlite3');
const p = process.argv[2];
const db = new Database(p);
db.pragma('journal_mode = DELETE');
db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, blob TEXT)');
db.prepare('INSERT INTO t (blob) VALUES (?)').run('baseline'); // committed (autocommit)
db.pragma('cache_size = 1'); // force dirty pages to spill into the main db file
db.exec('BEGIN IMMEDIATE');
const ins = db.prepare('INSERT INTO t (blob) VALUES (?)');
for (let i = 0; i < 3000; i++) ins.run('x'.repeat(400)); // ~1.2MB -> spills, journal holds originals
process.stdout.write('READY\\n'); // do NOT commit
setInterval(() => {}, 100000);
`;

async function fabricateHotJournal(): Promise<void> {
  const childPath = path.join(TEST_DIR, 'leave-hot-journal.cjs');
  fs.writeFileSync(childPath, CHILD);
  await new Promise<void>((resolve, reject) => {
    // The child script lives in TEST_DIR, so point module resolution at the
    // repo's node_modules (Node resolves from the script dir, not cwd).
    const child = spawn(process.execPath, [childPath, DB_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_PATH: path.join(process.cwd(), 'node_modules') },
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child never signalled READY${stderr ? `; stderr: ${stderr}` : ''}`));
    }, 10_000);
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('READY')) {
        clearTimeout(timer);
        child.kill('SIGKILL'); // crash mid-transaction
        child.on('exit', () => resolve());
      }
    });
    child.on('error', reject);
  });
}

describe('openOutboundDbRecovered with a hot journal (the bug)', () => {
  it('recovers a journal a killed writer left, where a plain read-only open fails', async () => {
    freshDir();
    await fabricateHotJournal();

    // A hot journal should remain after the SIGKILL.
    expect(fs.existsSync(`${DB_PATH}-journal`)).toBe(true);

    // Reproduce the bug: a plain read-only read can't roll it back.
    const ro = openOutboundDb(DB_PATH);
    let threw: unknown;
    try {
      ro.prepare('SELECT count(*) FROM t').get();
    } catch (err) {
      threw = err;
    } finally {
      ro.close();
    }
    expect(threw).toBeDefined();
    expect(isReadonlyRollbackError(threw)).toBe(true);

    // The fix: recovered open rolls the journal back and reads the committed
    // (pre-crash) state — only the baseline row; the uncommitted 3000 are gone.
    const db = openOutboundDbRecovered(DB_PATH);
    try {
      expect((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT blob FROM t').get() as { blob: string }).blob).toBe('baseline');
    } finally {
      db.close();
    }
    expect(fs.existsSync(`${DB_PATH}-journal`)).toBe(false);
  }, 20_000);
});
