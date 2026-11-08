import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { backupDatabase, verifySqlite, restoreDatabase, pruneBackups } from '../src/services/backup.js';
import { scheduleDailyBackup } from '../src/services/dailyBackup.js';

describe('A1 command subsystem', () => {
  it('backs up the database and uploads without changing the source', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-a1-'));
    const db = new Database(path.join(dataDir, 'app.sqlite'));
    db.exec('create table marker(value text); insert into marker values (\'ok\')');
    db.close();
    fs.mkdirSync(path.join(dataDir, 'uploads', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'uploads', 'nested', 'photo.txt'), 'photo');

    const result = await backupDatabase(dataDir);

    expect(fs.existsSync(result.databasePath)).toBe(true);
    expect(fs.readFileSync(path.join(result.uploadsPath, 'nested', 'photo.txt'), 'utf8')).toBe('photo');
    expect(verifySqlite(result.databasePath)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'app.sqlite'))).toBe(true);
  });

  it('uses per-backup upload snapshots and validates backup retention inputs', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-a1-'));
    const db = new Database(path.join(dataDir, 'app.sqlite'));
    db.exec('create table marker(value text); insert into marker values (\'ok\')');
    db.close();
    fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'uploads', 'photo.txt'), 'v1');
    const first = await backupDatabase(dataDir, { kind: 'daily' });
    fs.writeFileSync(path.join(dataDir, 'uploads', 'photo.txt'), 'v2');
    const second = await backupDatabase(dataDir, { kind: 'daily' });
    expect(first.uploadsPath).not.toBe(second.uploadsPath);
    expect(fs.readFileSync(path.join(first.uploadsPath, 'photo.txt'), 'utf8')).toBe('v1');
    expect(fs.readFileSync(path.join(second.uploadsPath, 'photo.txt'), 'utf8')).toBe('v2');
    await expect(backupDatabase(dataDir, { kind: '../escape' })).rejects.toThrow(/kind/i);
    expect(() => pruneBackups(dataDir, 'daily', -1)).toThrow(/keep/i);
    pruneBackups(dataDir, 'daily', 1);
    expect(fs.readdirSync(path.join(dataDir, 'backups')).filter(name => name.startsWith('app-daily-') && name.endsWith('.sqlite'))).toHaveLength(1);
  });

  it('schedules a daily backup at the injected next 3am time and keeps 14 daily files', async () => {
    const calls = [];
    const timers = [];
    const timerApi = {
      setTimeout(fn, delay) { timers.push({ type: 'timeout', fn, delay }); return timers.length; },
      setInterval(fn, delay) { timers.push({ type: 'interval', fn, delay }); return timers.length; },
      clearTimeout() {},
      clearInterval() {},
    };
    const stop = scheduleDailyBackup({ now: () => new Date('2026-11-08T02:59:00+08:00'), backup: async options => calls.push(options), prune: (kind, keep) => calls.push({ kind, keep }), timerApi });
    expect(timers[0].delay).toBe(60 * 1000);
    await timers[0].fn();
    expect(calls).toEqual([{ kind: 'daily' }, { kind: 'daily', keep: 14 }]);
    expect(timers[1]).toMatchObject({ type: 'interval', delay: 24 * 60 * 60 * 1000 });
    stop();
  });

  it('restores the upload snapshot paired with a database backup', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-a1-'));
    const dbPath = path.join(dataDir, 'app.sqlite');
    const db = new Database(dbPath);
    db.exec('create table marker(value text); insert into marker values (\'old\')');
    db.close();
    fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'uploads', 'photo.txt'), 'old-upload');
    const backup = await backupDatabase(dataDir, { kind: 'daily' });
    const current = new Database(dbPath);
    current.prepare('update marker set value=\'current\'').run();
    current.close();
    fs.writeFileSync(path.join(dataDir, 'uploads', 'photo.txt'), 'current-upload');

    const stats = await restoreDatabase(dataDir, backup.databasePath);

    expect(stats).toEqual({ orders: 0, selectors: 0, selections: 0 });
    expect(new Database(dbPath).prepare('select value from marker').get().value).toBe('old');
    expect(fs.readFileSync(path.join(dataDir, 'uploads', 'photo.txt'), 'utf8')).toBe('old-upload');
  });

  it('rejects an invalid restore file before touching the current database', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-a1-'));
    const dbPath = path.join(dataDir, 'app.sqlite');
    const db = new Database(dbPath);
    db.exec('create table marker(value text); insert into marker values (\'current\')');
    db.close();
    const invalid = path.join(dataDir, 'not-sqlite');
    fs.writeFileSync(invalid, 'not sqlite');

    await expect(restoreDatabase(dataDir, invalid)).rejects.toThrow(/integrity|sqlite/i);
    const current = new Database(dbPath);
    expect(current.prepare('select value from marker').get().value).toBe('current');
    current.close();
  });
});
