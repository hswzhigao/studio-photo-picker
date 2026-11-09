import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { getDb, initializeDatabase } from '../src/db/connection.js';

function setup() {
  const db = getDb(':memory:'); initializeDatabase(db); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-')); fs.mkdirSync(path.join(root, 'thumbnails')); fs.mkdirSync(path.join(root, 'previews')); fs.mkdirSync(path.join(root, 'zips'));
  const original = path.join(root, 'original.jpg'); fs.writeFileSync(original, 'original'); // Media files are written after the photo id is known below.
  const now = new Date().toISOString(); const studio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S','W','SMS')").run().lastInsertRowid;
  const staff = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(studio, 'Staff', '13800000001', 'admin', bcrypt.hashSync('staff-pass', 10)).lastInsertRowid;
  const customer = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)').run(studio, 'One', '13900000001', bcrypt.hashSync('client-pass', 10), 0, now, now).lastInsertRowid;
  const job = db.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by,original_download_scope) values (?,?,?,?,?,?,?)").run(studio, 'J1', 'selecting', now, 'j1', staff, 'selected').lastInsertRowid;
  const selector = db.prepare('insert into selector(job_id,customer_id,name,phone,permission) values (?,?,?,?,?)').run(job, customer, 'One', '13900000001', 'select_submit').lastInsertRowid;
  const photo = db.prepare("insert into photo(job_id,filename,original_key,import_status,hidden) values (?,?,?,'ready',0)").run(job, 'a.jpg', original).lastInsertRowid;
  fs.writeFileSync(path.join(root, 'thumbnails', `${photo}.webp`), 'thumb'); fs.writeFileSync(path.join(root, 'previews', `${photo}.webp`), 'preview');
  return { db, root, app: createApp({ db, cfg: { studioName: 'S', dataDir: root, photoSourceDir: root, watermarkText: 'W' } }), job, selector, customer, photo };
}
const cookie = r => r.headers['set-cookie']?.[0]?.split(';')[0];
async function login(app, phone = '13900000001') { return cookie(await request(app).post('/api/auth/login').send({ phone, password: 'client-pass' })); }
async function waitReadyPackage(app, jobId, packageId, token) {
  for (let i = 0; i < 100; i += 1) {
    const response = await request(app).get(`/api/client/jobs/${jobId}/packages/${packageId}`).set('Cookie', token);
    if (response.body.package.status === 'ready') return response.body.package;
    if (response.body.package.status === 'failed') throw new Error('package failed');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('package timeout');
}

describe('phase 5 selected downloads and media authorization', () => {
  let ctx, token;
  beforeEach(async () => { ctx = setup(); token = await login(ctx.app); });
  afterEach(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  it('requires login and order participation for private media', async () => {
    expect((await request(ctx.app).get(`/media/previews/${ctx.photo}`)).status).toBe(401);
    expect((await request(ctx.app).get(`/media/previews/${ctx.photo}.webp`)).status).toBe(401);
    expect((await request(ctx.app).get(`/media/previews/${ctx.photo}`).set('Cookie', token)).status).toBe(200);
    expect((await request(ctx.app).get(`/media/previews/${ctx.photo}.webp`).set('Cookie', token)).status).toBe(200);
  });

  it('does not allow an unselected original after the job is locked', async () => {
    ctx.db.prepare("update job set status='locked' where id=?").run(ctx.job);
    const response = await request(ctx.app).get(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/original`).set('Cookie', token);
    expect(response.status).toBe(403);
  });

  it('hides a photo from client media after it is marked hidden', async () => {
    ctx.db.prepare('update photo set hidden=1 where id=?').run(ctx.photo);
    const response = await request(ctx.app).get(`/media/previews/${ctx.photo}`).set('Cookie', token);
    expect(response.status).toBe(404);
  });

  it('makes the selected scope package fail when original scope is selected and all_original is requested', async () => {
    ctx.db.prepare("update job set status='locked',allow_original_download=1,original_download_scope='selected' where id=?").run(ctx.job);
    const response = await request(ctx.app).post(`/api/client/jobs/${ctx.job}/packages`).set('Cookie', token).send({ scope: 'all_original' });
    expect(response.status).toBe(403);
  });

  it('creates and downloads a selected original package with RFC 5987 filename', async () => {
    await request(ctx.app).patch(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/selection`).set('Cookie', token).send({ selected: true });
    ctx.db.prepare("update job set status='locked',allow_original_download=1,original_download_scope='selected' where id=?").run(ctx.job);
    const created = await request(ctx.app).post(`/api/client/jobs/${ctx.job}/packages`).set('Cookie', token).send({ scope: 'selected_original' });
    expect(created.status).toBe(202);
    const ready = await waitReadyPackage(ctx.app, ctx.job, created.body.package.id, token);
    expect(ready.file_url).toMatch(/\/packages\/\d+\/file$/);
    const file = await request(ctx.app).get(ready.file_url).set('Cookie', token);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toContain('filename*=UTF-8');
    expect(file.headers['content-disposition']).toContain('%E5%90%8D%E4%BA%BA%E5%A9%9A%E7%BA%B1');
  });

  it('rejects a symlink that resolves outside the configured photo root', async () => {
    const outside = path.join(os.tmpdir(), `phase5-outside-${Date.now()}.jpg`);
    fs.writeFileSync(outside, 'outside');
    const linked = path.join(ctx.root, 'linked.jpg');
    fs.symlinkSync(outside, linked);
    ctx.db.prepare('update photo set original_key=? where id=?').run(linked, ctx.photo);
    ctx.db.prepare('insert into selection(selector_id,photo_id,created_at) values(?,?,?)').run(ctx.selector, ctx.photo, new Date().toISOString());
    ctx.db.prepare("update job set status='locked' where id=?").run(ctx.job);
    const response = await request(ctx.app).get(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/original`).set('Cookie', token);
    fs.rmSync(outside, { force: true });
    expect(response.status).toBe(404);
  });
  it('returns selected result and creates an asynchronous preview package', async () => {
    await request(ctx.app).patch(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/selection`).set('Cookie', token).send({ selected: true });
    const selected = await request(ctx.app).get(`/api/client/jobs/${ctx.job}/selected?tab=mine`).set('Cookie', token);
    expect(selected.status).toBe(200); expect(selected.body.photos).toHaveLength(1); expect(selected.body.photos[0].preview_url).toContain('/media/previews/');
    const created = await request(ctx.app).post(`/api/client/jobs/${ctx.job}/packages`).set('Cookie', token).send({ scope: 'selected_preview' });
    expect(created.status).toBe(202); expect(created.body.package.status).toBe('pending');
    expect(created.body.package.file_key).toBeUndefined();
    const status = await request(ctx.app).get(`/api/client/jobs/${ctx.job}/packages/${created.body.package.id}`).set('Cookie', token);
    expect(status.status).toBe(200); expect(['pending', 'processing', 'ready']).toContain(status.body.package.status);
    expect(status.body.package.file_key).toBeUndefined();
  });
  it('fails closed for unknown original download scope', async () => {
    ctx.db.prepare("update job set status='locked',allow_original_download=1,original_download_scope='mystery' where id=?").run(ctx.job);
    expect((await request(ctx.app).get(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/original`).set('Cookie', token)).status).toBe(403);
    expect((await request(ctx.app).post(`/api/client/jobs/${ctx.job}/packages`).set('Cookie', token).send({ scope: 'all_original' })).status).toBe(403);
  });

  it('does not allow another selector to download a package', async () => {
    await request(ctx.app).patch(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/selection`).set('Cookie', token).send({ selected: true });
    ctx.db.prepare("update job set status='locked',allow_original_download=1,original_download_scope='selected' where id=?").run(ctx.job);
    const created = await request(ctx.app).post(`/api/client/jobs/${ctx.job}/packages`).set('Cookie', token).send({ scope: 'selected_original' });
    expect(created.status).toBe(202);
    const ready = await waitReadyPackage(ctx.app, ctx.job, created.body.package.id, token);
    const otherCustomer = ctx.db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values(?,?,?,?,?,?,?)').run(ctx.db.prepare('select studio_id from job where id=?').get(ctx.job).studio_id, 'Other', '13900000002', bcrypt.hashSync('client-pass', 10), 0, new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
    ctx.db.prepare('insert into selector(job_id,customer_id,name,phone,permission) values(?,?,?,?,?)').run(ctx.job, otherCustomer, 'Other', '13900000002', 'select_submit');
    const otherToken = await login(ctx.app, '13900000002');
    expect((await request(ctx.app).get(ready.file_url).set('Cookie', otherToken)).status).toBe(404);
  });

  it('does not expose an unselected original before lock and rejects unsafe original paths', async () => {
    expect((await request(ctx.app).get(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/original`).set('Cookie', token)).status).toBe(409);
    ctx.db.prepare("update photo set original_key=? where id=?").run('/etc/passwd', ctx.photo); ctx.db.prepare("update job set status='locked' where id=?").run(ctx.job);
    expect([403, 404]).toContain((await request(ctx.app).get(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/original`).set('Cookie', token)).status);
  });
  it('removes expired package rows and files during startup cleanup', async () => {
    const expired=path.join(ctx.root,'zips','expired.zip'); fs.writeFileSync(expired,'expired');
    ctx.db.prepare("insert into download_package(job_id,kind,status,file_key,expires_at,selector_id,scope,progress,total,created_at) values(?,?,?,?,?,?,?,?,?,?)").run(ctx.job,'client','ready',expired,new Date(Date.now()-1000).toISOString(),ctx.selector,'selected_original',1,1,new Date().toISOString());
    createApp({ db: ctx.db, cfg: { studioName: 'S', dataDir: ctx.root, photoSourceDir: ctx.root, watermarkText: 'W' } });
    expect(fs.existsSync(expired)).toBe(false); expect(ctx.db.prepare('select count(*) count from download_package').get().count).toBe(0);
  });
});
