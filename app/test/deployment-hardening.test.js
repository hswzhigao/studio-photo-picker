import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { initializeDatabase } from '../src/db/connection.js';
import { seedDatabase } from '../src/db/seed.js';

function setup() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const studio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S','W','SMS')").run().lastInsertRowid;
  db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)')
    .run(studio, 'Admin', '13800000001', 'admin', bcrypt.hashSync('admin-pass', 10));
  return { db, studio };
}

describe('公网部署加固', () => {
  let db, root;
  beforeEach(() => { db = setup().db; root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-hardening-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('health includes version and database status', async () => {
    const app = createApp({ db, cfg: { studioName: 'S', version: '1.2.3', dataDir: root, photoSourceDir: root, watermarkText: 'W', loginRateLimitMax: 10, loginRateLimitWindowMs: 60_000 } });
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ ok: true, version: '1.2.3', database: 'ok' }));
  });

  it('adds security headers and trusts the configured proxy', async () => {
    const app = createApp({ db, cfg: { studioName: 'S', dataDir: root, photoSourceDir: root, watermarkText: 'W', trustProxy: 1 } });
    const response = await request(app).get('/api/health').set('X-Forwarded-Proto', 'https');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('same-origin');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain('https://fonts.googleapis.com');
    expect(response.headers['content-security-policy']).toContain('https://fonts.gstatic.com');
  });

  it('rejects the eleventh login request from one IP within the window', async () => {
    const app = createApp({ db, cfg: { studioName: 'S', dataDir: root, photoSourceDir: root, watermarkText: 'W', loginRateLimitMax: 10, loginRateLimitWindowMs: 60_000 } });
    for (let i = 0; i < 10; i += 1) {
      expect((await request(app).post('/api/auth/login').set('X-Forwarded-For', '203.0.113.10').send({ phone: '13800000001', password: 'wrong' })).status).toBe(401);
    }
    const blocked = await request(app).post('/api/auth/login').set('X-Forwarded-For', '203.0.113.10').send({ phone: '13800000001', password: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('LOGIN_RATE_LIMITED');
  });

  it('uses secure production cookies when configured', async () => {
    const app = createApp({ db, cfg: { studioName: 'S', dataDir: root, photoSourceDir: root, watermarkText: 'W', cookieSecure: true } });
    const response = await request(app).post('/api/admin/login').send({ phone: '13800000001', password: 'admin-pass' });
    expect(response.status).toBe(200);
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    expect(response.headers['set-cookie'][0]).toMatch(/Max-Age=604800/);
    expect(response.headers['set-cookie'][0]).toMatch(/SameSite=Lax/);
    expect(response.headers['set-cookie'][0]).toMatch(/Secure/);
  });

  it('accepts only image content within the upload size limit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-upload-'));
    fs.mkdirSync(path.join(root, 'uploads'));
    const seededDb = new Database(':memory:');
    initializeDatabase(seededDb);
    const studio = seededDb.prepare("insert into studio(name,watermark_text,sms_sign) values ('S','W','SMS')").run().lastInsertRowid;
    const staff = seededDb.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(studio, 'Admin', '13800000001', 'admin', bcrypt.hashSync('admin-pass', 10)).lastInsertRowid;
    const job = seededDb.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by) values (?,?,?,?,?,?)").run(studio, 'J', 'selecting', new Date().toISOString(), 'invite', staff).lastInsertRowid;
    const app = createApp({ db: seededDb, cfg: { studioName: 'S', dataDir: root, photoSourceDir: root, watermarkText: 'W', trustProxy: 1 } });
    const agent = request.agent(app);
    await agent.post('/api/admin/login').send({ phone: '13800000001', password: 'admin-pass' });
    const invalid = await agent.post(`/api/admin/jobs/${job}/photos`).attach('photo', Buffer.from('not-an-image'), 'fake.jpg');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_UPLOAD');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('production seed creates only the studio and administrator', () => {
    const productionDb = new Database(':memory:');
    initializeDatabase(productionDb);
    seedDatabase(productionDb, { studioName: 'S', watermarkText: 'W', overageUnitPrice: 20, seedDemo: false, initialStaffPassword: 'admin-pass' });
    expect(productionDb.prepare('select count(*) count from studio').get().count).toBe(1);
    expect(productionDb.prepare('select count(*) count from staff').get().count).toBe(1);
    expect(productionDb.prepare('select count(*) count from customer').get().count).toBe(0);
    expect(productionDb.prepare('select count(*) count from job').get().count).toBe(0);
  });
});
