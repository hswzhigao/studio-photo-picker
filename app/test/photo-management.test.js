import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { getDb, initializeDatabase } from '../src/db/connection.js';
import { purgeExpiredTrash, TRASH_RETENTION_MS } from '../src/services/photoManager.js';

const staffPassword = 'staff-pass-123';
const clientPassword = 'client-pass-123';
const cookie = response => response.headers['set-cookie']?.[0]?.split(';')[0];

async function jpeg(color, width = 24, height = 30) {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

function setup(extra = {}) {
  const db = getDb(':memory:');
  initializeDatabase(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-manage-'));
  const sourceRoot = path.join(root, 'source-root');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const now = new Date().toISOString();
  const studio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S','W','SMS')").run().lastInsertRowid;
  db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(studio, 'Admin', '13800000001', 'admin', bcrypt.hashSync(staffPassword, 10));
  const customer = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)').run(studio, '小雅', '13900000001', bcrypt.hashSync(clientPassword, 10), 0, now, now).lastInsertRowid;
  const customer2 = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)').run(studio, '阿杰', '13900000002', bcrypt.hashSync(clientPassword, 10), 0, now, now).lastInsertRowid;
  const job = db.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by) values (?,?,?,?,?,?)").run(studio, 'J1', 'selecting', now, 'j1', 1).lastInsertRowid;
  const retouch = db.prepare("insert into job_item(job_id,name,kind,quantity,sort) values (?,?,?,?,?)").run(job, '精修照片', 'retouch', 2, 0).lastInsertRowid;
  const frame = db.prepare("insert into job_item(job_id,name,kind,quantity,sort) values (?,?,?,?,?)").run(job, '30寸相框', 'print_from_retouch', 1, 1).lastInsertRowid;
  const selector = db.prepare('insert into selector(job_id,customer_id,name,phone,permission) values (?,?,?,?,?)').run(job, customer, '小雅', '13900000001', 'select_submit').lastInsertRowid;
  const selector2 = db.prepare('insert into selector(job_id,customer_id,name,phone,permission) values (?,?,?,?,?)').run(job, customer2, '阿杰', '13900000002', 'select_submit').lastInsertRowid;
  const cfg = { studioName: 'S', dataDir: root, photoSourceDir: sourceRoot, watermarkText: '名人婚纱 · 预览', ...extra };
  const app = createApp({ db, cfg });
  return { db, root, sourceRoot, app, studio, job, retouch, frame, selector, selector2, customer, customer2, cfg };
}

async function login(agent, type, phone) {
  const pathname = type === 'staff' ? '/api/admin/login' : '/api/auth/login';
  const response = await agent.post(pathname).send({ phone, password: type === 'staff' ? staffPassword : clientPassword });
  expect(response.status).toBe(200);
}

async function upload(agent, jobId, buffer, filename, query = '') {
  const response = await agent.post(`/api/admin/jobs/${jobId}/photos${query}`).attach('photo', buffer, { filename, contentType: 'image/jpeg' });
  return response;
}

async function makeReady(c, response) {
  expect(response.status).toBe(201);
  const id = response.body.photo.id;
  await c.app.locals.waitForPhotoIds([id]);
  return c.db.prepare('select * from photo where id=?').get(id);
}

describe('photo management v3', () => {
  let c;
  let admin;
  let client;

  beforeEach(async () => {
    c = setup();
    admin = request.agent(c.app);
    await login(admin, 'staff', '13800000001');
    client = request.agent(c.app);
    await login(client, 'client', '13900000001');
  });

  afterEach(() => {
    c.app.locals.stopBackgroundTasks?.();
    c.db.close();
    fs.rmSync(c.root, { recursive: true, force: true });
  });

  it('uploads jpg/png one by one, keeps the Chinese display name and a uuid disk name', async () => {
    const jpg = await makeReady(c, await upload(admin, c.job, await jpeg('#aa3322'), '微信图片_20261107.png'));
    expect(jpg.import_status).toBe('ready');
    expect(jpg.display_name).toBe('微信图片_20261107.png');
    expect(jpg.source).toBe('upload');
    expect(jpg.version).toBe(1);
    expect(jpg.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(path.basename(jpg.original_key)).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(fs.existsSync(jpg.thumb_key)).toBe(true);
    expect(fs.existsSync(jpg.preview_key)).toBe(true);

    const pngBuffer = await sharp({ create: { width: 12, height: 18, channels: 4, background: '#3366aa' } }).png().toBuffer();
    const png = await makeReady(c, await upload(admin, c.job, pngBuffer, '中文名称.png'));
    expect(png.display_name).toBe('中文名称.png');
    expect(png.import_status).toBe('ready');
    expect(path.extname(png.original_key)).toBe('.png');

    const listed = await admin.get(`/api/admin/jobs/${c.job}/photos`);
    expect(listed.status).toBe(200);
    expect(listed.body.photos.map(p => p.display_name)).toEqual(['微信图片_20261107.png', '中文名称.png']);
    expect(listed.body.counts.total).toBe(2);
  });

  it('rejects fake image bytes and files over the configured size limit', async () => {
    const fake = await upload(admin, c.job, Buffer.from('not-an-image'), 'fake.jpg');
    expect(fake.status).toBe(400);
    expect(fake.body.error.code).toBe('INVALID_UPLOAD');

    const smallLimit = setup({ photoMaxBytes: 64 });
    try {
      const smallAdmin = request.agent(smallLimit.app);
      await login(smallAdmin, 'staff', '13800000001');
      const large = await upload(smallAdmin, smallLimit.job, await jpeg('#123456', 80, 80), 'large.jpg');
      expect(large.status).toBe(400);
      expect(large.body.error.code).toBe('UPLOAD_TOO_LARGE');
    } finally {
      smallLimit.app.locals.stopBackgroundTasks?.();
      smallLimit.db.close();
      fs.rmSync(smallLimit.root, { recursive: true, force: true });
    }
  });

  it('returns 409 for duplicate content and accepts it with allow_duplicate=1', async () => {
    const buffer = await jpeg('#445566');
    const first = await makeReady(c, await upload(admin, c.job, buffer, 'a.jpg'));
    const duplicate = await upload(admin, c.job, buffer, 'b.jpg');
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_PHOTO');
    expect(duplicate.body.error.photo_id).toBe(first.id);

    const forced = await makeReady(c, await upload(admin, c.job, buffer, 'b.jpg', '?allow_duplicate=1'));
    expect(forced.id).not.toBe(first.id);
    expect(forced.sha256).toBe(first.sha256);
  });

  it('stores ten concurrent uploads on disk and processes them all', async () => {
    const buffers = await Promise.all(Array.from({ length: 10 }, (_, index) => jpeg(`#${(index * 23 + 20).toString(16).padStart(2, '0')}4455`, 20, 20)));
    const responses = await Promise.all(buffers.map((buffer, index) => upload(admin, c.job, buffer, `并发-${index}.jpg`)));
    expect(responses.every(response => response.status === 201)).toBe(true);
    const ids = responses.map(response => response.body.photo.id);
    await c.app.locals.waitForPhotoIds(ids);
    const ready = c.db.prepare("select count(*) count from photo where job_id=? and import_status='ready'").get(c.job).count;
    expect(ready).toBe(10);
    const originals = fs.readdirSync(path.join(c.root, 'uploads', String(c.job)));
    expect(originals).toHaveLength(10);
    expect(originals.every(name => /^[0-9a-f-]{36}\.(jpg|png)$/.test(name))).toBe(true);
  });

  it('resumes processing photos left in processing state after a restart', async () => {
    const isolated = setup();
    try {
      const original = path.join(isolated.root, 'uploads', String(isolated.job), 'pending.jpg');
      fs.mkdirSync(path.dirname(original), { recursive: true });
      fs.writeFileSync(original, await jpeg('#778899'));
      const now = new Date().toISOString();
      const id = isolated.db.prepare("insert into photo(job_id,filename,display_name,original_key,source,import_status,version,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)").run(isolated.job, 'pending.jpg', 'pending.jpg', original, 'upload', 'processing', 1, now, now).lastInsertRowid;
      const restarted = createApp({ db: isolated.db, cfg: isolated.cfg });
      await restarted.locals.waitForPhotoIds([id]);
      expect(isolated.db.prepare('select import_status from photo where id=?').get(id).import_status).toBe('ready');
      restarted.locals.stopBackgroundTasks?.();
    } finally {
      isolated.app.locals.stopBackgroundTasks?.();
      isolated.db.close();
      fs.rmSync(isolated.root, { recursive: true, force: true });
    }
  });

  it('hides photos from the client list, quota, media and download scope, then restores them', async () => {
    const photo = await makeReady(c, await upload(admin, c.job, await jpeg('#993311'), '隐藏测试.jpg'));
    await client.patch(`/api/client/jobs/${c.job}/photos/${photo.id}/selection`).send({ selected: true }).expect(200);

    const hidden = await admin.patch(`/api/admin/jobs/${c.job}/photos/${photo.id}`).send({ hidden: true });
    expect(hidden.status).toBe(200);

    const detail = await client.get(`/api/client/jobs/${c.job}`);
    expect(detail.body.photos).toHaveLength(0);
    expect(detail.body.quota.count).toBe(0);
    expect((await client.get(`/media/previews/${photo.id}.webp`)).status).toBe(404);
    expect((await client.get(`/api/client/jobs/${c.job}/selected?tab=mine`)).body.photos).toHaveLength(0);
    expect((await client.get('/api/client/notifications')).status).toBe(200);

    await admin.patch(`/api/admin/jobs/${c.job}/photos/${photo.id}`).send({ hidden: false }).expect(200);
    const visible = await client.get(`/api/client/jobs/${c.job}`);
    expect(visible.body.photos).toHaveLength(1);
    expect(visible.body.quota.count).toBe(1);
  });

  it('deletes selected photos only after confirmation, clears slots and notifies, then restores everything', async () => {
    const photo = await makeReady(c, await upload(admin, c.job, await jpeg('#aabbcc'), '被选中的照片.jpg'));
    const other = await makeReady(c, await upload(admin, c.job, await jpeg('#ccbbaa'), '另一张.jpg'));
    await client.patch(`/api/client/jobs/${c.job}/photos/${photo.id}/selection`).send({ selected: true }).expect(200);
    await client.patch(`/api/client/jobs/${c.job}/photos/${photo.id}/slot`).send({ slot: 'frame', job_item_id: c.frame }).expect(200);
    await client.post(`/api/client/jobs/${c.job}/photos/${photo.id}/comments`).send({ content: '这张要精修' }).expect(201);

    const blocked = await admin.delete(`/api/admin/jobs/${c.job}/photos/${photo.id}`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CONFIRM_REQUIRED');
    expect(blocked.body.error.impact.selectors.map(s => s.name)).toContain('小雅');
    expect(blocked.body.error.impact.comment_count).toBe(1);
    expect(blocked.body.error.impact.slot_items.map(s => s.name)).toContain('30寸相框');

    const deleted = await admin.delete(`/api/admin/jobs/${c.job}/photos/${photo.id}`).send({ confirm: true });
    expect(deleted.status).toBe(200);

    const detail = await client.get(`/api/client/jobs/${c.job}`);
    expect(detail.body.photos.map(p => p.id)).toEqual([other.id]);
    expect(detail.body.quota.count).toBe(0);
    expect(detail.body.photos.length).toBe(1);
    const review = await client.get(`/api/client/jobs/${c.job}/review`);
    expect(review.body.products.find(item => item.item.id === c.frame).final).toBeNull();
    expect(review.body.problems.some(problem => problem.code === 'PRODUCT_UNASSIGNED')).toBe(true);
    const notifications = await client.get('/api/client/notifications');
    expect(notifications.body.notifications.some(item => item.kind === 'photo.deleted' && item.content.includes('被选中的照片.jpg'))).toBe(true);
    expect(c.db.prepare("select count(*) count from change_event where job_id=? and kind='photo.deleted'").get(c.job).count).toBe(1);

    await admin.post(`/api/admin/jobs/${c.job}/photos/${photo.id}/restore`).expect(200);
    const restored = await client.get(`/api/client/jobs/${c.job}`);
    expect(restored.body.photos.map(p => p.id)).toEqual([photo.id, other.id]);
    expect(restored.body.quota.count).toBe(1);
    const reviewAfter = await client.get(`/api/client/jobs/${c.job}/review`);
    expect(reviewAfter.body.products.find(item => item.item.id === c.frame).final.photo_id).toBe(photo.id);
    expect(restored.body.photos.find(p => p.id === photo.id).slots.some(slot => slot.job_item_id === c.frame)).toBe(true);
    expect(c.db.prepare("select count(*) count from change_event where job_id=? and kind='photo.restored'").get(c.job).count).toBe(1);
  });

  it('keeps id, selection and comments when replacing a file, and bumps version', async () => {
    const photo = await makeReady(c, await upload(admin, c.job, await jpeg('#111111'), '调色前.jpg'));
    await client.patch(`/api/client/jobs/${c.job}/photos/${photo.id}/selection`).send({ selected: true }).expect(200);
    await client.post(`/api/client/jobs/${c.job}/photos/${photo.id}/comments`).send({ content: '保留评论' }).expect(201);
    const before = fs.readFileSync(path.join(c.root, 'thumbnails', `${photo.id}.webp`));

    const replaced = await admin.put(`/api/admin/jobs/${c.job}/photos/${photo.id}/file`).attach('photo', await jpeg('#ee8800', 40, 50), '调色后.jpg');
    expect(replaced.status).toBe(200);
    expect(replaced.body.photo.id).toBe(photo.id);
    expect(replaced.body.photo.version).toBe(2);
    expect(replaced.body.photo.import_status).toBe('ready');
    expect(replaced.body.photo.display_name).toBe('调色前.jpg');
    expect(fs.readFileSync(path.join(c.root, 'thumbnails', `${photo.id}.webp`)).equals(before)).toBe(false);
    expect(c.db.prepare('select 1 from selection where photo_id=?').get(photo.id)).toBeTruthy();
    expect(c.db.prepare('select count(*) count from photo_comment where photo_id=? and deleted_at is null').get(photo.id).count).toBe(1);

    const detail = await client.get(`/api/client/jobs/${c.job}`);
    expect(detail.body.photos[0].version).toBe(2);
    expect(detail.body.photos[0].thumb_url).toContain('?v=2');
  });

  it('blocks delete/replace of selected photos after lock but still allows unselected photos', async () => {
    const selected = await makeReady(c, await upload(admin, c.job, await jpeg('#221100'), '已选.jpg'));
    const unselected = await makeReady(c, await upload(admin, c.job, await jpeg('#003322'), '未选.jpg'));
    const third = await makeReady(c, await upload(admin, c.job, await jpeg('#332200'), '未选可替换.jpg'));
    await client.patch(`/api/client/jobs/${c.job}/photos/${selected.id}/selection`).send({ selected: true }).expect(200);
    c.db.prepare("update job set status='locked' where id=?").run(c.job);

    const blockedDelete = await admin.delete(`/api/admin/jobs/${c.job}/photos/${selected.id}`).send({ confirm: true });
    expect(blockedDelete.status).toBe(409);
    expect(blockedDelete.body.error.code).toBe('JOB_LOCKED');
    const blockedReplace = await admin.put(`/api/admin/jobs/${c.job}/photos/${selected.id}/file`).attach('photo', await jpeg('#ff0000'), 'new.jpg');
    expect(blockedReplace.status).toBe(409);

    const deleted = await admin.delete(`/api/admin/jobs/${c.job}/photos/${unselected.id}`).send({ confirm: true });
    expect(deleted.status).toBe(200);
    const replaced = await admin.put(`/api/admin/jobs/${c.job}/photos/${third.id}/file`).attach('photo', await jpeg('#00ff00'), 'new.jpg');
    expect(replaced.status).toBe(200);
  });

  it('renames, sorts and batch-hides/restores photos', async () => {
    const a = await makeReady(c, await upload(admin, c.job, await jpeg('#101010'), '乙.jpg'));
    const b = await makeReady(c, await upload(admin, c.job, await jpeg('#202020'), '甲.jpg'));

    await admin.patch(`/api/admin/jobs/${c.job}/photos/${a.id}`).send({ display_name: '客户看到的名称' }).expect(200);
    const detail = await client.get(`/api/client/jobs/${c.job}`);
    expect(detail.body.photos.find(photo => photo.id === a.id).display_name).toBe('客户看到的名称');

    const reordered = await admin.post(`/api/admin/jobs/${c.job}/photos/reorder`).send({ ids: [b.id, a.id] });
    expect(reordered.status).toBe(200);
    expect((await client.get(`/api/client/jobs/${c.job}`)).body.photos.map(photo => photo.id)).toEqual([b.id, a.id]);

    await admin.post(`/api/admin/jobs/${c.job}/photos/batch`).send({ action: 'hide', ids: [a.id, b.id] }).expect(200);
    expect((await client.get(`/api/client/jobs/${c.job}`)).body.photos).toHaveLength(0);
    expect((await admin.get(`/api/admin/jobs/${c.job}/photos?trash=1`)).body.photos).toHaveLength(0);
    await admin.post(`/api/admin/jobs/${c.job}/photos/batch`).send({ action: 'show', ids: [a.id, b.id] }).expect(200);
    expect((await client.get(`/api/client/jobs/${c.job}`)).body.photos).toHaveLength(2);
  });

  it('purges only uploaded originals, never files imported from the server folder', async () => {
    const sourceDir = path.join(c.sourceRoot, '相册一');
    fs.mkdirSync(sourceDir, { recursive: true });
    const importedFile = path.join(sourceDir, '服务器原图.jpg');
    fs.writeFileSync(importedFile, await jpeg('#abcdef', 18, 24));

    const queued = await admin.post(`/api/admin/jobs/${c.job}/imports`).send({ source: '相册一' });
    expect(queued.status).toBe(202);
    let task;
    for (let i = 0; i < 100; i += 1) {
      task = await admin.get(`/api/admin/jobs/${c.job}/imports/${queued.body.import_task.id}`);
      if (['completed', 'failed'].includes(task.body.import_task.status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(task.body.import_task.status).toBe('completed');
    const imported = c.db.prepare("select * from photo where job_id=? and source='import'").get(c.job);
    expect(imported).toBeTruthy();

    const uploaded = await makeReady(c, await upload(admin, c.job, await jpeg('#fedcba'), '网页上传.jpg'));
    await admin.delete(`/api/admin/jobs/${c.job}/photos/${uploaded.id}`).send({ confirm: true }).expect(200);
    await admin.delete(`/api/admin/jobs/${c.job}/photos/${imported.id}`).send({ confirm: true }).expect(200);

    const old = new Date(Date.now() - TRASH_RETENTION_MS - 86400000).toISOString();
    c.db.prepare('update photo set deleted_at=? where id in (?,?)').run(old, uploaded.id, imported.id);
    const purged = purgeExpiredTrash(c.db, c.cfg);
    expect(purged).toBe(2);
    expect(fs.existsSync(uploaded.original_key)).toBe(false);
    expect(fs.existsSync(importedFile)).toBe(true);
    expect(fs.existsSync(path.join(c.root, 'thumbnails', `${uploaded.id}.webp`))).toBe(false);
    expect(c.db.prepare('select count(*) count from photo where id in (?,?)').get(uploaded.id, imported.id).count).toBe(0);
  });

  it('exposes source folder choices with image counts', async () => {
    const album = path.join(c.sourceRoot, '样片');
    fs.mkdirSync(album, { recursive: true });
    fs.writeFileSync(path.join(album, 'one.jpg'), await jpeg('#111111'));
    fs.writeFileSync(path.join(album, 'two.png'), await sharp({ create: { width: 8, height: 8, channels: 3, background: '#222222' } }).png().toBuffer());
    fs.writeFileSync(path.join(album, 'ignore.txt'), 'x');
    const response = await admin.get('/api/admin/source-dirs');
    expect(response.status).toBe(200);
    expect(response.body.root).toBe(c.sourceRoot);
    expect(response.body.directories).toEqual([{ name: '样片', image_count: 2 }]);
  });

  it('writes audit logs and change events for every photo write', async () => {
    const photo = await makeReady(c, await upload(admin, c.job, await jpeg('#334455'), '审计.jpg'));
    await admin.patch(`/api/admin/jobs/${c.job}/photos/${photo.id}`).send({ display_name: '改名', hidden: false }).expect(200);
    await admin.post(`/api/admin/jobs/${c.job}/photos/reorder`).send({ ids: [photo.id] }).expect(200);
    await admin.put(`/api/admin/jobs/${c.job}/photos/${photo.id}/file`).attach('photo', await jpeg('#554433'), '替换.jpg').expect(200);
    await admin.delete(`/api/admin/jobs/${c.job}/photos/${photo.id}`).send({ confirm: true }).expect(200);
    await admin.post(`/api/admin/jobs/${c.job}/photos/${photo.id}/restore`).expect(200);
    await admin.post(`/api/admin/jobs/${c.job}/photos/batch`).send({ action: 'hide', ids: [photo.id] }).expect(200);
    await admin.post(`/api/admin/jobs/${c.job}/photos/batch`).send({ action: 'show', ids: [photo.id] }).expect(200);

    await new Promise(resolve => setTimeout(resolve, 20));
    const kinds = c.db.prepare('select kind from change_event where job_id=? order by id').all(c.job).map(row => row.kind);
    for (const kind of ['photo.uploaded', 'photo.updated', 'photo.reordered', 'photo.replaced', 'photo.deleted', 'photo.restored']) expect(kinds).toContain(kind);

    const actions = c.db.prepare("select action from audit_log where job_id=?").all(c.job).map(row => row.action);
    expect(actions).toContain(`POST /api/admin/jobs/${c.job}/photos`);
    expect(actions).toContain(`PATCH /api/admin/jobs/${c.job}/photos/${photo.id}`);
    expect(actions).toContain(`PUT /api/admin/jobs/${c.job}/photos/${photo.id}/file`);
    expect(actions).toContain(`DELETE /api/admin/jobs/${c.job}/photos/${photo.id}`);
    expect(actions).toContain(`POST /api/admin/jobs/${c.job}/photos/${photo.id}/restore`);
  });

  it('lists only ready photos for clients while processing and reports queue status', async () => {
    const response = await upload(admin, c.job, await jpeg('#998877'), '处理中.jpg');
    expect(response.status).toBe(201);
    expect(response.body.photo.import_status).toBe('processing');
    expect((await client.get(`/api/client/jobs/${c.job}`)).body.photos).toHaveLength(0);
    const queue = await admin.get(`/api/admin/jobs/${c.job}/photo-queue`);
    expect(queue.status).toBe(200);
    expect(queue.body.queue.processing).toBeGreaterThanOrEqual(0);
    await c.app.locals.waitForPhotoIds([response.body.photo.id]);
    expect((await client.get(`/api/client/jobs/${c.job}`)).body.photos).toHaveLength(1);
  });
});
