import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { getDb, initializeDatabase } from '../src/db/connection.js';

function setup() {
  const db = getDb(':memory:'); initializeDatabase(db); const now = new Date().toISOString();
  const studio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S','W','SMS')").run().lastInsertRowid;
  const staff = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,0)').run(studio,'Staff','13800000001','admin',bcrypt.hashSync('staff-pass',10)).lastInsertRowid;
  const c1 = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)').run(studio,'One','13900000001',bcrypt.hashSync('client-pass',10),0,now,now).lastInsertRowid;
  const c2 = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)').run(studio,'Two','13900000002',bcrypt.hashSync('client-pass',10),0,now,now).lastInsertRowid;
  const job1 = db.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by) values (?,?,?,?,?,?)").run(studio,'J1','selecting',now,'j1',staff).lastInsertRowid;
  const job2 = db.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by) values (?,?,?,?,?,?)").run(studio,'J2','selecting',now,'j2',staff).lastInsertRowid;
  db.prepare('insert into selector(job_id,customer_id,name,phone,permission) values (?,?,?,?,?)').run(job1,c1,'One','13900000001','select_submit');
  db.prepare('insert into selector(job_id,customer_id,name,phone,permission) values (?,?,?,?,?)').run(job2,c2,'Two','13900000002','select_submit');
  const item = db.prepare("insert into job_item(job_id,name,kind,quantity,sort) values (?,?,?,?,?)").run(job1,'Frame','print_from_retouch',1,0).lastInsertRowid;
  const photo = db.prepare("insert into photo(job_id,filename,original_key,import_status) values (?,?,?,'ready')").run(job1,'a.jpg','/tmp/a').lastInsertRowid;
  return {db, app:createApp({db,cfg:{studioName:'S',dataDir:'/tmp',photoSourceDir:'.',watermarkText:'W'}}), c1, c2, job1, job2, item, photo};
}
const cookie = r => r.headers['set-cookie']?.[0]?.split(';')[0];
async function login(app, phone) { return cookie(await request(app).post('/api/auth/login').send({phone,password:'client-pass'})); }

describe('phase 3 client job workflow', () => {
  let ctx, token;
  beforeEach(async () => { ctx=setup(); token=await login(ctx.app,'13900000001'); });
  it('lists only jobs belonging to current customer and rejects another job detail', async () => {
    const list=await request(ctx.app).get('/api/client/jobs').set('Cookie',token);
    expect(list.status).toBe(200); expect(list.body.jobs.map(j=>j.id)).toEqual([ctx.job1]);
    expect((await request(ctx.app).get(`/api/client/jobs/${ctx.job2}`).set('Cookie',token)).status).toBe(404);
  });
  it('returns dynamic slots and removes only my slot on cancellation', async () => {
    const assigned=await request(ctx.app).patch(`/api/client/jobs/${ctx.job1}/photos/${ctx.photo}/slot`).set('Cookie',token).send({job_item_id:ctx.item});
    expect(assigned.status).toBe(200);
    const detail=await request(ctx.app).get(`/api/client/jobs/${ctx.job1}`).set('Cookie',token);
    expect(detail.body.photos[0].slots[0].job_item_id).toBe(ctx.item); expect(detail.body.photos[0].selected).toBe(true);
    const removed=await request(ctx.app).delete(`/api/client/jobs/${ctx.job1}/photos/${ctx.photo}/slot/${ctx.item}`).set('Cookie',token);
    expect(removed.status).toBe(200); expect((await request(ctx.app).get(`/api/client/jobs/${ctx.job1}`).set('Cookie',token)).body.photos[0].slots).toEqual([]);
  });
  it('locks every client write and supports withdraw plus review', async () => {
    ctx.db.prepare("update job set status='locked' where id=?").run(ctx.job1);
    expect((await request(ctx.app).patch(`/api/client/jobs/${ctx.job1}/photos/${ctx.photo}/note`).set('Cookie',token).send({content:'x'})).status).toBe(409);
    ctx.db.prepare("update job set status='submitted' where id=?").run(ctx.job1);
    expect((await request(ctx.app).post(`/api/client/jobs/${ctx.job1}/withdraw`).set('Cookie',token)).status).toBe(200);
    const review=await request(ctx.app).post(`/api/client/jobs/${ctx.job1}/review`).set('Cookie',token).send({rating:5,content:'great'});
    expect(review.status).toBe(201); expect(review.body.review.rating).toBe(5);
  });

  it('returns a read-only review summary and hides private selection counts', async () => {
    const otherSelector = ctx.db.prepare('select id from selector where job_id=? and customer_id=?').get(ctx.job2, ctx.c2);
    ctx.db.prepare('update selector set job_id=?, share_selection=0 where id=?').run(ctx.job1, otherSelector.id);
    const review = await request(ctx.app).get(`/api/client/jobs/${ctx.job1}/review`).set('Cookie', token);
    expect(review.status).toBe(200);
    expect(review.body).toHaveProperty('quota');
    expect(review.body).toHaveProperty('problems');
    const detail = await request(ctx.app).get(`/api/client/jobs/${ctx.job1}`).set('Cookie', token);
    const hidden = detail.body.selectors.find(s => s.id === otherSelector.id);
    expect(hidden.selectionCount).toBeUndefined();
  });

  it('rejects share changes after lock and makes the last product assignment final', async () => {
    const otherSelector = ctx.db.prepare('select id from selector where job_id=? and customer_id=?').get(ctx.job2, ctx.c2);
    ctx.db.prepare('update selector set job_id=?, share_selection=1 where id=?').run(ctx.job1, otherSelector.id);
    const secondPhoto = ctx.db.prepare("insert into photo(job_id,filename,original_key,import_status) values (?,?,?,'ready')").run(ctx.job1,'b.jpg','/tmp/b').lastInsertRowid;
    const first = await request(ctx.app).patch(`/api/client/jobs/${ctx.job1}/photos/${ctx.photo}/slot`).set('Cookie', token).send({ job_item_id: ctx.item });
    expect(first.status).toBe(200);
    const other = await request(ctx.app).post('/api/auth/login').send({ phone:'13900000002', password:'client-pass' });
    const otherToken = cookie(other);
    expect((await request(ctx.app).patch(`/api/client/jobs/${ctx.job1}/photos/${secondPhoto}/slot`).set('Cookie', otherToken).send({ job_item_id: ctx.item })).status).toBe(200);
    const assignment = ctx.db.prepare('select photo_id,selector_id,is_final from slot_assignment where job_item_id=? order by id').all(ctx.item);
    expect(assignment.find(row => row.photo_id === secondPhoto).is_final).toBe(1);
    expect(assignment.find(row => row.photo_id === ctx.photo).is_final).toBe(0);
    ctx.db.prepare("update job set status='locked' where id=?").run(ctx.job1);
    const locked = await request(ctx.app).patch(`/api/client/jobs/${ctx.job1}/share`).set('Cookie', token).send({ share_selection:false });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('JOB_LOCKED');
  });
});
