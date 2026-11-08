import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { getDb, initializeDatabase } from '../src/db/connection.js';

const password = 'phase2-test-password';
function setup() {
  const db = getDb(':memory:');
  initializeDatabase(db);
  const studio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S','W','SMS')").run().lastInsertRowid;
  const staff = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values (?,?,?,?,?,?)').run(studio, 'Admin', '13800000009', 'admin', bcrypt.hashSync(password, 10), 1).lastInsertRowid;
  const now = new Date().toISOString();
  const customer = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values (?,?,?,?,?,?,?)').run(studio, 'Client', '13900000009', bcrypt.hashSync(password, 10), 1, now, now).lastInsertRowid;
  const job = db.prepare('insert into job(studio_id,title,deadline_at,invite_token,created_by) values (?,?,?,?,?)').run(studio, 'J', new Date().toISOString(), 'opaque-invite', staff).lastInsertRowid;
  db.prepare('insert into selector(job_id,customer_id,name,phone,permission) values (?,?,?,?,?)').run(job, customer, 'Client', '13900000009', 'select_submit');
  const app = createApp({ db, cfg: { studioName: 'S', dataDir: '/tmp', photoSourceDir: '.', watermarkText: 'W' } });
  return { db, app, staff, customer, job };
}
const cookie = response => response.headers['set-cookie']?.[0]?.split(';')[0];

describe('phase 2 password authentication', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });

  it('authenticates staff and customers with bcrypt passwords, not OTP or invite tokens', async () => {
    const staff = await request(ctx.app).post('/api/admin/login').send({ phone: '13800000009', password });
    expect(staff.status).toBe(200);
    expect(staff.body.must_change_password).toBe(true);
    const customer = await request(ctx.app).post('/api/auth/login').send({ phone: '13900000009', password });
    expect(customer.status).toBe(200);
    expect(customer.body.must_change_password).toBe(true);
    expect((await request(ctx.app).post('/api/auth/login').send({ phone: '13900000009', password: 'wrong' })).status).toBe(401);
    expect((await request(ctx.app).post('/api/auth/login').send({ phone: '13900000009', code: '123456', invite_token: 'opaque-invite' })).status).toBe(401);
  });

  it('requires a first password change and invalidates the old session after changing it', async () => {
    const login = await request(ctx.app).post('/api/auth/login').send({ phone: '13900000009', password });
    expect(login.status).toBe(200);
    const session = cookie(login);
    expect((await request(ctx.app).get('/api/client/jobs/1').set('Cookie', session)).status).toBe(403);
    const changed = await request(ctx.app).post('/api/auth/change-password').set('Cookie', session).send({ current_password: password, new_password: 'new-phase2-password' });
    expect(changed.status).toBe(200);
    expect((await request(ctx.app).get('/api/client/jobs/1').set('Cookie', session)).status).toBe(401);
    const renewedSession = cookie(changed);
    expect(renewedSession).toBeTruthy();
    expect((await request(ctx.app).get('/api/client/jobs/1').set('Cookie', renewedSession)).status).toBe(200);
    const again = await request(ctx.app).post('/api/auth/login').send({ phone: '13900000009', password: 'new-phase2-password' });
    expect(again.status).toBe(200);
  });

  it('locks an account after five failures and unlocks only after the lock interval', async () => {
    for (let i = 0; i < 4; i++) expect((await request(ctx.app).post('/api/auth/login').send({ phone: '13900000009', password: 'wrong' })).status).toBe(401);
    expect((await request(ctx.app).post('/api/auth/login').send({ phone: '13900000009', password: 'wrong' })).status).toBe(423);
    const locked = await request(ctx.app).post('/api/auth/login').send({ phone: '13900000009', password });
    expect(locked.status).toBe(423);
    ctx.db.prepare("update customer set locked_until=datetime('now','-1 minute') where id=?").run(ctx.customer);
    expect((await request(ctx.app).post('/api/auth/login').send({ phone: '13900000009', password })).status).toBe(200);
  });

  it('allows only an admin to manage customers and staff, and enforces dynamic job ownership', async () => {
    const adminLogin = await request(ctx.app).post('/api/admin/login').send({ phone: '13800000009', password });
    const adminCookie = cookie(adminLogin);
    expect(adminLogin.status).toBe(200);
    expect(adminLogin.body.must_change_password).toBe(true);
    await request(ctx.app).post('/api/admin/change-password').set('Cookie', adminCookie).send({ current_password: password, new_password: 'new-admin-password' });
    const admin = await request(ctx.app).post('/api/admin/login').send({ phone: '13800000009', password: 'new-admin-password' });
    expect(admin.status).toBe(200);
    const adminSession = cookie(admin);
    const created = await request(ctx.app).post('/api/admin/customers').set('Cookie', adminSession).send({ name: 'Other', phone: '13900000010' });
    expect(created.status).toBe(201);
    expect((await request(ctx.app).get('/api/admin/staff').set('Cookie', adminSession)).status).toBe(200);
    const customerLogin = await request(ctx.app).post('/api/auth/login').send({ phone: '13900000009', password });
    expect((await request(ctx.app).get('/api/client/jobs/999').set('Cookie', cookie(customerLogin))).status).toBe(404);
  });
});
