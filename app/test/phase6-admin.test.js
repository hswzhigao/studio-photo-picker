import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { getDb, initializeDatabase } from '../src/db/connection.js';

function setup() {
  const db = getDb(':memory:'); initializeDatabase(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-')); fs.mkdirSync(path.join(root, 'thumbnails')); fs.mkdirSync(path.join(root, 'previews'));
  const now = new Date().toISOString();
  const studio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S','W','SMS')").run().lastInsertRowid;
  const otherStudio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('Other','W','SMS')").run().lastInsertRowid;
  const admin = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(studio,'Admin','13800000001','admin',bcrypt.hashSync('admin-pass',10)).lastInsertRowid;
  const worker = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(studio,'Worker','13800000002','editor',bcrypt.hashSync('worker-pass',10)).lastInsertRowid;
  const foreignWorker = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(otherStudio,'Other','13800000003','editor',bcrypt.hashSync('worker-pass',10)).lastInsertRowid;
  const customer = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)').run(studio,'One','13900000001',bcrypt.hashSync('client-pass',10),0,now,now).lastInsertRowid;
  const job = db.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by) values (?,?,?,?,?,?)").run(studio,'J1','selecting',now,'j1',admin).lastInsertRowid;
  const selector = db.prepare('insert into selector(job_id,customer_id,name,phone,permission) values (?,?,?,?,?)').run(job,customer,'One','13900000001','select_submit').lastInsertRowid;
  return {db,root,job,admin,worker,foreignWorker,customer,selector,app:createApp({db,cfg:{studioName:'S',dataDir:root,photoSourceDir:root,watermarkText:'W'}})};
}
const cookie = r => r.headers['set-cookie']?.[0]?.split(';')[0];
async function login(app, phone, password) { return cookie(await request(app).post('/api/admin/login').send({phone,password})); }

describe('phase 6 admin API', () => {
  let c, adminCookie, workerCookie, foreignCookie;
  beforeEach(async () => { c=setup(); adminCookie=await login(c.app,'13800000001','admin-pass'); workerCookie=await login(c.app,'13800000002','worker-pass'); foreignCookie=await login(c.app,'13800000003','worker-pass'); });
  afterEach(() => fs.rmSync(c.root,{recursive:true,force:true}));

  it('enforces studio ownership and admin-only customer management with one-time password', async () => {
    expect((await request(c.app).get(`/api/admin/jobs/999/summary`).set('Cookie',workerCookie)).status).toBe(404);
    expect((await request(c.app).get(`/api/admin/jobs/${c.job}/summary`).set('Cookie',foreignCookie)).status).toBe(404);
    const created=await request(c.app).post('/api/admin/customers').set('Cookie',adminCookie).send({name:'New',phone:'13900000002'});
    expect(created.status).toBe(201); expect(created.body.password).toBeTruthy(); expect(created.body.password).not.toMatch(/admin|secret/i);
    expect((await request(c.app).get('/api/admin/customers?q=New').set('Cookie',adminCookie)).body.customers).toHaveLength(1);
    expect((await request(c.app).get('/api/admin/staff').set('Cookie',workerCookie)).status).toBe(403);
    expect((await request(c.app).get(`/api/admin/jobs/${c.job}/summary`).set('Cookie',adminCookie)).status).toBe(200);
    const allLogs=await request(c.app).get('/api/admin/audit-logs').set('Cookie',adminCookie);
    expect(allLogs.status).toBe(200); expect(allLogs.body.logs.map(log=>log.action)).toContain('POST /api/admin/customers');
  });

  it('supports package templates, draft jobs, selectors, settings and audit logs', async () => {
    const t=await request(c.app).post('/api/admin/package-templates').set('Cookie',adminCookie).send({name:'Basic',items:[{name:'Retouch',kind:'print_from_retouch',quantity:2}]});
    expect(t.status).toBe(201);
    const j=await request(c.app).post('/api/admin/jobs').set('Cookie',adminCookie).send({title:'Draft',deadline_at:new Date().toISOString(),template_id:t.body.template.id});
    expect(j.status).toBe(201); expect(j.body.job.status).toBe('draft'); expect(j.body.job.items).toHaveLength(1);
    const patched=await request(c.app).patch(`/api/admin/jobs/${j.body.job.id}`).set('Cookie',adminCookie).send({allow_preview_download:true}); expect(patched.status).toBe(200);
    const s=await request(c.app).post(`/api/admin/jobs/${c.job}/selectors`).set('Cookie',adminCookie).send({name:'Two',phone:'13900000009',permission:'select_submit'});
    expect(s.status).toBe(201); expect((await request(c.app).get(`/api/admin/jobs/${c.job}/selectors`).set('Cookie',adminCookie)).body.selectors.length).toBe(2);
    expect((await request(c.app).get(`/api/admin/audit-logs?job_id=${c.job}`).set('Cookie',adminCookie)).status).toBe(200);
  });

  it('queues safe imports and persists progress without exposing absolute paths', async () => {
    const outside=path.join(os.tmpdir(),`phase6-outside-${Date.now()}`); fs.writeFileSync(outside,'x'); const nested=path.join(c.root,'nested'); fs.mkdirSync(nested);
    const list=await request(c.app).get('/api/admin/source-dirs').set('Cookie',adminCookie);
    expect(list.status).toBe(200); expect(list.body.directories.every(x=>!x.includes('..'))).toBe(true);
    const queued=await request(c.app).post(`/api/admin/jobs/${c.job}/imports`).set('Cookie',adminCookie).send({source:'nested'});
    expect(queued.status).toBe(202); expect(queued.body.import_task.id).toBeTruthy(); expect(JSON.stringify(queued.body)).not.toContain(outside);
    const progress=await request(c.app).get(`/api/admin/jobs/${c.job}/imports/${queued.body.import_task.id}`).set('Cookie',adminCookie);
    expect(['pending','processing','completed','failed']).toContain(progress.body.import_task.status);
    fs.rmSync(outside,{force:true});
  });

  it('executes queued imports and records safe completion progress', async () => {
    const source = path.join(c.root, 'source'); fs.mkdirSync(source); await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).jpeg().toFile(path.join(source, 'one.jpg'));
    const cfgApp = createApp({ db: c.db, cfg: { studioName: 'S', dataDir: c.root, photoSourceDir: c.root, watermarkText: 'W' } });
    const queued = await request(cfgApp).post(`/api/admin/jobs/${c.job}/imports`).set('Cookie', adminCookie).send({ source: 'source' });
    expect(queued.status).toBe(202);
    let progress;
    for (let i = 0; i < 20; i += 1) { progress = await request(cfgApp).get(`/api/admin/jobs/${c.job}/imports/${queued.body.import_task.id}`).set('Cookie', adminCookie); if (['completed', 'failed'].includes(progress.body.import_task.status)) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(progress.body.import_task.status).toBe('completed'); expect(progress.body.import_task.total).toBe(1); expect(progress.body.import_task.processed).toBe(1); expect(progress.body.import_task.failed).toBe(0);
    expect(c.db.prepare('select count(*) count from photo where job_id=? and import_status=\'ready\'').get(c.job).count).toBe(1);
  });

  it('supports photo and selector administration, comments, notifications, and job filters', async () => {
    const photo = c.db.prepare("insert into photo(job_id,filename,original_key,import_status,hidden) values(?,?,?,?,0)").run(c.job,'a.jpg',path.join(c.root,'a.jpg'),'ready').lastInsertRowid;
    const listed = await request(c.app).get(`/api/admin/jobs/${c.job}/photos`).set('Cookie',adminCookie);
    expect(listed.status).toBe(200);
    expect((await request(c.app).patch(`/api/admin/jobs/${c.job}/photos/${photo}`).set('Cookie',adminCookie).send({hidden:true})).status).toBe(200);
    expect((await request(c.app).patch(`/api/admin/jobs/${c.job}/selectors/${c.selector}`).set('Cookie',adminCookie).send({share_selection:false})).status).toBe(200);
    expect((await request(c.app).post(`/api/admin/jobs/${c.job}/photos/${photo}/comments`).set('Cookie',adminCookie).send({content:'后台备注'})).status).toBe(201);
    expect((await request(c.app).get(`/api/admin/jobs/${c.job}/comments`).set('Cookie',adminCookie)).status).toBe(200);
    expect((await request(c.app).post(`/api/admin/jobs/${c.job}/comments/read`).set('Cookie',adminCookie)).status).toBe(200);
    const jobs = await request(c.app).get('/api/admin/jobs?status=selecting&q=J1').set('Cookie',adminCookie);
    expect(jobs.status).toBe(200);
    expect(jobs.body.jobs[0]).toHaveProperty('submitted_progress');
  });

  it('covers phase6 admin CRUD, publishing, notifications, and settlement alias', async () => {
    const customerPatch = await request(c.app).patch(`/api/admin/customers/${c.customer}`).set('Cookie',adminCookie).send({name:'Renamed',phone:'13900000009',status:'disabled'});
    expect(customerPatch.status).toBe(200); expect(customerPatch.body.customer.name).toBe('Renamed');
    await request(c.app).patch(`/api/admin/customers/${c.customer}`).set('Cookie',adminCookie).send({status:'active'});
    const staff = await request(c.app).post('/api/admin/staff').set('Cookie',adminCookie).send({name:'New Worker',phone:'13800000004',role:'editor'});
    expect(staff.status).toBe(201); expect(staff.body.password).toBeTruthy();
    expect((await request(c.app).patch(`/api/admin/staff/${staff.body.staff.id}`).set('Cookie',adminCookie).send({name:'Edited'})).status).toBe(200);
    expect((await request(c.app).post(`/api/admin/staff/${staff.body.staff.id}/reset-password`).set('Cookie',adminCookie)).status).toBe(200);
    const template = await request(c.app).post('/api/admin/package-templates').set('Cookie',adminCookie).send({name:'T2',items:[]});
    expect((await request(c.app).patch(`/api/admin/package-templates/${template.body.template.id}`).set('Cookie',adminCookie).send({name:'T3'})).status).toBe(200);
    expect((await request(c.app).delete(`/api/admin/package-templates/${template.body.template.id}`).set('Cookie',adminCookie)).status).toBe(200);
    expect((await request(c.app).patch(`/api/admin/jobs/${c.job}/publish`).set('Cookie',adminCookie)).status).toBe(200);
    expect(c.db.prepare('select count(*) count from notification where job_id=?').get(c.job).count).toBeGreaterThan(0);
    expect(c.db.prepare('select count(*) count from change_event where job_id=?').get(c.job).count).toBeGreaterThan(0);
    expect(c.db.prepare('select count(*) count from audit_log where job_id=?').get(c.job).count).toBeGreaterThan(0);
    const notifications = await request(c.app).get(`/api/admin/jobs/${c.job}/notifications`).set('Cookie',adminCookie);
    expect(notifications.status).toBe(200); expect(notifications.body.notifications.length).toBeGreaterThan(0);
    const settled = await request(c.app).post(`/api/admin/jobs/${c.job}/settle`).set('Cookie',adminCookie);
    expect(settled.status).toBe(200); expect(settled.body.job.overage_settled).toBe(1);
    const settlement = await request(c.app).get('/api/admin/settlement').set('Cookie',adminCookie);
    expect(settlement.status).toBe(200); expect(Array.isArray(settlement.body.jobs)).toBe(true);
    const logs = await request(c.app).get(`/api/admin/audit-logs?job_id=${c.job}`).set('Cookie',adminCookie);
    expect(logs.status).toBe(200); expect(logs.body.logs.every(log => log.job_id === c.job)).toBe(true);
    expect(logs.body.logs.map(log => log.action)).toEqual(expect.arrayContaining(['publish','settle']));
  });

  it('audits every admin write and strips password and token fields from payloads', async () => {
    const writes = [];
    const call = async (method, url, body) => {
      const response = await request(c.app)[method](url).set('Cookie', adminCookie).send(body);
      expect(response.status, `${method.toUpperCase()} ${url}`).toBeLessThan(300);
      writes.push(response);
      return response;
    };
    const createdCustomer = await call('post', '/api/admin/customers', {name:'Audited Customer', phone:'13900000008', password:'do-not-log', token:'customer-token'});
    await call('patch', `/api/admin/customers/${createdCustomer.body.customer.id}`, {name:'Audited Customer 2', token:'customer-token'});
    await call('post', `/api/admin/customers/${createdCustomer.body.customer.id}/reset-password`, {password:'do-not-log', token:'customer-token'});
    const createdStaff = await call('post', '/api/admin/staff', {name:'Audited Staff', phone:'13800000008', password:'do-not-log', token:'staff-token'});
    const template = await call('post', '/api/admin/package-templates', {name:'Audited Template', token:'template-token'});
    await call('patch', `/api/admin/package-templates/${template.body.template.id}`, {name:'Audited Template 2', token:'template-token'});
    const createdJob = await call('post', '/api/admin/jobs', {title:'Audited Job', template_id:template.body.template.id, invite_token:'invite-secret', token:'job-token'});
    await call('patch', `/api/admin/jobs/${createdJob.body.job.id}`, {title:'Audited Job 2', metadata:{token:'nested-job-token', password:'nested-password'}});
    const createdSelector = await call('post', `/api/admin/jobs/${c.job}/selectors`, {name:'Audited Selector', phone:'13900000008', token:'selector-token'});
    await call('patch', `/api/admin/jobs/${c.job}/selectors/${createdSelector.body.selector.id}`, {name:'Audited Selector 2', token:'selector-token'});
    const photo = c.db.prepare("insert into photo(job_id,filename,original_key,import_status,hidden) values(?,?,?,?,0)").run(c.job,'audit.jpg',path.join(c.root,'audit.jpg'),'ready').lastInsertRowid;
    await call('patch', `/api/admin/jobs/${c.job}/photos/${photo}`, {hidden:true, token:'photo-token'});
    await call('post', `/api/admin/jobs/${c.job}/photos/${photo}/comments`, {content:'审计评论', password:'do-not-log', token:'comment-token'});
    const source = path.join(c.root,'audit-source'); fs.mkdirSync(source);
    await call('post', `/api/admin/jobs/${c.job}/imports`, {source:'audit-source', token:'import-token'});
    await call('patch', `/api/admin/jobs/${c.job}/publish`, {token:'publish-token'});
    await call('post', `/api/admin/jobs/${c.job}/lock`, {token:'lock-token'});
    await call('post', `/api/admin/jobs/${c.job}/remind`, {token:'remind-token'});
    await call('post', `/api/admin/jobs/${c.job}/settle`, {token:'settle-token'});
    await call('post', `/api/admin/jobs/${c.job}/reopen`, {reason:'审计测试', token:'reopen-token'});
    const logs = (await request(c.app).get('/api/admin/audit-logs').set('Cookie', adminCookie)).body.logs;
    const actions = new Set(logs.map(log => log.action));
    for (const response of writes) expect(actions).toContain(`${response.req.method} ${response.req.path}`);
    for (const log of logs) expect(log.payload || '').not.toMatch(/password|token|invite_secret|do-not-log/i);
    expect(createdStaff.body.password).toBeTruthy();
  });

  it('supports submit/withdraw, reminders, settlement, reopen reason and CSV BOM', async () => {
    expect((await request(c.app).post(`/api/admin/jobs/${c.job}/remind`).set('Cookie',adminCookie)).status).toBe(200);
    expect((await request(c.app).post(`/api/admin/jobs/${c.job}/settle`).set('Cookie',adminCookie)).status).toBe(200);
    const reopened=await request(c.app).post(`/api/admin/jobs/${c.job}/reopen`).set('Cookie',adminCookie).send({reason:'客户需修改'});
    expect(reopened.status).toBe(200);
    const clientCookie=cookie(await request(c.app).post('/api/auth/login').send({phone:'13900000001',password:'client-pass'}));
    const notifications=await request(c.app).get('/api/client/notifications').set('Cookie',clientCookie);
    expect(notifications.status).toBe(200); expect(notifications.body.notifications.some(item=>item.kind==='reopen'&&item.content.includes('客户需修改'))).toBe(true);
    const csv=await request(c.app).get(`/api/admin/jobs/${c.job}/export.csv`).set('Cookie',adminCookie); expect(csv.status).toBe(200); expect(csv.text.charCodeAt(0)).toBe(0xFEFF);
  });
});
