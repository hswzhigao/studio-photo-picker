import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { getDb, initializeDatabase } from '../src/db/connection.js';
import { purgeExpiredTrash } from '../src/services/photoManager.js';

const jpeg = color => sharp({ create: { width: 24, height: 30, channels: 3, background: color } }).jpeg().toBuffer();
describe('retouched delivery', () => {
  let db, app, root, admin, client, job, other, foreign;
  const base = id => `/api/admin/jobs/${id}/retouched`;
  const cb = id => `/api/client/jobs/${id}/retouched`;
  const upload = (bytes, query = '', id = job, name = 'one.jpg') => admin.post(base(id) + query).attach('photo', bytes, name);
  const publish = id => admin.post(base(job) + '/publish').send({ ids: [id] });
  const photo = id => db.prepare('select * from retouched_photo where id=?').get(id);
  beforeEach(() => {
    db = getDb(':memory:'); initializeDatabase(db);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'retouched-test-'));
    db.exec(`insert into studio(id,name,watermark_text,sms_sign) values(1,'S','W','S'),(2,'T','W','S');
      insert into staff(id,studio_id,name,phone,role,password_hash,must_change_password) values(1,1,'A','1','admin','hash',0);
      insert into customer(id,studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values(1,1,'C','2','hash',0,'now','now');
      insert into job(id,studio_id,title,deadline_at,invite_token,created_by) values(1,1,'J','now','j1',1),(2,1,'K','now','j2',1),(3,2,'L','now','j3',1);
      insert into selector(job_id,customer_id,name,phone,permission) values(1,1,'C','2','select_submit');
      insert into session(token,actor_type,actor_id,password_version,created_at,expires_at) values('staff','staff',1,0,'now','2099-01-01'),('client','customer',1,0,'now','2099-01-01');`);
    db.exec("update job set status='selecting'");
    job = 1; other = 2; foreign = 3;
    app = createApp({ db, cfg: { dataDir: root, photoSourceDir: root } });
    admin = request.agent(app).set('Cookie', 'session=staff');
    client = request.agent(app).set('Cookie', 'session=client');
  });
  afterEach(async () => {
    app.locals.stopBackgroundTasks(); await app.locals.waitForTasks();
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  it('uploads a private draft then publishes without changing original photos or job status', async () => {
    const bytes = await jpeg('#112233');
    const r = await upload(bytes); expect(r.status).toBe(201);
    const p = r.body.photo;
    expect(p).toMatchObject({ version: 1, status: 'ready', width: 24, height: 30, size_bytes: bytes.length });
    expect(JSON.stringify(p)).not.toContain(root);
    const uploadEvent = db.prepare("select payload from change_event where kind='retouched.uploaded'").get();
    expect(JSON.parse(uploadEvent.payload)).toMatchObject({retouched_photo_id:p.id,asset_id:p.asset_id,version:1});
    expect((await client.get(cb(job))).body.photos).toEqual([]);
    for (const kind of ['thumb', 'original', 'download']) await client.get(`${cb(job)}/${p.id}/${kind}`).expect(404);
    await publish(p.id).expect(200);
    const list = await client.get(cb(job)); expect(list.body.photos.map(p => p.id)).toEqual([p.id]);
    const media = await client.get(`${cb(job)}/${p.id}/download`).expect(200);
    expect(media.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.compare(media.body, bytes)).toBe(0);
    expect(crypto.createHash('sha256').update(media.body).digest('hex')).toBe(p.sha256);
    expect(db.prepare('select count(*) n from photo').get().n).toBe(0);
    expect(db.prepare('select status from job where id=1').get().status).toBe('selecting');
  });
  it.each([1, 7])('keeps retouched lifecycle changes private for selector %i across draft and published history', async selectorId => {
    db.prepare('update selector set id=? where job_id=?').run(selectorId, job);
    const changes = `/api/client/jobs/${job}/changes`;
    const expectPrivateChanges = async () => {
      const response = await client.get(changes).expect(200);
      expect(response.body.events).toEqual([]);
    };
    const a = (await upload(await jpeg('#151515')).expect(201)).body.photo;
    expect((await client.get(cb(job)).expect(200)).body.photos).toEqual([]);
    await expectPrivateChanges();
    await admin.patch(`${base(job)}/${a.id}`).send({ photo_id: null }).expect(200);
    await expectPrivateChanges();
    await publish(a.id).expect(200);
    await client.get(`${cb(job)}/${a.id}`).expect(200);
    await expectPrivateChanges();
    const b = (await upload(await jpeg('#161616'), `?asset_id=${a.asset_id}`).expect(201)).body.photo;
    await publish(b.id).expect(200);
    const current = (await client.get(cb(job)).expect(200)).body.photos[0];
    expect(current.id).toBe(b.id);
    expect(current.versions.map(version => version.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    await client.get(`${cb(job)}/${a.id}`).expect(200);
    await expectPrivateChanges();
    await admin.post(base(job) + '/withdraw').send({ ids: [b.id] }).expect(200);
    await client.get(`${cb(job)}/${b.id}`).expect(404);
    expect((await client.get(cb(job)).expect(200)).body.photos[0].id).toBe(a.id);
    await expectPrivateChanges();
    await client.get(`/api/client/jobs/${other}/changes`).expect(404);
    const staffChanges = await admin.get(`/api/admin/jobs/${job}/changes`).expect(200);
    expect(staffChanges.body.events.map(event => event.kind)).toEqual([
      'retouched.uploaded', 'retouched.paired', 'retouched.published',
      'retouched.uploaded', 'retouched.published', 'retouched.withdrawn',
    ]);
  });
  it('serves original images inline and every media representation without caching', async () => {
    const bytes = await jpeg('#102030');
    const p = (await upload(bytes)).body.photo;
    await publish(p.id).expect(200);
    for (const agent of [admin, client]) {
      const prefix = agent === admin ? base(job) : cb(job);
      const original = await agent.get(`${prefix}/${p.id}/original`).expect(200);
      expect(original.headers['content-disposition']).toMatch(/^inline;/);
      expect(original.headers['content-type']).toMatch(/^image\/jpeg/);
      expect(original.headers['cache-control']).toBe('private, no-store');
      expect(original.body).toEqual(bytes);
      const thumb = await agent.get(`${prefix}/${p.id}/thumb`).expect(200);
      expect(thumb.headers['content-type']).toMatch(/^image\/webp/);
      expect(thumb.headers['cache-control']).toBe('private, no-store');
    }
  });
  it('rejects structured photo IDs instead of coercing array query parameters', async () => {
    db.exec("insert into photo(id,job_id,filename,original_key,import_status) values(3,1,'x','x','ready')");
    await upload(await jpeg('#203040'), '?photo_id[]=3').expect(400);
    const p = (await upload(await jpeg('#304050'))).body.photo;
    await admin.patch(`${base(job)}/${p.id}`).send({photo_id:[3]}).expect(400);
    expect(photo(p.id).photo_id).toBeNull();
  });
  it('keeps asset history, scoped hashes, consistent pairing and falls back after withdrawal', async () => {
    const bytes = await jpeg('#223344'); const a = (await upload(bytes)).body.photo;
    await publish(a.id).expect(200);
    expect((await upload(bytes)).status).toBe(409);
    expect((await upload(bytes, '', other)).status).toBe(201);
    const b = (await upload(await jpeg('#334455'), `?asset_id=${a.asset_id}`)).body.photo;
    expect(b).toMatchObject({ asset_id: a.asset_id, version: 2 });
    expect((await client.get(cb(job))).body.photos[0].id).toBe(a.id);
    await publish(b.id).expect(200);
    const current = (await client.get(cb(job))).body.photos[0]; expect(current.id).toBe(b.id); expect(current.versions).toHaveLength(2);
    await client.get(`${cb(job)}/${a.id}/original`).expect(200);
    await admin.patch(`${base(job)}/${b.id}`).send({ photo_id: null }).expect(409);
    await admin.post(base(job) + '/withdraw').send({ ids: [b.id] }).expect(200);
    await client.get(`${cb(job)}/${b.id}`).expect(404);
    expect((await client.get(cb(job))).body.photos[0].id).toBe(a.id);
    await publish(b.id).expect(200);
    expect((await client.get(cb(job))).body.photos[0].id).toBe(b.id);
  });
  it('repairs pairing after withdrawal and republishes the same version', async () => {
    db.exec("insert into photo(id,job_id,filename,original_key,import_status,hidden) values(1,1,'pre','pre','ready',0)");
    const a = (await upload(await jpeg('#eeaa01'))).body.photo;
    await publish(a.id).expect(200);
    await admin.patch(`${base(job)}/${a.id}`).send({ photo_id: 1 }).expect(409);
    await admin.post(base(job) + '/withdraw').send({ ids: [a.id] }).expect(200);
    expect(photo(a.id).status).toBe('ready');
    await admin.patch(`${base(job)}/${a.id}`).send({ photo_id: 1 }).expect(200);
    await publish(a.id).expect(200);
    const current = (await client.get(cb(job))).body.photos[0];
    expect(current).toMatchObject({ id: a.id, photo_id: 1, before_url: '/media/previews/1.webp' });
  });
  it('rejects unauthorized jobs, invalid associations and invalid atomic batches', async () => {
    await upload(await jpeg('#445566'), '', foreign).expect(404);
    await client.get(cb(other)).expect(404);
    await request(app).get(cb(job)).expect(401);
    db.exec("insert into photo(id,job_id,filename,original_key,hidden) values(1,2,'x','x',0),(2,1,'y','y',1),(3,1,'z','z',0)");
    for (const id of [1,2,999]) await upload(await jpeg('#556677'), `?photo_id=${id}`).expect(400);
    db.exec("update photo set import_status='ready'");
    const a = (await upload(await jpeg('#667788'), '?photo_id=3').expect(201)).body.photo;
    await upload(await jpeg('#778899'), `?asset_id=${a.asset_id}&photo_id=1`).expect(400);
    const b = (await upload(await jpeg('#8899aa'), `?asset_id=${a.asset_id}`)).body.photo;
    expect(b.photo_id).toBe(3);
    await admin.patch(`${base(job)}/${b.id}`).send({ photo_id: null }).expect(200);
    expect(photo(a.id).photo_id).toBeNull();
    for (const ids of [[], [a.id, 999], ['1'], [0], Array(101).fill(a.id)]) {
      const r = await admin.post(base(job) + '/publish').send({ ids }); expect(r.status).toBeGreaterThanOrEqual(400);
      expect(photo(a.id).status).toBe('ready');
    }
    await admin.post(base(job) + '/publish').send({ ids: [a.id, a.id] }).expect(200);
  });
  it('rejects invalid image data and cleans files on audit failure', async () => {
    await upload(Buffer.from('fake')).expect(400);
    await upload(await jpeg('#abcdef'), '', job, 'file.gif').expect(400);
    db.exec("create trigger fail_audit before insert on audit_log begin select raise(abort,'audit failed'); end");
    await upload(await jpeg('#123456')).expect(500);
    expect(db.prepare('select count(*) n from retouched_photo').get().n).toBe(0);
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([]);
    const files = fs.readdirSync(path.join(root, 'uploads', 'retouched'), { recursive: true }).filter(f => /\.(jpg|webp|upload)$/.test(f));
    expect(files).toEqual([]);
  });
  it('rolls back publish, withdraw and pairing when audit fails', async () => {
    const a = (await upload(await jpeg('#aabbcc'))).body.photo;
    db.exec("create trigger fail_audit before insert on audit_log begin select raise(abort,'audit failed'); end");
    await publish(a.id).expect(500); expect(photo(a.id).status).toBe('ready');
    expect(db.prepare("select count(*) n from change_event where kind='retouched.published'").get().n).toBe(0);
    db.exec('drop trigger fail_audit'); await publish(a.id).expect(200);
    db.exec("create trigger fail_audit before insert on audit_log begin select raise(abort,'audit failed'); end");
    await admin.post(base(job) + '/withdraw').send({ ids: [a.id] }).expect(500);
    expect(photo(a.id).status).toBe('published');
  });
  it('rejects escaped media paths and streams only current ZIP members with safe unique names', async () => {
    const a = (await upload(await jpeg('#aa0000'))).body.photo; await publish(a.id);
    const b = (await upload(await jpeg('#bb0000'), `?asset_id=${a.asset_id}`)).body.photo; await publish(b.id);
    const d = (await upload(await jpeg('#cc0000'))).body.photo; await publish(d.id);
    const zip = await client.get(cb(job) + '/download-all').buffer(true).parse((res, done) => { const chunks=[]; res.on('data', b=>chunks.push(b)); res.on('end',()=>done(null,Buffer.concat(chunks))); }).expect(200);
    const names=[]; for(let i=0;i<zip.body.length-46;i++) if(zip.body.readUInt32LE(i)===0x02014b50){const len=zip.body.readUInt16LE(i+28); names.push(zip.body.subarray(i+46,i+46+len).toString());}
    expect(names).toEqual(['one.jpg','one-2.jpg']);
    const hashes=[];
    for(let i=0;i<zip.body.length-46;i++) if(zip.body.readUInt32LE(i)===0x02014b50){
      expect(zip.body.readUInt16LE(i+10)).toBe(0); // ZIP STORE, no recompression.
      const size=zip.body.readUInt32LE(i+20),offset=zip.body.readUInt32LE(i+42);
      const start=offset+30+zip.body.readUInt16LE(offset+26)+zip.body.readUInt16LE(offset+28);
      hashes.push(crypto.createHash('sha256').update(zip.body.subarray(start,start+size)).digest('hex'));
    }
    expect(hashes).toEqual([b.sha256,d.sha256]);
    const outside = path.join(root, 'outside.jpg'); fs.writeFileSync(outside, await jpeg('#dd0000'));
    const link = path.join(root, 'uploads', 'retouched', 'escape.jpg'); fs.symlinkSync(outside, link);
    db.prepare('update retouched_photo set file_key=? where id=?').run(link,b.id);
    await client.get(`${cb(job)}/${b.id}/original`).expect(404);
    await client.get(cb(job) + '/download-all').expect(404);
  });
  it('preserves PNG bytes, validates full image decoding and emits safe before links', async () => {
    db.exec("insert into photo(id,job_id,filename,original_key,import_status) values(3,1,'x','x','ready')");
    const bytes = await sharp({create:{width:20,height:25,channels:4,background:'#123456'}}).png().toBuffer();
    const p = (await upload(bytes, '?photo_id=3', job, '精修.png').expect(201)).body.photo;
    expect(p).toMatchObject({width:20,height:25,before_url:'/media/previews/3.webp',filename:'精修.png'});
    await publish(p.id).expect(200);
    const original = await client.get(`${cb(job)}/${p.id}/original`).expect(200);
    expect(original.headers['content-type']).toMatch(/^image\/png/);
    expect(original.body).toEqual(bytes);
    expect((await client.get(cb(job)).set('User-Agent','MicroMessenger')).body.wechat).toBe(true);
    db.exec('update photo set hidden=1 where id=3');
    expect((await client.get(`${cb(job)}/${p.id}`)).body.photo.before_url).toBeNull();
    const jpg = await jpeg('#124578');
    await upload(jpg.subarray(0, Math.floor(jpg.length*0.6))).expect(400);
  });
  it('scopes individual versions, new-version uploads and batches to the owning job and studio', async () => {
    const p = (await upload(await jpeg('#456789'))).body.photo;
    const q = (await upload(await jpeg('#56789a'), '', other)).body.photo;
    for (const suffix of ['', '/thumb', '/original', '/download']) {
      await admin.get(`${base(other)}/${p.id}${suffix}`).expect(404);
      await admin.get(`${base(foreign)}/${p.id}${suffix}`).expect(404);
    }
    await upload(await jpeg('#6789ab'), `?asset_id=${p.asset_id}`, other).expect(400);
    await admin.post(base(job)+'/publish').send({ids:[p.id,q.id]}).expect(404);
    expect(photo(p.id).status).toBe('ready');
    await publish(p.id).expect(200);
    for (const suffix of ['', '/thumb', '/original', '/download']) await client.get(`${cb(other)}/${p.id}${suffix}`).expect(404);
    await admin.post(base(job)+'/withdraw').send({ids:[p.id]}).expect(200);
    for (const suffix of ['', '/thumb', '/original', '/download']) await client.get(`${cb(job)}/${p.id}${suffix}`).expect(404);
  });
  it('atomically rolls back asset-wide association changes on audit failure', async () => {
    db.exec("insert into photo(id,job_id,filename,original_key,import_status) values(3,1,'x','x','ready')");
    const a = (await upload(await jpeg('#789abc'))).body.photo;
    const b = (await upload(await jpeg('#89abcd'), `?asset_id=${a.asset_id}`)).body.photo;
    db.exec("create trigger fail_audit before insert on audit_log begin select raise(abort,'audit failed'); end");
    await admin.patch(`${base(job)}/${a.id}`).send({photo_id:3}).expect(500);
    expect(photo(a.id).photo_id).toBeNull(); expect(photo(b.id).photo_id).toBeNull();
    expect(db.prepare("select count(*) n from change_event where kind='retouched.paired'").get().n).toBe(0);
  });
  it('bounds concurrent upload processing and releases capacity after completion', async () => {
    const bytes=await jpeg('#121212');
    const results=await Promise.all(Array.from({length:8},(_,i)=>upload(bytes, '', job, `${i}.jpg`)));
    expect(results.some(r=>r.status===429)).toBe(true);
    expect(results.every(r=>[201,409,429].includes(r.status))).toBe(true);
    await upload(await jpeg('#131313')).expect(201);
  });
  it('enforces 50 MiB and leaves no temporary upload on rejection', async () => {
    const bytes = Buffer.alloc(50 * 1024 * 1024 + 1, 0);
    const r = await upload(bytes); expect(r.status).toBe(400); expect(r.body.error.code).toBe('UPLOAD_TOO_LARGE');
    expect(fs.readdirSync(path.join(root,'tmp'))).toEqual([]);
  });
  it('rejects a concurrent ZIP and destroys a ZIP when a member is withdrawn mid-stream', async () => {
    const noise = crypto.randomBytes(2048*2048*3);
    const bytes = await sharp(noise,{raw:{width:2048,height:2048,channels:3}}).png().toBuffer();
    const a=(await upload(bytes,'',job,'large.png').expect(201)).body.photo; await publish(a.id).expect(200);
    const server=app.listen(0); let response;
    try {
      const started = new Promise((resolve,reject)=> {
        http.get({host:'127.0.0.1',port:server.address().port,path:cb(job)+'/download-all',headers:{Cookie:'session=client'}},res=>{response=res;res.pause();resolve();}).on('error',reject);
      });
      await started;
      await client.get(cb(job)+'/download-all').expect(429);
      let ended=false; const closed=new Promise(resolve=>{response.on('end',()=>{ended=true;resolve();});response.on('aborted',resolve);response.on('error',resolve);});
      await admin.post(base(job)+'/withdraw').send({ids:[a.id]}).expect(200);
      response.resume(); await closed; expect(ended).toBe(false);
    } finally {response?.destroy();await new Promise(resolve=>server.close(resolve));}
  });
  it('keeps associated originals and retouched records when trash expires', async () => {
    db.exec("insert into photo(id,job_id,filename,original_key,deleted_at) values(1,1,'x','x',null)");
    db.exec("update photo set import_status='ready'");
    const a = (await upload(await jpeg('#999999'), '?photo_id=1').expect(201)).body.photo;
    db.exec("update photo set deleted_at='2000-01-01' where id=1");
    expect(purgeExpiredTrash(db, { dataDir: root })).toBe(0);
    expect(photo(a.id)).toBeTruthy(); expect(db.prepare('select id from photo where id=1').get()).toBeTruthy();
  });
});
