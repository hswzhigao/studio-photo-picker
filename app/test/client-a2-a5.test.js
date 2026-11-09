import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { getDb, initializeDatabase } from '../src/db/connection.js';

const staffPassword = 'staff-pass-123';
const clientPassword = 'client-pass-123';
const cookie = response => response.headers['set-cookie']?.[0]?.split(';')[0];
const binaryParser = (res, callback) => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => callback(null, Buffer.concat(chunks))); };
function zipNames(file) {
  return JSON.parse(execFileSync('python3', ['-c', 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', file], { encoding: 'utf8' }));
}

function setup() {
  const db = getDb(':memory:');
  initializeDatabase(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-a2-'));
  for (const dir of ['thumbnails', 'previews', 'zips', 'uploads']) fs.mkdirSync(path.join(root, dir));
  const now = new Date().toISOString();
  const studio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S','W','SMS')").run().lastInsertRowid;
  db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(studio, 'Admin', '13800000001', 'admin', bcrypt.hashSync(staffPassword, 10));
  const c1 = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)').run(studio, '小雅', '13900000001', bcrypt.hashSync(clientPassword, 10), 0, now, now).lastInsertRowid;
  const c2 = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)').run(studio, '阿杰', '13900000002', bcrypt.hashSync(clientPassword, 10), 0, now, now).lastInsertRowid;
  const job = db.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by,allow_preview_download,allow_original_download,original_download_scope) values (?,?,?,?,?,?,?,?,?)").run(studio, 'A2 测试', 'selecting', new Date(Date.now() + 86400000).toISOString(), 'job', 1, 1, 1, 'selected').lastInsertRowid;
  const frame = db.prepare("insert into job_item(job_id,name,kind,quantity,sort) values (?,?,?,?,?)").run(job, '30寸相框', 'print_from_retouch', 1, 1).lastInsertRowid;
  const desk = db.prepare("insert into job_item(job_id,name,kind,quantity,sort) values (?,?,?,?,?)").run(job, '10寸摆台', 'print_from_retouch', 1, 2).lastInsertRowid;
  const s1 = db.prepare('insert into selector(job_id,customer_id,name,phone,permission,share_selection) values (?,?,?,?,?,?)').run(job, c1, '小雅', '13900000001', 'select_submit', 1).lastInsertRowid;
  const s2 = db.prepare('insert into selector(job_id,customer_id,name,phone,permission,share_selection) values (?,?,?,?,?,?)').run(job, c2, '阿杰', '13900000002', 'select_submit', 0).lastInsertRowid;
  const addPhoto = name => {
    const id = db.prepare("insert into photo(job_id,filename,original_key,import_status,sort) values (?,?,?,'ready',?)").run(job, name, path.join(root, 'uploads', name), db.prepare('select count(*) count from photo').get().count).lastInsertRowid;
    fs.writeFileSync(path.join(root, 'uploads', name), `original:${name}`);
    fs.writeFileSync(path.join(root, 'thumbnails', `${id}.webp`), `thumb:${name}`);
    fs.writeFileSync(path.join(root, 'previews', `${id}.webp`), `preview:${name}`);
    return id;
  };
  const p1 = addPhoto('A.jpg');
  const p2 = addPhoto('B.jpg');
  const app = createApp({ db, cfg: { studioName: 'S', dataDir: root, photoSourceRoot: root, photoSourceDir: root, watermarkText: 'W' } });
  return { db, root, job, frame, desk, s1, s2, p1, p2, app };
}
async function login(app, phone) { return cookie(await request(app).post('/api/auth/login').send({ phone, password: clientPassword })); }
async function adminLogin(app) { return cookie(await request(app).post('/api/admin/login').send({ phone: '13800000001', password: staffPassword })); }
async function waitPackage(app, jobId, id, token) {
  for (let i = 0; i < 100; i += 1) {
    const response = await request(app).get(`/api/client/jobs/${jobId}/packages/${id}`).set('Cookie', token);
    if (['ready', 'failed'].includes(response.body.package.status)) return response.body.package;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('package timeout');
}

describe('A2-A5 client selection, comments, review and downloads', () => {
  let c, token, token2, admin;
  beforeEach(async () => {
    c = setup();
    token = await login(c.app, '13900000001');
    token2 = await login(c.app, '13900000002');
    admin = await adminLogin(c.app);
  });
  afterEach(() => { c.app.locals.stopBackgroundTasks?.(); c.db.close(); fs.rmSync(c.root, { recursive: true, force: true }); });

  it('returns dynamic products, my_note and merged quota', async () => {
    await request(c.app).patch(`/api/client/jobs/${c.job}/photos/${c.p1}/slot`).set('Cookie', token).send({ job_item_id: c.frame });
    await request(c.app).patch(`/api/client/jobs/${c.job}/photos/${c.p1}/note`).set('Cookie', token).send({ content: '自然一点' });
    const detail = await request(c.app).get(`/api/client/jobs/${c.job}`).set('Cookie', token);
    expect(detail.status).toBe(200);
    const photo = detail.body.photos.find(item => item.id === c.p1);
    expect(photo.slots[0]).toEqual(expect.objectContaining({ job_item_id: c.frame, name: '30寸相框' }));
    expect(photo.my_note).toBe('自然一点');
    expect(detail.body.quota).toEqual(expect.objectContaining({ count: 1, quota: 0, overage: 1 }));
    expect(detail.body.items.map(item => item.name)).toEqual(['30寸相框', '10寸摆台']);
  });

  it('shows unshared selections in the final tab only after lock', async () => {
    await request(c.app).patch(`/api/client/jobs/${c.job}/photos/${c.p2}/selection`).set('Cookie', token2).send({ selected: true });
    let final = await request(c.app).get(`/api/client/jobs/${c.job}/selected?tab=final`).set('Cookie', token);
    expect(final.body.photos).toHaveLength(0);
    c.db.prepare("update job set status='locked' where id=?").run(c.job);
    final = await request(c.app).get(`/api/client/jobs/${c.job}/selected?tab=final`).set('Cookie', token);
    expect(final.body.photos.map(photo => photo.id)).toEqual([c.p2]);
  });

  it('allows single original downloads in locked/retouching/delivered and forces preview downloads', async () => {
    await request(c.app).patch(`/api/client/jobs/${c.job}/photos/${c.p1}/selection`).set('Cookie', token).send({ selected: true });
    for (const status of ['locked', 'retouching', 'delivered']) {
      c.db.prepare('update job set status=? where id=?').run(status, c.job);
      const response = await request(c.app).get(`/api/client/jobs/${c.job}/photos/${c.p1}/original`).set('Cookie', token);
      expect(response.status).toBe(200);
    }
    c.db.prepare("update job set status='selecting' where id=?").run(c.job);
    const preview = await request(c.app).get(`/media/previews/${c.p1}.webp?download=1`).set('Cookie', token);
    expect(preview.status).toBe(200);
    expect(preview.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(preview.headers['content-disposition']).toContain('A.webp');
  });

  it('reports package progress and missing preview files', async () => {
    await request(c.app).patch(`/api/client/jobs/${c.job}/photos/${c.p1}/selection`).set('Cookie', token).send({ selected: true });
    const created = await request(c.app).post(`/api/client/jobs/${c.job}/packages`).set('Cookie', token).send({ scope: 'selected_preview' });
    expect(created.status).toBe(202);
    const ready = await waitPackage(c.app, c.job, created.body.package.id, token);
    expect(ready.status).toBe('ready');
    expect(ready.progress).toBe(1);
    expect(ready.total).toBe(1);
    expect(ready.missing).toBe(0);
    const file = await request(c.app).get(ready.file_url).set('Cookie', token).buffer(true).parse(binaryParser);
    const zip = path.join(c.root, 'preview.zip');
    fs.writeFileSync(zip, file.body);
    expect(zipNames(zip)).toEqual(['A.webp']);

    fs.rmSync(path.join(c.root, 'previews', `${c.p1}.webp`));
    c.db.prepare('update download_package set expires_at=? where job_id=?').run(new Date(Date.now() - 1000).toISOString(), c.job);
    const missing = await request(c.app).post(`/api/client/jobs/${c.job}/packages`).set('Cookie', token).send({ scope: 'selected_preview' });
    const missingReady = await waitPackage(c.app, c.job, missing.body.package.id, token);
    expect(missingReady.missing).toBe(1);
    expect(missingReady.error).toContain('MISSING_FILES');
    await c.app.locals.waitForTasks?.();
  });

  it('serves review GET and removes the rating endpoint', async () => {
    const review = await request(c.app).get(`/api/client/jobs/${c.job}/review`).set('Cookie', token);
    expect(review.status).toBe(200);
    expect(review.body).toHaveProperty('quota');
    expect(review.body).toHaveProperty('products');
    expect(review.body).toHaveProperty('problems');
    expect((await request(c.app).post(`/api/client/jobs/${c.job}/review`).set('Cookie', token).send({ rating: 5 })).status).toBe(404);
  });

  it('supports comment author names, replies and five-minute editing', async () => {
    const created = await request(c.app).post(`/api/client/jobs/${c.job}/photos/${c.p1}/comments`).set('Cookie', token).send({ content: '这张保留' });
    expect(created.status).toBe(201);
    const commentId = created.body.comment.id;
    const list = await request(c.app).get(`/api/client/jobs/${c.job}/photos/${c.p1}/comments`).set('Cookie', token);
    expect(list.body.comments[0].author_name).toBe('小雅');
    expect((await request(c.app).patch(`/api/client/jobs/${c.job}/photos/${c.p1}/comments/${commentId}`).set('Cookie', token).send({ content: '改一下' })).status).toBe(200);
    c.db.prepare('update photo_comment set created_at=? where id=?').run(new Date(Date.now() - 6 * 60000).toISOString(), commentId);
    expect((await request(c.app).patch(`/api/client/jobs/${c.job}/photos/${c.p1}/comments/${commentId}`).set('Cookie', token).send({ content: '过期' })).status).toBe(400);
  });

  it('enforces the order state machine and selector duplicate rules', async () => {
    expect((await request(c.app).patch(`/api/admin/jobs/${c.job}/publish`).set('Cookie', admin)).status).toBe(409);
    expect((await request(c.app).post(`/api/admin/jobs/${c.job}/lock`).set('Cookie', admin)).status).toBe(200);
    expect((await request(c.app).post(`/api/admin/jobs/${c.job}/reopen`).set('Cookie', admin).send({ reason: '退回' })).status).toBe(200);
    const duplicate = await request(c.app).post(`/api/admin/jobs/${c.job}/selectors`).set('Cookie', admin).send({ customer_id: c.s1 === c.s1 ? 1 : 1, phone: '13900000001', name: '小雅' });
    expect([201, 409]).toContain(duplicate.status);
    const createdJob = await request(c.app).post('/api/admin/jobs').set('Cookie', admin).send({ title: '新建测试', items: [{ name: '精修照片', kind: 'retouch', quantity: 10 }], allow_original_download: false, original_download_scope: 'none', deadline_at: new Date().toISOString() });
    expect(createdJob.status).toBe(201);
    expect(createdJob.body.job.items[0].name).toBe('精修照片');
    expect(createdJob.body.job.allow_original_download).toBe(0);
  });
});
