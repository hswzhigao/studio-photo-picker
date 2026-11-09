import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { getDb, initializeDatabase } from '../src/db/connection.js';
import { seedDatabase } from '../src/db/seed.js';

let app;
let token;
let adminToken;
let db;
const sourceFile = path.join(os.tmpdir(), 'demo.png');
beforeAll(async () => {
  db = getDb(':memory:');
  initializeDatabase(db);
  fs.writeFileSync(sourceFile, Buffer.from('demo-original'));
  const demoPassword = 'integration-fixture-password';
  const jobId = seedDatabase(db, { studioName: '名人婚纱', watermarkText: '名人婚纱 · 预览', overageUnitPrice: 20, photoSourceDir: '.', dataDir: './data', initialStaffPassword: demoPassword, initialCustomerPassword: '12345678' });
  app = createApp({ db, cfg: { studioName: '名人婚纱', dataDir: os.tmpdir(), photoSourceDir: os.tmpdir(), watermarkText: '名人婚纱 · 预览', devOtp: '123456' } });
  db.prepare('insert into photo(job_id,filename,original_key,thumb_key,preview_key,import_status,sort) values(?,?,?,?,?,?,?)').run(jobId, 'demo.png', sourceFile, '/tmp/thumb.webp', '/tmp/preview.webp', 'ready', 0);
  const selectorId = db.prepare('select id from selector where job_id=? and customer_id=(select id from customer where phone=?)').get(jobId, '13900000001').id;
  db.prepare('insert into selection(selector_id,photo_id,created_at) values(?,?,?)').run(selectorId, 1, new Date().toISOString());
  const job = db.prepare('select invite_token from job where id=?').get(jobId);
  const login = await request(app).post('/api/auth/login').send({ phone: '13900000001', password: '12345678' });
  const firstCookie = login.headers['set-cookie']?.[0]?.split(';')[0];
  const changed = await request(app).post('/api/auth/change-password').set('Cookie', firstCookie).send({ current_password: '12345678', new_password: 'integration-client-password' });
  const relogin = await request(app).post('/api/auth/login').send({ phone: '13900000001', password: 'integration-client-password' });
  token = relogin.headers['set-cookie']?.[0]?.split(';')[0];
  const admin = await request(app).post('/api/admin/login').send({ phone: '13800000000', password: demoPassword });
  const adminCookie = admin.headers['set-cookie']?.[0]?.split(';')[0];
  await request(app).post('/api/admin/change-password').set('Cookie', adminCookie).send({ current_password: demoPassword, new_password: 'integration-admin-password' });
  const adminRelogin = await request(app).post('/api/admin/login').send({ phone: '13800000000', password: 'integration-admin-password' });
  adminToken = adminRelogin.headers['set-cookie']?.[0]?.split(';')[0];
});

describe('client integration contract', () => {
  it('returns the job and photo payload for a logged-in selector', async () => {
    const response = await request(app).get('/api/client/jobs/1').set('Cookie', token);
    expect(response.status).toBe(200);
    expect(response.body.photos).toBeInstanceOf(Array);
    expect(response.body.photos[0]).toHaveProperty('thumb_url');
    expect(response.body.photos[0]).toHaveProperty('selected');
    expect(response.body.quota).toHaveProperty('retouch');
  });

  it('allows staff summary and protects original downloads until lock', async () => {
    db.prepare("update job set status='selecting' where id=1").run();
    const summary = await request(app).get('/api/admin/jobs/1/summary').set('Cookie', adminToken);
    expect(summary.status).toBe(200);
    const before = await request(app).get('/api/client/jobs/1/photos/1/original').set('Cookie', token);
    expect(before.status).toBe(409);
    const lock = await request(app).post('/api/admin/jobs/1/lock').set('Cookie', adminToken);
    expect(lock.status).toBe(200);
    const original = await request(app).get('/api/client/jobs/1/photos/1/original').set('Cookie', token);
    expect(original.status).toBe(200);
    expect(original.body.toString()).toBe('demo-original');
    const zip = await request(app).post('/api/client/jobs/1/packages').set('Cookie', token).send({ scope: 'selected_original' });
    expect(zip.status).toBe(202);
    let packageStatus;
    for (let i = 0; i < 100; i += 1) {
      packageStatus = await request(app).get(`/api/client/jobs/1/packages/${zip.body.package.id}`).set('Cookie', token);
      if (packageStatus.body.package.status === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(packageStatus.body.package.status).toBe('ready');
    expect(packageStatus.body.package.file_url).toMatch(/^\/api\/client\/jobs\/1\/packages\/\d+\/file$/);
    const lockedSelection = await request(app).patch('/api/client/jobs/1/photos/1/selection').set('Cookie', token).send({ selected: true });
    expect(lockedSelection.status).toBe(409);
  });
});
