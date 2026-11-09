import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { getDb, initializeDatabase } from '../src/db/connection.js';
import { beijingDateStamp, nextExportName, sanitizeOrderName } from '../src/services/adminExport.js';
import { routes } from '../client/src/router.js';

const staffPassword = 'staff-pass-123';
const clientPassword = 'client-pass-123';
const cookie = response => response.headers['set-cookie']?.[0]?.split(';')[0];
const binaryParser = (res, callback) => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => callback(null, Buffer.concat(chunks))); };

function setup() {
  const db = getDb(':memory:');
  initializeDatabase(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-export-'));
  const now = new Date().toISOString();
  const studio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S','W','SMS')").run().lastInsertRowid;
  const otherStudio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('Other','W','SMS')").run().lastInsertRowid;
  db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(studio, 'Admin', '13800000001', 'admin', bcrypt.hashSync(staffPassword, 10));
  db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(otherStudio, 'Other', '13800000002', 'admin', bcrypt.hashSync(staffPassword, 10));
  const customer = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)').run(studio, '客户', '13900000001', bcrypt.hashSync(clientPassword, 10), 0, now, now).lastInsertRowid;
  const job = db.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by,overage_unit_price) values (?,?,?,?,?,?,?)").run(studio, '廖府/测试:1', 'selecting', now, 'job1', 1, 20).lastInsertRowid;
  const retouch = db.prepare("insert into job_item(job_id,name,kind,quantity,sort) values (?,?,?,?,?)").run(job, '精修照片', 'retouch', 2, 0).lastInsertRowid;
  const frame = db.prepare("insert into job_item(job_id,name,kind,quantity,sort) values (?,?,?,?,?)").run(job, '30寸相框', 'print_from_retouch', 1, 1).lastInsertRowid;
  const desk = db.prepare("insert into job_item(job_id,name,kind,quantity,sort) values (?,?,?,?,?)").run(job, '10寸摆台', 'print_from_retouch', 1, 2).lastInsertRowid;
  const s1 = db.prepare('insert into selector(job_id,customer_id,name,phone,permission,share_selection) values (?,?,?,?,?,?)').run(job, customer, '小雅', '13900000001', 'select_submit', 1).lastInsertRowid;
  const s2 = db.prepare('insert into selector(job_id,name,phone,permission,share_selection) values (?,?,?,?,?)').run(job, '阿杰', '13900000002', 'select_submit', 0).lastInsertRowid;
  const s3 = db.prepare('insert into selector(job_id,name,phone,permission,share_selection) values (?,?,?,?,?)').run(job, '妈妈', '13900000003', 'select_only', 0).lastInsertRowid;
  return { db, root, studio, job, retouch, frame, desk, s1, s2, s3, customer, now };
}

function addPhoto(c, { name, display, status = 'ready', hidden = 0, deletedAt = null, original = true }) {
  const originalKey = path.join(c.root, 'uploads', `${c.db.prepare('select coalesce(max(id),0)+1 id from photo').get().id}-${Math.random().toString(16).slice(2)}.jpg`);
  fs.mkdirSync(path.dirname(originalKey), { recursive: true });
  if (original) fs.writeFileSync(originalKey, `file:${name}:${originalKey}`);
  const now = new Date().toISOString();
  const id = c.db.prepare('insert into photo(job_id,filename,display_name,original_key,source,size_bytes,import_status,hidden,deleted_at,sort,version,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(c.job, name, display || name, originalKey, 'upload', original ? fs.statSync(originalKey).size : 100, status, hidden, deletedAt, c.db.prepare('select coalesce(max(sort),-1)+1 sort from photo where job_id=?').get(c.job).sort, 1, now, now).lastInsertRowid;
  return { id, originalKey };
}

function select(c, selectorId, photoId) {
  c.db.prepare('insert or ignore into selection(selector_id,photo_id,created_at) values (?,?,?)').run(selectorId, photoId, new Date().toISOString());
}
function assign(c, itemId, photoId, selectorId) {
  c.db.prepare('insert into slot_assignment(job_item_id,slot_index,photo_id,selector_id,is_final,created_at) values (?,?,?,?,1,?)').run(itemId, 1, photoId, selectorId, new Date().toISOString());
}

async function loginAdmin(app, phone = '13800000001') {
  return cookie(await request(app).post('/api/admin/login').send({ phone, password: staffPassword }));
}
async function waitExport(app, auth, jobId, exportId) {
  for (let i = 0; i < 200; i += 1) {
    const response = await request(app).get(`/api/admin/jobs/${jobId}/exports/${exportId}`).set('Cookie', auth);
    if (['ready', 'failed'].includes(response.body.export.status)) return response.body.export;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('export timeout');
}
function zipEntries(file) {
  return JSON.parse(execFileSync('python3', ['-c', 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', file], { encoding: 'utf8' }));
}
function zipText(file, name) {
  return execFileSync('python3', ['-c', 'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode("utf-8"))', file, name], { encoding: 'utf8' });
}

describe('v4 admin photo filters and exports', () => {
  let c, app, staff, client, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10;
  beforeEach(async () => {
    c = setup();
    app = createApp({ db: c.db, cfg: { studioName: 'S', dataDir: c.root, photoSourceDir: c.root, watermarkText: 'W' } });
    staff = await loginAdmin(app);
    client = cookie(await request(app).post('/api/auth/login').send({ phone: '13900000001', password: clientPassword }));
    p1 = addPhoto(c, { name: 'A.jpg', display: '小雅首选.jpg' });
    p2 = addPhoto(c, { name: 'B.jpg', display: '阿杰首选.jpg' });
    p3 = addPhoto(c, { name: 'C.jpg', display: '没人选.jpg' });
    p4 = addPhoto(c, { name: 'D.jpg', display: '隐藏照片.jpg', hidden: 1 });
    p5 = addPhoto(c, { name: 'E.jpg', display: '已删除.jpg', deletedAt: new Date().toISOString() });
    p6 = addPhoto(c, { name: 'F.jpg', display: '处理中.jpg', status: 'processing', original: false });
    p7 = addPhoto(c, { name: 'G.jpg', display: '有评论.jpg' });
    p8 = addPhoto(c, { name: 'H.jpg', display: '有备注.jpg' });
    p9 = addPhoto(c, { name: 'I.jpg', display: '相框照片.jpg' });
    p10 = addPhoto(c, { name: 'A.jpg', display: '同名照片.jpg' });
    select(c, c.s2, p1.id); select(c, c.s1, p1.id);
    select(c, c.s1, p9.id);
    assign(c, c.frame, p9.id, c.s1);
    select(c, c.s2, p4.id);
    select(c, c.s1, p5.id);
    select(c, c.s1, p6.id);
        c.db.prepare('insert into photo_comment(job_id,photo_id,author_type,author_id,visibility,content,created_at) values (?,?,?,?,?,?,?)').run(c.job, p7.id, 'customer', c.s1, 'all', '这张自然一点', new Date().toISOString());
    c.db.prepare('insert into photo_note(photo_id,selector_id,content,updated_at) values (?,?,?,?)').run(p8.id, c.s1, '皮肤不要磨太狠', new Date().toISOString());
  });
  afterEach(() => {
    app.locals.stopBackgroundTasks?.();
    c.db.close();
    fs.rmSync(c.root, { recursive: true, force: true });
  });

  it('serves filter counts and each server-side filter', async () => {
    const all = await request(app).get(`/api/admin/jobs/${c.job}/photos?page_size=200`).set('Cookie', staff);
    expect(all.status).toBe(200);
    expect(all.body.counts.total).toBe(10);
    expect(all.body.pagination.total).toBe(9); // deleted photo is not in normal list
    expect(all.body.filter_counts.all).toBe(9);
    expect(all.body.filter_counts.selected).toBe(2);
    expect(all.body.filter_counts.unselected).toBe(5);
    expect(all.body.filter_counts.slot).toBe(1);
    expect(all.body.filter_counts.commented).toBe(1);
    expect(all.body.filter_counts.noted).toBe(1);
    expect(all.body.filter_counts.hidden).toBe(1);
    expect(all.body.filter_counts.processing).toBe(1);
    expect(all.body.filter_counts.selectors).toEqual([
      { id: c.s1, name: '小雅', count: 2 },
      { id: c.s2, name: '阿杰', count: 1 },
      { id: c.s3, name: '妈妈', count: 0 },
    ]);

    const selected = await request(app).get(`/api/admin/jobs/${c.job}/photos?filter=selected&page_size=200`).set('Cookie', staff);
    expect(selected.body.photos.map(photo => photo.id).sort()).toEqual([p1.id, p9.id].sort());
    const hidden = await request(app).get(`/api/admin/jobs/${c.job}/photos?filter=hidden`).set('Cookie', staff);
    expect(hidden.body.photos.map(photo => photo.id)).toEqual([p4.id]);
    const processing = await request(app).get(`/api/admin/jobs/${c.job}/photos?filter=processing`).set('Cookie', staff);
    expect(processing.body.photos.map(photo => photo.id)).toEqual([p6.id]);
    const selector = await request(app).get(`/api/admin/jobs/${c.job}/photos?filter=selector:${c.s2}&page_size=200`).set('Cookie', staff);
    expect(selector.body.photos.map(photo => photo.id)).toEqual([p1.id]);
    const commented = await request(app).get(`/api/admin/jobs/${c.job}/photos?filter=commented`).set('Cookie', staff);
    expect(commented.body.photos.map(photo => photo.id)).toEqual([p7.id]);
    const noted = await request(app).get(`/api/admin/jobs/${c.job}/photos?filter=noted`).set('Cookie', staff);
    expect(noted.body.photos.map(photo => photo.id)).toEqual([p8.id]);
    const ids = await request(app).get(`/api/admin/jobs/${c.job}/photos?filter=selected&ids_only=1`).set('Cookie', staff);
    expect(ids.body.ids.sort()).toEqual([p1.id, p9.id].sort());
  });

  it('combines search with filters and paginates', async () => {
    const searched = await request(app).get(`/api/admin/jobs/${c.job}/photos?filter=selected&q=A.jpg&page=1&page_size=1`).set('Cookie', staff);
    expect(searched.body.pagination).toEqual({ page: 1, page_size: 1, total: 1, has_more: false });
    expect(searched.body.photos[0].id).toBe(p1.id);
    const page1 = await request(app).get(`/api/admin/jobs/${c.job}/photos?page=1&page_size=2`).set('Cookie', staff);
    expect(page1.body.photos).toHaveLength(2);
    expect(page1.body.pagination.has_more).toBe(true);
    const page2 = await request(app).get(`/api/admin/jobs/${c.job}/photos?page=2&page_size=2`).set('Cookie', staff);
    expect(page2.body.photos).toHaveLength(2);
    expect(page2.body.photos[0].id).not.toBe(page1.body.photos[0].id);
  });

  it('returns structured selected_by, actual product names, comments and notes', async () => {
    const response = await request(app).get(`/api/admin/jobs/${c.job}/photos?filter=slot`).set('Cookie', staff);
    const photo = response.body.photos[0];
    expect(photo.selected_by).toEqual([{ id: c.s1, name: '小雅' }]);
    expect(photo.slots).toEqual([{ id: c.frame, name: '30寸相框' }]);
    expect(photo.selected_by).not.toBe('小雅');
    const commented = await request(app).get(`/api/admin/jobs/${c.job}/photos?filter=commented`).set('Cookie', staff);
    expect(commented.body.photos[0].comment_count).toBe(1);
    expect(commented.body.photos[0].note_count).toBe(0);
    const noted = await request(app).get(`/api/admin/jobs/${c.job}/photos?filter=noted`).set('Cookie', staff);
    expect(noted.body.photos[0].note_count).toBe(1);
    const notes = await request(app).get(`/api/admin/jobs/${c.job}/photos/${p8.id}/notes`).set('Cookie', staff);
    expect(notes.body.notes[0]).toEqual(expect.objectContaining({ content: '皮肤不要磨太狠', selector_name: '小雅' }));
  });

  it('builds the Beijing-time filename and adds a suffix for same-day exports', () => {
    expect(beijingDateStamp(new Date('2026-11-09T15:59:00Z'))).toBe('20261109');
    expect(beijingDateStamp(new Date('2026-11-09T16:00:00Z'))).toBe('20261110');
    expect(sanitizeOrderName('廖府/测试:1*?"<>|')).toBe('廖府_测试_1______');
    const first = nextExportName(c.db, c.root, { id: c.job, title: '廖府/测试:1' }, new Date('2026-11-09T10:00:00Z'));
    expect(first.name).toBe('廖府_测试_1_20261109.zip');
    fs.mkdirSync(path.dirname(first.file), { recursive: true });
    fs.writeFileSync(first.file, 'x');
    const second = nextExportName(c.db, c.root, { id: c.job, title: '廖府/测试:1' }, new Date('2026-11-09T10:00:00Z'));
    expect(second.name).toBe('廖府_测试_1_20261109_2.zip');
  });

  it('exports selected photos into use folders with original names, CSV and duplicate suffixes', async () => {
    select(c, c.s1, p2.id);
    select(c, c.s1, p10.id);
    assign(c, c.desk, p2.id, c.s1);
    const created = await request(app).post(`/api/admin/jobs/${c.job}/exports`).set('Cookie', staff).send({ scope: 'selected', group_by_use: true, include_csv: true });
    expect(created.status).toBe(202);
    expect(created.body.export.export_name).toMatch(/^廖府_测试_1_\d{8}(_\d+)?\.zip$/);
    const done = await waitExport(app, staff, c.job, created.body.export.id);
    expect(done.status).toBe('ready');
    expect(done.missing).toBe(0);
    const download = await request(app).get(`/api/admin/jobs/${c.job}/exports/${done.id}/file`).set('Cookie', staff).buffer(true).parse(binaryParser);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(download.headers['content-disposition']).toContain(encodeURIComponent('廖府_测试_1_'));
    const file = path.join(c.root, 'download.zip');
    fs.writeFileSync(file, download.body);
    const entries = zipEntries(file);
    expect(entries).toContain('精修/A.jpg');
    expect(entries).toContain('精修/B.jpg');
    expect(entries).toContain('精修/I.jpg');
    expect(entries).toContain('30寸相框/I.jpg');
    expect(entries).toContain('10寸摆台/B.jpg');
    expect(entries).toContain('精修/A_2.jpg');
    expect(entries).toContain('修图清单.csv');
    const csv = zipText(file, '修图清单.csv');
    expect(csv).toContain('订单名');
    expect(csv).toContain('导出时间');
    expect(csv).toContain('额度');
    expect(csv).toContain('选片人提交');
    expect(csv).toContain('小雅首选.jpg');
    const audit = c.db.prepare("select * from audit_log where action='export.admin' order by id desc limit 1").get();
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit.payload).scope).toBe('selected');
  });

  it('supports ids/filter/all scopes and records missing originals', async () => {
    select(c, c.s1, p2.id);
    select(c, c.s1, p3.id);
    const idsExport = await request(app).post(`/api/admin/jobs/${c.job}/exports`).set('Cookie', staff).send({ scope: 'ids', ids: [p1.id, p2.id], group_by_use: false, include_csv: false });
    expect(idsExport.status).toBe(202);
    const idsDone = await waitExport(app, staff, c.job, idsExport.body.export.id);
    const idsDownload = await request(app).get(`/api/admin/jobs/${c.job}/exports/${idsDone.id}/file`).set('Cookie', staff).buffer(true).parse(binaryParser);
    const idsFile = path.join(c.root, 'ids.zip');
    fs.writeFileSync(idsFile, idsDownload.body);
    expect(zipEntries(idsFile).sort()).toEqual(['A.jpg', 'B.jpg']);

    const missingPhoto = addPhoto(c, { name: 'missing.jpg', display: '缺失原图.jpg', original: false });
    select(c, c.s1, missingPhoto.id);
    const missingExport = await request(app).post(`/api/admin/jobs/${c.job}/exports`).set('Cookie', staff).send({ scope: 'ids', ids: [missingPhoto.id], group_by_use: true, include_csv: true });
    const missingDone = await waitExport(app, staff, c.job, missingExport.body.export.id);
    expect(missingDone.missing).toBe(1);
    const missingDownload = await request(app).get(`/api/admin/jobs/${c.job}/exports/${missingDone.id}/file`).set('Cookie', staff).buffer(true).parse(binaryParser);
    const missingFile = path.join(c.root, 'missing.zip');
    fs.writeFileSync(missingFile, missingDownload.body);
    const entries = zipEntries(missingFile);
    expect(entries).toContain('缺失文件.txt');
    expect(entries).not.toContain('missing.jpg');
  });

  it('excludes hidden/deleted photos from every export scope', async () => {
    const all = await request(app).post(`/api/admin/jobs/${c.job}/exports`).set('Cookie', staff).send({ scope: 'all', group_by_use: false, include_csv: false });
    const done = await waitExport(app, staff, c.job, all.body.export.id);
    const download = await request(app).get(`/api/admin/jobs/${c.job}/exports/${done.id}/file`).set('Cookie', staff).buffer(true).parse(binaryParser);
    const file = path.join(c.root, 'all.zip');
    fs.writeFileSync(file, download.body);
    const entries = zipEntries(file);
    expect(entries).toContain('A.jpg');
    expect(entries).not.toContain('D.jpg');
    expect(entries).not.toContain('E.jpg');
    expect(entries).not.toContain('F.jpg');
  });

  it('enforces studio ownership, client separation, expiry and cleanup', async () => {
    const created = await request(app).post(`/api/admin/jobs/${c.job}/exports`).set('Cookie', staff).send({ scope: 'selected' });
    const otherStaff = await loginAdmin(app, '13800000002');
    expect((await request(app).get(`/api/admin/jobs/${c.job}/exports`).set('Cookie', otherStaff)).status).toBe(404);
    expect((await request(app).get(`/api/admin/jobs/${c.job}/exports/${created.body.export.id}`).set('Cookie', client)).status).toBe(401);
    const done = await waitExport(app, staff, c.job, created.body.export.id);
    c.db.prepare('update download_package set expires_at=? where id=?').run(new Date(Date.now() - 1000).toISOString(), done.id);
    expect((await request(app).get(`/api/admin/jobs/${c.job}/exports/${done.id}/file`).set('Cookie', staff)).status).toBe(404);
    app.locals.cleanPackages();
    expect(c.db.prepare('select count(*) count from download_package where id=?').get(done.id).count).toBe(0);
  });

  it('uses RFC 5987 filenames for CSV and includes order metadata', async () => {
    const response = await request(app).get(`/api/admin/jobs/${c.job}/export.csv`).set('Cookie', staff);
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(response.headers['content-disposition']).toContain(encodeURIComponent('廖府_测试_1_'));
    expect(response.headers['content-disposition']).toContain('%E4%BF%AE%E5%9B%BE%E6%B8%85%E5%8D%95.csv');
    expect(response.text).toContain('订单名');
    expect(response.text).toContain('导出时间');
    expect(response.text).toContain('额度');
    expect(response.text).toContain('选片人提交');
  });

  it('registers routed admin pages and does not create data directories in cwd', () => {
    const flat = [];
    const walk = list => { for (const item of list) { flat.push(item.path); if (item.children) walk(item.children); } };
    walk(routes);
    expect(flat).toContain('/admin');
    expect(flat).toContain('jobs/:id');
    expect(flat).toContain('photos');
    expect(flat).toContain('summary');
    expect(fs.existsSync(path.join(process.cwd(), 'uploads'))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), 'thumbnails'))).toBe(false);
    expect(() => createApp({ db: c.db, cfg: { studioName: 'S' } })).toThrow(/dataDir/);
  });
});
