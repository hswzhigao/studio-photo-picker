import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { getDb, initializeDatabase, backfillCustomers } from '../src/db/connection.js';

const cookie = response => response.headers['set-cookie']?.[0]?.split(';')[0];
async function login(app, phone, password) { return cookie(await request(app).post('/api/admin/login').send({ phone, password })); }

function setup() {
  const db = getDb(':memory:');
  initializeDatabase(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-v5-'));
  for (const dir of ['uploads', 'thumbnails', 'previews', 'zips', 'backups']) fs.mkdirSync(path.join(root, dir));
  const s1 = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S1','W','SMS')").run().lastInsertRowid;
  const s2 = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S2','W','SMS')").run().lastInsertRowid;
  const admin = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(s1, 'Admin', '13800000101', 'admin', bcrypt.hashSync('admin-pass', 10)).lastInsertRowid;
  const editor = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(s1, 'Editor', '13800000102', 'editor', bcrypt.hashSync('editor-pass', 10)).lastInsertRowid;
  const foreign = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(s2, 'Foreign', '13800000103', 'admin', bcrypt.hashSync('foreign-pass', 10)).lastInsertRowid;
  const customer = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,0,?,?)').run(s1, '客户', '13900000101', bcrypt.hashSync('customer-pass', 10), new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
  const job = db.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by) values (?,?,?,?,?,?)").run(s1, 'J1', 'draft', new Date(Date.now() + 86400000).toISOString(), 'j1', admin).lastInsertRowid;
  const template = db.prepare('insert into package_template(studio_id,name) values (?,?)').run(s1, 'Own').lastInsertRowid;
  const foreignTemplate = db.prepare('insert into package_template(studio_id,name) values (?,?)').run(s2, 'Foreign').lastInsertRowid;
  const app = createApp({ db, cfg: { studioName: 'S1', dataDir: root, photoSourceDir: root, watermarkText: 'W' } });
  return { db, root, s1, s2, admin, editor, foreign, customer, job, template, foreignTemplate, app };
}

describe('v5 B hardening', () => {
  let c, adminCookie;
  beforeEach(async () => { c = setup(); adminCookie = await login(c.app, '13800000101', 'admin-pass'); });
  afterEach(() => { if (!c) return; c.app.locals.stopBackgroundTasks?.(); c.db.close(); fs.rmSync(c.root, { recursive: true, force: true }); });

  it('rejects foreign templates and invalid role/status values', async () => {
    const foreignTemplate = await request(c.app).post('/api/admin/jobs').set('Cookie', adminCookie).send({ title: '跨影楼模板', template_id: c.foreignTemplate });
    expect(foreignTemplate.status).toBe(404);
    const ownTemplate = await request(c.app).post('/api/admin/jobs').set('Cookie', adminCookie).send({ title: '自有模板', template_id: c.template });
    expect(ownTemplate.status).toBe(201);
    expect((await request(c.app).post('/api/admin/staff').set('Cookie', adminCookie).send({ name: 'Bad', phone: '13800000104', role: 'owner' })).status).toBe(400);
    expect((await request(c.app).patch(`/api/admin/staff/${c.editor}`).set('Cookie', adminCookie).send({ status: 'banned' })).status).toBe(400);
    expect((await request(c.app).patch(`/api/admin/customers/${c.customer}`).set('Cookie', adminCookie).send({ status: 'banned' })).status).toBe(400);
  });

  it('protects the current and last admin from disable/demotion', async () => {
    expect((await request(c.app).patch(`/api/admin/staff/${c.admin}`).set('Cookie', adminCookie).send({ status: 'disabled' })).status).toBe(400);
    expect((await request(c.app).patch(`/api/admin/staff/${c.admin}`).set('Cookie', adminCookie).send({ role: 'editor' })).status).toBe(400);
  });

  it('invalidates customer sessions when disabled', async () => {
    const clientCookie = cookie(await request(c.app).post('/api/auth/login').send({ phone: '13900000101', password: 'customer-pass' }));
    expect((await request(c.app).get('/api/client/jobs').set('Cookie', clientCookie)).status).toBe(200);
    expect((await request(c.app).patch(`/api/admin/customers/${c.customer}`).set('Cookie', adminCookie).send({ status: 'disabled' })).status).toBe(200);
    expect((await request(c.app).get('/api/client/jobs').set('Cookie', clientCookie)).status).toBe(401);
  });

  it('rolls back business writes and events when audit insertion fails', async () => {
    c.db.exec('drop table audit_log');
    const response = await request(c.app).patch(`/api/admin/jobs/${c.job}/publish`).set('Cookie', adminCookie);
    expect(response.status).toBe(500);
    expect(c.db.prepare('select status from job where id=?').get(c.job).status).toBe('draft');
    expect(c.db.prepare('select count(*) count from change_event where job_id=?').get(c.job).count).toBe(0);
    expect(c.db.prepare('select count(*) count from notification where job_id=?').get(c.job).count).toBe(0);
  });

  it('backfills customers by studio and phone', async () => {
    const db = getDb(':memory:');
    initializeDatabase(db);
    const s1 = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('A','W','S')").run().lastInsertRowid;
    const s2 = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('B','W','S')").run().lastInsertRowid;
    const staff = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(s1, 'A', '13800000201', 'admin', 'hash').lastInsertRowid;
    const j1 = db.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by) values (?,?,?,?,?,?)").run(s1, 'J1', 'selecting', new Date().toISOString(), 'j1', staff).lastInsertRowid;
    const j2 = db.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by) values (?,?,?,?,?,?)").run(s2, 'J2', 'selecting', new Date().toISOString(), 'j2', staff).lastInsertRowid;
    const c1 = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,0,?,?)').run(s1, 'Same', '13900000201', 'hash', new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
    const sel1 = db.prepare('insert into selector(job_id,name,phone,permission) values (?,?,?,?)').run(j1, 'Same', '13900000201', 'select_submit').lastInsertRowid;
    const sel2 = db.prepare('insert into selector(job_id,name,phone,permission) values (?,?,?,?)').run(j2, 'Same', '13900000201', 'select_submit').lastInsertRowid;
    backfillCustomers(db);
    expect(db.prepare('select customer_id from selector where id=?').get(sel1).customer_id).toBe(c1);
    const linked2 = db.prepare('select c.studio_id from selector s join customer c on c.id=s.customer_id where s.id=?').get(sel2);
    expect(linked2.studio_id).toBe(s2);
    db.close();
  });
});
