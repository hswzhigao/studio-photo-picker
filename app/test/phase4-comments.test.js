import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { getDb, initializeDatabase } from '../src/db/connection.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function setup() {
  const db = getDb(':memory:'); initializeDatabase(db); const now = new Date().toISOString();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-'));
  const studio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S','W','SMS')").run().lastInsertRowid;
  const staff = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(studio,'Staff','13800000001','admin',bcrypt.hashSync('staff-pass',10)).lastInsertRowid;
  const c1 = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)').run(studio,'One','13900000001',bcrypt.hashSync('client-pass',10),0,now,now).lastInsertRowid;
  const c2 = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)').run(studio,'Two','13900000002',bcrypt.hashSync('client-pass',10),0,now,now).lastInsertRowid;
  const job = db.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by) values (?,?,?,?,?,?)").run(studio,'J1','selecting',now,'j1',staff).lastInsertRowid;
  const selector = db.prepare('insert into selector(job_id,customer_id,name,phone,permission) values (?,?,?,?,?)').run(job,c1,'One','13900000001','select_submit').lastInsertRowid;
  const other = db.prepare('insert into selector(job_id,customer_id,name,phone,permission) values (?,?,?,?,?)').run(job,c2,'Two','13900000002','select_submit').lastInsertRowid;
  const photo = db.prepare("insert into photo(job_id,filename,original_key,import_status) values (?,?,?,'ready')").run(job,'a.jpg','/tmp/a').lastInsertRowid;
  return {db, root, app:createApp({db,cfg:{studioName:'S',dataDir:root,photoSourceDir:root,watermarkText:'W'}}), job, selector, other, photo};
}
const cookie = r => r.headers['set-cookie']?.[0]?.split(';')[0];
async function login(app, phone, password) { return cookie(await request(app).post('/api/auth/login').send({phone,password})); }
async function staffLogin(app) { return cookie(await request(app).post('/api/admin/login').send({phone:'13800000001',password:'staff-pass'})); }

describe('phase 4 comments and polling', () => {
  let ctx, client, other, staff;
  beforeEach(async () => { ctx=setup(); client=await login(ctx.app,'13900000001','client-pass'); other=await login(ctx.app,'13900000002','client-pass'); staff=await staffLogin(ctx.app); });
  it('supports client comment, one-level reply, edit/delete and visibility', async () => {
    const created=await request(ctx.app).post(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/comments`).set('Cookie',client).send({content:'hello',visibility:'studio_only'});
    expect(created.status).toBe(201); const id=created.body.comment.id;
    expect((await request(ctx.app).get(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/comments`).set('Cookie',other)).body.comments).toHaveLength(0);
    expect((await request(ctx.app).get(`/api/admin/jobs/${ctx.job}/photos/${ctx.photo}/comments`).set('Cookie',staff)).body.comments).toHaveLength(1);
    expect((await request(ctx.app).post(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/comments`).set('Cookie',client).send({parent_id:id,content:'reply',visibility:'all'})).status).toBe(201);
    expect((await request(ctx.app).patch(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/comments/${id}`).set('Cookie',client).send({content:'edited'})).status).toBe(200);
    expect((await request(ctx.app).delete(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/comments/${id}`).set('Cookie',client)).status).toBe(200);
  });
  it('writes and filters change events, and marks comment reads', async () => {
    const made=await request(ctx.app).post(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/comments`).set('Cookie',client).send({content:'visible'});
    expect(made.status).toBe(201);
    const changes=await request(ctx.app).get(`/api/client/jobs/${ctx.job}/changes?after=0`).set('Cookie',client);
    expect(changes.status).toBe(200); expect(changes.body.events.some(e=>e.kind==='comment.created')).toBe(true);
    const detail=await request(ctx.app).get(`/api/client/jobs/${ctx.job}`).set('Cookie',client);
    expect(detail.body.photos[0].comment_count).toBe(1); expect(detail.body.photos[0].unread_comment_count).toBe(1);
    expect((await request(ctx.app).post(`/api/client/jobs/${ctx.job}/comments/read`).set('Cookie',client)).status).toBe(200);
    const after=await request(ctx.app).get(`/api/client/jobs/${ctx.job}`).set('Cookie',client);
    expect(after.body.photos[0].unread_comment_count).toBe(0);
  });
  it('rejects cross-job and overlong comments', async () => {
    expect((await request(ctx.app).post(`/api/client/jobs/${ctx.job}/photos/999/comments`).set('Cookie',client).send({content:'x'})).status).toBe(404);
    expect((await request(ctx.app).post(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/comments`).set('Cookie',client).send({content:'x'.repeat(501)})).status).toBe(400);
  });

  it('validates one-level replies and defaults private comments for non-sharing selectors', async () => {
    ctx.db.prepare('update selector set share_selection=0 where id=?').run(ctx.other);
    const first = await request(ctx.app).post(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/comments`).set('Cookie',other).send({content:'private by default'});
    expect(first.status).toBe(201);
    expect(first.body.comment.visibility).toBe('studio_only');
    const reply = await request(ctx.app).post(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/comments`).set('Cookie',other).send({parent_id:first.body.comment.id,content:'reply'});
    expect(reply.status).toBe(201);
    const nested = await request(ctx.app).post(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/comments`).set('Cookie',other).send({parent_id:reply.body.comment.id,content:'nested'});
    expect(nested.status).toBe(400);
    expect((await request(ctx.app).get(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/comments`).set('Cookie',client)).body.comments).toHaveLength(0);
  });

  it('filters private change events and records selection changes', async () => {
    ctx.db.prepare('update selector set share_selection=0 where id=?').run(ctx.other);
    const privateComment = await request(ctx.app).post(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/comments`).set('Cookie',other).send({content:'private'});
    expect(privateComment.status).toBe(201);
    const hiddenEvents = await request(ctx.app).get(`/api/client/jobs/${ctx.job}/changes?after=0`).set('Cookie',client);
    expect(hiddenEvents.body.events.some(e => e.kind.startsWith('comment.') && e.payload?.comment_id === privateComment.body.comment.id)).toBe(false);
    const selected = await request(ctx.app).patch(`/api/client/jobs/${ctx.job}/photos/${ctx.photo}/selection`).set('Cookie',client).send({selected:true});
    expect(selected.status).toBe(200);
    const events = await request(ctx.app).get(`/api/client/jobs/${ctx.job}/changes?after=0`).set('Cookie',client);
    expect(events.body.events.some(e => e.kind === 'selection.created')).toBe(true);
  });

  it('records share, submit, withdraw, and lock changes for staff polling', async () => {
    const share = await request(ctx.app).patch(`/api/client/jobs/${ctx.job}/me`).set('Cookie',client).send({share_selection:false});
    expect(share.status).toBe(200);
    const submit = await request(ctx.app).post(`/api/client/jobs/${ctx.job}/submit`).set('Cookie',client).send({accept_overage:true});
    expect(submit.status).toBe(200);
    const withdraw = await request(ctx.app).post(`/api/client/jobs/${ctx.job}/withdraw`).set('Cookie',client);
    expect(withdraw.status).toBe(200);
    const lock = await request(ctx.app).post(`/api/admin/jobs/${ctx.job}/lock`).set('Cookie',staff);
    expect(lock.status).toBe(200);
    const events = await request(ctx.app).get(`/api/admin/jobs/${ctx.job}/changes?after=0`).set('Cookie',staff);
    expect(events.body.events.map(e => e.kind)).toEqual(expect.arrayContaining(['share.changed','submit','withdraw','job.status']));
  });
});
