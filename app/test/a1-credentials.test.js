import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcryptjs';
import { getDb, initializeDatabase } from '../src/db/connection.js';

describe('A1 reset-password command', () => {
  it('resets a staff or customer by phone and returns a usable one-time password', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-credentials-'));
    const db = getDb(dataDir);
    initializeDatabase(db);
    const studio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S','W','S')").run().lastInsertRowid;
    const staff = db.prepare("insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)").run(studio, 'Admin', '13800000041', 'admin', bcrypt.hashSync('old-pass-123', 10)).lastInsertRowid;
    const now = new Date().toISOString();
    const customer = db.prepare("insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)").run(studio, 'Client', '13900000041', bcrypt.hashSync('old-pass-123', 10), 0, now, now).lastInsertRowid;
    db.close();

    const result = spawnSync(process.execPath, ['scripts/reset-password.js', '13800000041'], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const newPassword = result.stdout.trim();
    expect(newPassword).toMatch(/^[A-HJ-NP-Za-km-z23456789]{12,}$/);
    const reopened = getDb(dataDir);
    expect(bcrypt.compareSync(newPassword, reopened.prepare('select password_hash from staff where id=?').get(staff).password_hash)).toBe(true);
    expect(reopened.prepare('select must_change_password from staff where id=?').get(staff).must_change_password).toBe(1);
    reopened.close();

    const customerResult = spawnSync(process.execPath, ['scripts/reset-password.js', '13900000041'], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });
    expect(customerResult.status).toBe(0);
    const customerPassword = customerResult.stdout.trim();
    expect(customerPassword).toMatch(/^[A-HJ-NP-Za-km-z23456789]{12,}$/);
    const finalDb = getDb(dataDir);
    expect(bcrypt.compareSync(customerPassword, finalDb.prepare('select password_hash from customer where id=?').get(customer).password_hash)).toBe(true);
    finalDb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
