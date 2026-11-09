import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDb, initializeDatabase } from '../src/db/connection.js';

describe('database migrations', () => {
  it('uses a real in-memory database for :memory:', () => {
    const db = getDb(':memory:');
    initializeDatabase(db);

    expect(db.name).toBe(':memory:');
    expect(fs.existsSync(path.join(process.cwd(), ':memory:', 'app.sqlite'))).toBe(false);
    expect(db.prepare("select name from sqlite_master where type='table' and name='schema_migrations'").get()).toEqual({ name: 'schema_migrations' });
    expect(db.prepare('select version from schema_migrations order by version').all().map(row => row.version)).toEqual(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']);
  });

  it('creates the parent directory before opening a file database', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-db-parent-'));
    const dir = path.join(parent, 'nested');
    const db = getDb(dir);
    expect(fs.existsSync(path.join(dir, 'app.sqlite'))).toBe(true);
    db.close();
  });

  it('applies migrations to a fresh file database and is idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-db-'));
    const db = getDb(dir);
    initializeDatabase(db);
    initializeDatabase(db);

    expect(db.prepare('select count(*) as count from schema_migrations').get().count).toBe(10);
    expect(db.prepare('pragma table_info(customer)').all().some(column => column.name === 'password_hash')).toBe(true);
    expect(db.prepare('pragma table_info(job)').all().some(column => column.name === 'original_download_scope')).toBe(true);
  });

  it('marks the existing schema as 001 before applying later migrations and backfills customers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-db-'));
    const db = new Database(path.join(dir, 'app.sqlite'));
    db.exec(fs.readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
    const studio = db.prepare("insert into studio(name, watermark_text, sms_sign) values ('S', 'W', 'SMS')").run().lastInsertRowid;
    const staff = db.prepare("insert into staff(studio_id,name,phone,role,password_hash) values (?,?,?,?,?)").run(studio, 'Admin', '13800000000', 'admin', 'hash').lastInsertRowid;
    const job = db.prepare("insert into job(studio_id,title,deadline_at,invite_token,created_by) values (?,?,?,?,?)").run(studio, 'J', new Date().toISOString(), 'token', staff).lastInsertRowid;
    db.prepare("insert into selector(job_id,name,phone,permission,share_selection,can_change_share) values (?,?,?,?,?,?)").run(job, 'Client', '13900000001', 'select_submit', 1, 1);
    db.close();

    const migrated = getDb(dir);
    initializeDatabase(migrated);
    expect(migrated.prepare('select version from schema_migrations order by version').all().map(row => row.version)).toEqual(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']);
    const customer = migrated.prepare('select phone, must_change_password from customer where phone=?').get('13900000001');
    expect(customer).toEqual({ phone: '13900000001', must_change_password: 1 });
    expect(migrated.prepare('select customer_id from selector where phone=?').get('13900000001').customer_id).toBe(1);
  });
});
