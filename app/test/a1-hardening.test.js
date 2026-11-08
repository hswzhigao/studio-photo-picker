import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { getDb, initializeDatabase } from '../src/db/connection.js';
import { config, ensureDirs } from '../src/config.js';

const password = 'a1-test-password';
const cookie = response => response.headers['set-cookie']?.[0]?.split(';')[0];

function setup() {
  const db = getDb(':memory:');
  initializeDatabase(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-hardening-'));
  fs.mkdirSync(path.join(root, 'thumbnails'));
  fs.mkdirSync(path.join(root, 'previews'));
  const now = new Date().toISOString();
  const studio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S','W','SMS')").run().lastInsertRowid;
  const otherStudio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('Other','W','SMS')").run().lastInsertRowid;
  const admin = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(studio, 'Admin', '13800000021', 'admin', bcrypt.hashSync(password, 10)).lastInsertRowid;
  const editor = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(studio, 'Editor', '13800000022', 'editor', bcrypt.hashSync(password, 10)).lastInsertRowid;
  const foreign = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(otherStudio, 'Foreign', '13800000023', 'editor', bcrypt.hashSync(password, 10)).lastInsertRowid;
  const customer = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)').run(studio, 'Client', '13900000021', bcrypt.hashSync(password, 10), 0, now, now).lastInsertRowid;
  const job = db.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by) values (?,?,?,?,?,?)").run(studio, 'J', 'selecting', now, 'invite', admin).lastInsertRowid;
  const selector = db.prepare('insert into selector(job_id,customer_id,name,phone,permission) values (?,?,?,?,?)').run(job, customer, 'Client', '13900000021', 'select_submit').lastInsertRowid;
  const photo = db.prepare('insert into photo(job_id,filename,original_key,thumb_key,preview_key,import_status,hidden) values(?,?,?,?,?,?,0)').run(job, 'one.jpg', path.join(root, 'one.jpg'), `${1}.webp`, `${1}.webp`, 'ready').lastInsertRowid;
  fs.writeFileSync(path.join(root, 'thumbnails', `${photo}.webp`), 'thumb');
  fs.writeFileSync(path.join(root, 'previews', `${photo}.webp`), 'preview');
  const app = createApp({ db, cfg: { studioName: 'S', dataDir: root, photoSourceDir: root, watermarkText: 'W' } });
  return { db, root, app, admin, editor, foreign, customer, job, selector, photo };
}

async function loginStaff(app, phone) {
  return cookie(await request(app).post('/api/admin/login').send({ phone, password }));
}

describe('A1 authentication and persistence hardening', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.db.close(); fs.rmSync(ctx.root, { recursive: true, force: true }); });

  it('returns only a safe actor whitelist from /api/auth/me', async () => {
    const session = cookie(await request(ctx.app).post('/api/auth/login').send({ phone: '13900000021', password }));
    const response = await request(ctx.app).get('/api/auth/me').set('Cookie', session);
    expect(response.status).toBe(200);
    expect(response.body.actor).toEqual(expect.objectContaining({ actor_type: 'customer', actor_id: ctx.customer, studio_id: 1, phone: '13900000021', name: 'Client', must_change_password: false }));
    expect(Object.keys(response.body.actor).sort()).toEqual(['actor_id', 'actor_type', 'must_change_password', 'name', 'phone', 'role', 'studio_id'].sort());
  });

  it('allows same-studio staff to read media but blocks another studio', async () => {
    const staff = await loginStaff(ctx.app, '13800000022');
    const foreign = await loginStaff(ctx.app, '13800000023');
    expect((await request(ctx.app).get(`/media/thumbs/${ctx.photo}.webp`).set('Cookie', staff)).status).toBe(200);
    expect((await request(ctx.app).get(`/media/previews/${ctx.photo}.webp`).set('Cookie', staff)).status).toBe(200);
    expect((await request(ctx.app).get(`/media/thumbs/${ctx.photo}.webp`).set('Cookie', foreign)).status).toBe(404);
  });

  it('allows an editor to manage customers in the editor studio only', async () => {
    const editor = await loginStaff(ctx.app, '13800000022');
    const created = await request(ctx.app).post('/api/admin/customers').set('Cookie', editor).send({ name: 'New Client', phone: '13900000022', password: 'HandMadePass123' });
    expect(created.status).toBe(201);
    expect(created.body.password).toBe('HandMadePass123');
    const customerId = created.body.customer.id;
    expect((await request(ctx.app).patch(`/api/admin/customers/${customerId}`).set('Cookie', editor).send({ status: 'disabled' })).status).toBe(200);
    expect((await request(ctx.app).patch(`/api/admin/customers/${customerId}`).set('Cookie', editor).send({ status: 'active' })).status).toBe(200);
    const reset = await request(ctx.app).post(`/api/admin/customers/${customerId}/reset-password`).set('Cookie', editor);
    expect(reset.status).toBe(200);
    expect((await request(ctx.app).post('/api/auth/login').send({ phone: '13900000022', password: reset.body.password })).status).toBe(200);
    expect((await request(ctx.app).get('/api/admin/staff').set('Cookie', editor)).status).toBe(403);
  });

  it('uses durable cookie settings and renews sessions nearing expiry', async () => {
    const login = await request(ctx.app).post('/api/auth/login').send({ phone: '13900000021', password });
    expect(login.headers['set-cookie'][0]).toMatch(/Max-Age=604800/);
    const session = cookie(login);
    ctx.db.prepare("update session set expires_at=? where token=?").run(new Date(Date.now() + 2 * 86400000).toISOString(), session.split('=')[1]);
    const renewed = await request(ctx.app).get('/api/auth/me').set('Cookie', session);
    expect(renewed.headers['set-cookie']?.[0]).toMatch(/Max-Age=604800/);
    expect(new Date(ctx.db.prepare('select expires_at from session where token=?').get(session.split('=')[1]).expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
  });

  it('configures SQLite for durable concurrent writes', () => {
    const fileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-sqlite-'));
    const db = getDb(fileRoot);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(Number(db.pragma('synchronous', { simple: true }))).toBe(1);
    expect(Number(db.pragma('busy_timeout', { simple: true }))).toBe(5000);
    expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(1);
    db.close();
    fs.rmSync(fileRoot, { recursive: true, force: true });
  });

  it('uses the repository data directory by default and creates backups directory', () => {
    expect(config.dataDir).toBe(path.resolve(process.cwd(), '..', 'data'));
    const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-data-dir-'));
    ensureDirs(isolatedDataDir);
    expect(fs.existsSync(path.join(isolatedDataDir, 'backups'))).toBe(true);
    expect(fs.existsSync(path.join(config.dataDir, 'app.sqlite'))).toBe(false);
    fs.rmSync(isolatedDataDir, { recursive: true, force: true });
  });
});
