import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const migrationsDir = new URL('./migrations/', import.meta.url);

export function getDb(dataDir) {
  if (dataDir !== ':memory:') fs.mkdirSync(dataDir, { recursive: true });
  const db = dataDir === ':memory:'
    ? new Database(':memory:')
    : new Database(path.join(dataDir, 'app.sqlite'));
  db.pragma('foreign_keys = ON');
  return db;
}

function migrationFiles() {
  return fs.readdirSync(migrationsDir)
    .filter(file => /^\d+_.+\.sql$/.test(file))
    .sort();
}

export function initializeDatabase(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const hasLegacySchema = db.prepare("select 1 from sqlite_master where type='table' and name='studio'").get();
  if (hasLegacySchema && !db.prepare("select 1 from schema_migrations where version='001'").get()) {
    db.prepare("insert into schema_migrations(version, applied_at) values ('001', ?)").run(new Date().toISOString());
  }

  for (const file of migrationFiles()) {
    const version = file.slice(0, 3);
    if (db.prepare('select 1 from schema_migrations where version=?').get(version)) continue;
    const sql = fs.readFileSync(new URL(file, migrationsDir), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('insert into schema_migrations(version, applied_at) values (?, ?)').run(version, new Date().toISOString());
    });
    apply();
  }

  backfillCustomers(db);
  return db;
}

function backfillCustomers(db) {
  if (!db.prepare("select 1 from sqlite_master where type='table' and name='customer'").get()) return;
  const selectors = db.prepare('select * from selector where customer_id is null').all();
  if (!selectors.length) return;
  const now = new Date().toISOString();
  const insert = db.prepare('insert or ignore into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)');
  const lookup = db.prepare('select id from customer where phone=?');
  const update = db.prepare('update selector set customer_id=? where id=?');
  const fill = db.transaction(() => {
    for (const selector of selectors) {
      const job = db.prepare('select studio_id from job where id=?').get(selector.job_id);
      if (!job) continue;
      insert.run(job.studio_id, selector.name, selector.phone, bcrypt.hashSync(process.env.INITIAL_CUSTOMER_PASSWORD || crypto.randomBytes(18).toString('base64url'), 10), 1, now, now);
      update.run(lookup.get(selector.phone).id, selector.id);
    }
  });
  fill();
}
