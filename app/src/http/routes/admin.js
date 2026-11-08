import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { union } from '../../services/selection.js';
import { generateReadablePassword, suppliedPassword } from '../../services/credentials.js';
import { backupDatabase, backupStats, pruneBackups } from '../../services/backup.js';

export function registerAdmin(app, ctx) {
  const {
    db, cfg, now, event, requireActor, jsonError, issueSession, exportCsv,
    importPhotos, scanSourceDirectory, changePassword, staffStudio, ownedJob,
    adminOnly, err, authenticate, buildSummary,
  } = ctx;

  app.post('/api/admin/login', (req, res) => {
    const result = authenticate('staff', String(req.body.phone || ''), String(req.body.password || ''));
    if (result.error) return jsonError(res, result.error === 'ACCOUNT_LOCKED' ? 423 : 401, result.error, '账号或密码错误');
    const staff = result.account;
    issueSession(res, 'staff', staff.id, staff.password_version);
    res.json({ ok: true, must_change_password: Boolean(staff.must_change_password) });
  });
  app.post('/api/admin/change-password', requireActor('staff', { allowPasswordChange: true }), (req, res) => changePassword(req, res, 'staff'));

  app.get('/api/admin/settings', requireActor('staff'), (req, res) => {
    if (!adminOnly(req, res)) return;
    const stats = backupStats(cfg.dataDir);
    res.json({ settings: { data_dir: cfg.dataDir, ...stats } });
  });
  app.post('/api/admin/settings/backup', requireActor('staff'), async (req, res) => {
    if (!adminOnly(req, res)) return;
    try {
      const result = await backupDatabase(cfg.dataDir, { kind: 'manual' });
      res.json({ ok: true, backup: { database_path: result.databasePath, uploads_path: result.uploadsPath, ...backupStats(cfg.dataDir) } });
    } catch (error) {
      return jsonError(res, 400, 'BACKUP_FAILED', error.message);
    }
  });

  app.get('/api/admin/staff', requireActor('staff'), (req, res) => {
    if (!adminOnly(req, res)) return;
    res.json({ staff: db.prepare('select id,name,phone,role,status,must_change_password from staff where studio_id=?').all(staffStudio(req.actor).studio_id) });
  });
  app.get('/api/admin/customers', requireActor('staff'), (req, res) => {
    const q = String(req.query.q || '');
    res.json({ customers: db.prepare('select id,name,phone,status,must_change_password from customer where studio_id=? and (name like ? or phone like ?)').all(staffStudio(req.actor).studio_id, `%${q}%`, `%${q}%`) });
  });
  app.post('/api/admin/customers', requireActor('staff'), (req, res) => {
    const name = String(req.body.name || ''), phone = String(req.body.phone || '');
    if (!name || !/^1\d{10}$/.test(phone)) return jsonError(res, 400, 'INVALID_ACCOUNT', '客户姓名和手机号无效');
    const password = suppliedPassword(req.body.password) || generateReadablePassword(), t = now();
    try {
      const id = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_by,created_at,updated_at) values(?,?,?,?,?,?,?,?)').run(staffStudio(req.actor).studio_id, name, phone, bcrypt.hashSync(password, 10), 1, req.actor.actor_id, t, t).lastInsertRowid;
      res.status(201).json({ ok: true, password, customer: { id, name, phone } });
    } catch {
      return jsonError(res, 409, 'ACCOUNT_EXISTS', '客户账号已存在');
    }
  });
  app.patch('/api/admin/customers/:customerId', requireActor('staff'), (req, res) => {
    const c = db.prepare('select * from customer where id=? and studio_id=?').get(+req.params.customerId, staffStudio(req.actor).studio_id);
    if (!c) return jsonError(res, 404, 'NOT_FOUND', '客户不存在');
    const set = ['name', 'phone', 'status'].filter(key => req.body[key] !== undefined);
    if (set.length) db.prepare(`update customer set ${set.map(key => `${key}=?`).join(',')},updated_at=? where id=?`).run(...set.map(key => String(req.body[key])), now(), c.id);
    res.json({ customer: db.prepare('select id,name,phone,status,must_change_password from customer where id=?').get(c.id) });
  });
  app.post('/api/admin/customers/:customerId/reset-password', requireActor('staff'), (req, res) => {
    const c = db.prepare('select * from customer where id=? and studio_id=?').get(+req.params.customerId, staffStudio(req.actor).studio_id);
    if (!c) return jsonError(res, 404, 'NOT_FOUND', '客户不存在');
    const password = suppliedPassword(req.body.password) || generateReadablePassword();
    db.prepare('update customer set password_hash=?,must_change_password=1,password_version=password_version+1 where id=?').run(bcrypt.hashSync(password, 10), c.id);
    db.prepare("delete from session where actor_type='customer' and actor_id=?").run(c.id);
    res.json({ ok: true, password });
  });
  app.post('/api/admin/staff', requireActor('staff'), (req, res) => {
    if (!adminOnly(req, res)) return;
    const name = String(req.body.name || ''), phone = String(req.body.phone || ''), role = String(req.body.role || 'editor');
    if (!name || !/^1\d{10}$/.test(phone)) return jsonError(res, 400, 'INVALID_ACCOUNT', '员工姓名和手机号无效');
    const password = suppliedPassword(req.body.password) || generateReadablePassword();
    try {
      const id = db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values(?,?,?,?,?,1)').run(staffStudio(req.actor).studio_id, name, phone, role, bcrypt.hashSync(password, 10)).lastInsertRowid;
      res.status(201).json({ staff: { id, name, phone, role, status: 'active', must_change_password: 1 }, password });
    } catch {
      return jsonError(res, 409, 'ACCOUNT_EXISTS', '员工账号已存在');
    }
  });
  app.patch('/api/admin/staff/:staffId', requireActor('staff'), (req, res) => {
    if (!adminOnly(req, res)) return;
    const s = db.prepare('select * from staff where id=? and studio_id=?').get(+req.params.staffId, staffStudio(req.actor).studio_id);
    if (!s) return jsonError(res, 404, 'NOT_FOUND', '员工不存在');
    const keys = ['name', 'phone', 'role', 'status'].filter(key => req.body[key] !== undefined);
    if (keys.length) db.prepare(`update staff set ${keys.map(key => `${key}=?`).join(',')} where id=?`).run(...keys.map(key => String(req.body[key])), s.id);
    res.json({ staff: db.prepare('select id,name,phone,role,status,must_change_password from staff where id=?').get(s.id) });
  });
  app.post('/api/admin/staff/:staffId/reset-password', requireActor('staff'), (req, res) => {
    if (!adminOnly(req, res)) return;
    const s = db.prepare('select * from staff where id=? and studio_id=?').get(+req.params.staffId, staffStudio(req.actor).studio_id);
    if (!s) return jsonError(res, 404, 'NOT_FOUND', '员工不存在');
    const password = suppliedPassword(req.body.password) || generateReadablePassword();
    db.prepare('update staff set password_hash=?,must_change_password=1,password_version=password_version+1 where id=?').run(bcrypt.hashSync(password, 10), s.id);
    res.json({ ok: true, password });
  });

  app.get('/api/admin/jobs', requireActor('staff'), (req, res) => {
    const s = staffStudio(req.actor), status = String(req.query.status || ''), q = String(req.query.q || '');
    let jobs = db.prepare("select * from job where studio_id=? and (?='' or status=?) and (?='' or title like ?) order by id desc").all(s.studio_id, status, status, q, `%${q}%`);
    jobs = jobs.map(job => {
      const total = db.prepare("select count(*) count from selector where job_id=? and permission='select_submit'").get(job.id).count;
      const submitted = db.prepare("select count(*) count from selector where job_id=? and permission='select_submit' and submitted_at is not null").get(job.id).count;
      const unread = db.prepare("select count(*) count from photo_comment c where c.job_id=? and c.deleted_at is null and c.created_at>(select coalesce(max(last_read_at),'') from comment_read where job_id=? and reader_type='staff')").get(job.id, job.id).count;
      return { ...job, submitted_progress: { submitted, total }, merged_count: union(db, job.id).count, unread_comment_count: unread, expired: Boolean(job.deadline_at && job.deadline_at < now() && job.status !== 'locked') };
    });
    res.json({ jobs });
  });
  app.get('/api/admin/jobs/:id/summary', requireActor('staff'), (req, res) => ownedJob(req.params.id, req.actor) ? res.json(buildSummary(db, +req.params.id)) : jsonError(res, 404, 'NOT_FOUND', '任务不存在'));

  app.get('/api/admin/package-templates', requireActor('staff'), (req, res) => {
    const templates = db.prepare('select * from package_template where studio_id=?').all(staffStudio(req.actor).studio_id).map(template => ({ ...template, items: db.prepare('select * from package_template_item where template_id=?').all(template.id) }));
    res.json({ templates });
  });
  app.patch('/api/admin/package-templates/:templateId', requireActor('staff'), (req, res) => {
    const s = staffStudio(req.actor), template = db.prepare('select * from package_template where id=? and studio_id=?').get(+req.params.templateId, s.studio_id);
    if (!template) return jsonError(res, 404, 'NOT_FOUND', '模板不存在');
    if (req.body.name !== undefined) db.prepare('update package_template set name=? where id=?').run(String(req.body.name), template.id);
    res.json({ template: db.prepare('select * from package_template where id=?').get(template.id) });
  });
  app.delete('/api/admin/package-templates/:templateId', requireActor('staff'), (req, res) => {
    const s = staffStudio(req.actor), template = db.prepare('select * from package_template where id=? and studio_id=?').get(+req.params.templateId, s.studio_id);
    if (!template) return jsonError(res, 404, 'NOT_FOUND', '模板不存在');
    db.prepare('delete from package_template_item where template_id=?').run(template.id);
    db.prepare('delete from package_template where id=?').run(template.id);
    res.json({ ok: true });
  });
  app.post('/api/admin/package-templates', requireActor('staff'), (req, res) => {
    const id = db.prepare('insert into package_template(studio_id,name) values(?,?)').run(staffStudio(req.actor).studio_id, String(req.body.name || '套餐')).lastInsertRowid;
    (req.body.items || []).forEach((item, index) => db.prepare('insert into package_template_item(template_id,name,kind,quantity,sort) values(?,?,?,?,?)').run(id, String(item.name || ''), String(item.kind || 'retouch'), Number(item.quantity) || 0, index));
    res.status(201).json({ template: { id, name: String(req.body.name || '套餐'), items: db.prepare('select * from package_template_item where template_id=?').all(id) } });
  });

  app.patch('/api/admin/jobs/:id/publish', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    db.prepare("update job set status='selecting' where id=?").run(job.id);
    event(job.id, 'job.status', req.actor, { status: 'selecting' });
    db.prepare("insert into notification(job_id,selector_id,kind,content,sent_at) select job_id,id,'publish','任务已发布',? from selector where job_id=?").run(now(), job.id);
    db.prepare('insert into audit_log(job_id,actor_type,actor_id,action,payload,created_at) values(?,?,?,?,?,?)').run(job.id, 'staff', req.actor.actor_id, 'publish', JSON.stringify({ status: 'selecting' }), now());
    res.json({ job: db.prepare('select * from job where id=?').get(job.id) });
  });
  app.post('/api/admin/jobs', requireActor('staff'), (req, res) => {
    const s = staffStudio(req.actor), deadline = String(req.body.deadline_at || new Date(Date.now() + 86400000).toISOString());
    const id = db.prepare("insert into job(studio_id,title,status,deadline_at,invite_token,created_by) values(?,?,'draft',?,?,?)").run(s.studio_id, String(req.body.title || '任务'), deadline, crypto.randomBytes(16).toString('hex'), req.actor.actor_id).lastInsertRowid;
    if (req.body.template_id) db.prepare('insert into job_item(job_id,name,kind,quantity,sort) select ?,name,kind,quantity,sort from package_template_item where template_id=?').run(id, +req.body.template_id);
    res.status(201).json({ job: { ...db.prepare('select * from job where id=?').get(id), items: db.prepare('select * from job_item where job_id=?').all(id) } });
  });
  app.patch('/api/admin/jobs/:id', requireActor('staff'), (req, res) => {
    try {
      if (!ownedJob(req.params.id, req.actor)) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
      const keys = ['allow_preview_download', 'allow_original_download', 'original_download_scope', 'title', 'deadline_at'].filter(key => req.body[key] !== undefined);
      if (keys.length) db.prepare(`update job set ${keys.map(key => `${key}=?`).join(',')} where id=?`).run(...keys.map(key => typeof req.body[key] === 'boolean' ? Number(req.body[key]) : req.body[key]), +req.params.id);
      res.json({ job: db.prepare('select * from job where id=?').get(+req.params.id) });
    } catch (error) {
      return jsonError(res, 400, 'INVALID_JOB', error.message);
    }
  });
  app.get('/api/admin/jobs/:id/selectors', requireActor('staff'), (req, res) => ownedJob(req.params.id, req.actor) ? res.json({ selectors: db.prepare('select * from selector where job_id=?').all(+req.params.id) }) : jsonError(res, 404, 'NOT_FOUND', '任务不存在'));
  app.post('/api/admin/jobs/:id/selectors', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const customer = req.body.customer_id === undefined ? null : db.prepare('select id,name,phone from customer where id=? and studio_id=?').get(+req.body.customer_id, job.studio_id);
    if (req.body.customer_id !== undefined && !customer) return jsonError(res, 404, 'NOT_FOUND', '客户不存在');
    const id = db.prepare('insert into selector(job_id,customer_id,name,phone,permission) values(?,?,?,?,?)').run(+req.params.id, customer?.id || null, String(req.body.name || customer?.name || ''), String(req.body.phone || customer?.phone || ''), String(req.body.permission || 'select_submit')).lastInsertRowid;
    res.status(201).json({ selector: db.prepare('select * from selector where id=?').get(id) });
  });
  app.get('/api/admin/jobs/:id/photos', requireActor('staff'), (req, res) => {
    if (!ownedJob(req.params.id, req.actor)) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    res.json({ photos: db.prepare('select * from photo where job_id=? order by sort,id').all(+req.params.id) });
  });
  app.patch('/api/admin/jobs/:id/photos/:photoId', requireActor('staff'), (req, res) => {
    if (!ownedJob(req.params.id, req.actor)) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const photo = db.prepare('select id from photo where id=? and job_id=?').get(+req.params.photoId, +req.params.id);
    if (!photo) return jsonError(res, 404, 'NOT_FOUND', '照片不存在');
    if (req.body.hidden !== undefined) db.prepare('update photo set hidden=? where id=?').run(req.body.hidden ? 1 : 0, photo.id);
    res.json({ ok: true, photo: db.prepare('select * from photo where id=?').get(photo.id) });
  });
  app.patch('/api/admin/jobs/:id/selectors/:selectorId', requireActor('staff'), (req, res) => {
    if (!ownedJob(req.params.id, req.actor)) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const selector = db.prepare('select * from selector where id=? and job_id=?').get(+req.params.selectorId, +req.params.id);
    if (!selector) return jsonError(res, 404, 'NOT_FOUND', '选片人不存在');
    const allowed = ['name', 'permission', 'share_selection', 'can_change_share'].filter(key => req.body[key] !== undefined);
    if (allowed.length) db.prepare(`update selector set ${allowed.map(key => `${key}=?`).join(',')} where id=?`).run(...allowed.map(key => typeof req.body[key] === 'boolean' ? Number(req.body[key]) : req.body[key]), selector.id);
    res.json({ selector: db.prepare('select * from selector where id=?').get(selector.id) });
  });
  app.delete('/api/admin/jobs/:id/selectors/:selectorId', requireActor('staff'), (req, res) => {
    if (!ownedJob(req.params.id, req.actor)) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const selector = db.prepare('select * from selector where id=? and job_id=?').get(+req.params.selectorId, +req.params.id);
    if (!selector) return jsonError(res, 404, 'NOT_FOUND', '选片人不存在');
    const has = db.prepare('select 1 from selection where selector_id=? limit 1').get(selector.id);
    if (has && !req.body.confirm) return jsonError(res, 409, 'CONFIRM_REQUIRED', '该选片人已有选片，请确认移除');
    db.prepare('delete from selection where selector_id=?').run(selector.id);
    db.prepare('delete from slot_assignment where selector_id=?').run(selector.id);
    db.prepare('delete from selector where id=?').run(selector.id);
    res.json({ ok: true });
  });

  app.get('/api/admin/jobs/:id/comments', requireActor('staff'), (req, res) => {
    if (!ownedJob(req.params.id, req.actor)) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    res.json({ comments: db.prepare('select * from photo_comment where job_id=? order by photo_id,created_at,id').all(+req.params.id) });
  });
  app.post('/api/admin/jobs/:id/comments/read', requireActor('staff'), (req, res) => {
    if (!ownedJob(req.params.id, req.actor)) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    db.prepare('insert into comment_read(reader_type,reader_id,job_id,last_read_at) values(?,?,?,?) on conflict(reader_type,reader_id,job_id) do update set last_read_at=excluded.last_read_at').run('staff', req.actor.actor_id, +req.params.id, now());
    res.json({ ok: true });
  });

  app.get('/api/admin/source-dirs', requireActor('staff'), (req, res) => {
    const root = path.resolve(cfg.photoSourceDir);
    res.json({ directories: fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) });
  });
  app.post('/api/admin/jobs/:id/imports', requireActor('staff'), (req, res) => {
    if (!ownedJob(req.params.id, req.actor)) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const root = path.resolve(cfg.photoSourceDir), source = path.resolve(root, String(req.body.source || ''));
    let realSource;
    try {
      realSource = fs.realpathSync(source);
      const relative = path.relative(fs.realpathSync(root), realSource);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(realSource).isDirectory()) return jsonError(res, 400, 'INVALID_SOURCE', '导入目录无效');
    } catch {
      return jsonError(res, 400, 'INVALID_SOURCE', '导入目录无效');
    }
    const relative = path.relative(fs.realpathSync(root), realSource) || '.';
    const id = db.prepare("insert into import_task(job_id,source,status,created_at) values(?,?,?,'')").run(+req.params.id, relative, 'pending').lastInsertRowid;
    db.prepare('update import_task set created_at=? where id=?').run(now(), id);
    const taskId = Number(id);
    setImmediate(async () => {
      try {
        db.prepare("update import_task set status='processing',total=? where id=?").run(scanSourceDirectory(realSource).length, taskId);
        const result = await importPhotos({ db, jobId: +req.params.id, sourceDir: realSource, dataDir: cfg.dataDir, watermarkText: cfg.watermarkText, onProgress: ({ processed, failed }) => db.prepare('update import_task set processed=?,failed=? where id=?').run(processed, failed, taskId) });
        db.prepare("update import_task set status='completed',total=?,processed=?,failed=?,finished_at=? where id=?").run(result.total, result.total, result.failed, now(), taskId);
      } catch {
        db.prepare("update import_task set status='failed',errors=?,finished_at=? where id=?").run('IMPORT_FAILED', now(), taskId);
      }
    });
    res.status(202).json({ import_task: { id: taskId, status: 'pending', source: relative } });
  });
  app.get('/api/admin/jobs/:id/imports/:taskId', requireActor('staff'), (req, res) => {
    if (!ownedJob(req.params.id, req.actor)) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const task = db.prepare('select id,job_id,status,total,processed,failed,errors from import_task where id=? and job_id=?').get(+req.params.taskId, +req.params.id);
    return task ? res.json({ import_task: task }) : jsonError(res, 404, 'NOT_FOUND', '导入任务不存在');
  });
  app.post('/api/admin/jobs/:id/import', requireActor('staff'), async (req, res) => {
    try {
      if (!ownedJob(req.params.id, req.actor)) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
      res.json(await importPhotos({ db, jobId: +req.params.id, sourceDir: cfg.photoSourceDir, dataDir: cfg.dataDir, watermarkText: cfg.watermarkText }));
    } catch (error) {
      err(error, res);
    }
  });

  app.post('/api/admin/jobs/:id/remind', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const sentAt = now();
    db.prepare("insert into notification(job_id,selector_id,kind,content,sent_at) select job_id,id,'remind','请完成选片',? from selector where job_id=? and submitted_at is null").run(sentAt, job.id);
    db.prepare('insert into audit_log(job_id,actor_type,actor_id,action,payload,created_at) values(?,?,?,?,?,?)').run(job.id, 'staff', req.actor.actor_id, 'remind', JSON.stringify({ sent_at: sentAt }), sentAt);
    res.json({ ok: true });
  });
  app.post('/api/admin/jobs/:id/settle', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const settledAt = now();
    db.prepare('update job set overage_settled=1,updated_at=? where id=?').run(settledAt, job.id);
    db.prepare('insert into audit_log(job_id,actor_type,actor_id,action,payload,created_at) values(?,?,?,?,?,?)').run(job.id, 'staff', req.actor.actor_id, 'settle', JSON.stringify({ settled_at: settledAt }), settledAt);
    res.json({ ok: true, job: db.prepare('select * from job where id=?').get(job.id) });
  });
  app.post('/api/admin/jobs/:id/reopen', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const reason = String(req.body.reason || '').trim();
    db.prepare("update job set status='selecting',overage_settled=0,updated_at=? where id=?").run(now(), job.id);
    db.prepare("insert into notification(job_id,selector_id,kind,content,sent_at) select job_id,id,'reopen',?,? from selector where job_id=?").run(reason ? `任务已退回修改：${reason}` : '任务已退回修改', now(), job.id);
    event(job.id, 'job.status', req.actor, { status: 'selecting', reason });
    res.json({ ok: true, job: db.prepare('select * from job where id=?').get(job.id) });
  });
  app.get('/api/admin/jobs/:id/notifications', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    res.json({ notifications: db.prepare('select * from notification where job_id=? order by id desc').all(job.id) });
  });
  app.get('/api/admin/settlement', requireActor('staff'), (req, res) => res.json({ jobs: db.prepare('select * from job where studio_id=? order by id desc').all(staffStudio(req.actor).studio_id) }));
  app.get('/api/admin/audit-logs', requireActor('staff'), (req, res) => {
    const studioId = staffStudio(req.actor).studio_id;
    const requested = req.query.job_id === undefined ? null : Number(req.query.job_id);
    if (requested !== null && (!Number.isInteger(requested) || !ownedJob(requested, req.actor))) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const logs = requested === null
      ? db.prepare("select a.* from audit_log a left join job j on j.id=a.job_id where (j.studio_id=? or (a.job_id is null and a.actor_type='staff' and exists (select 1 from staff s where s.id=a.actor_id and s.studio_id=?))) order by a.id desc").all(studioId, studioId)
      : db.prepare('select a.* from audit_log a join job j on j.id=a.job_id where j.studio_id=? and a.job_id=? order by a.id desc').all(studioId, requested);
    res.json({ logs });
  });
  app.get('/api/admin/jobs/:id/export.csv', requireActor('staff'), (req, res) => ownedJob(req.params.id, req.actor) ? res.set('Content-Type', 'text/csv; charset=utf-8').send(exportCsv(db, +req.params.id)) : jsonError(res, 404, 'NOT_FOUND', '任务不存在'));
  app.post('/api/admin/jobs/:id/lock', requireActor('staff'), (req, res) => {
    const jobId = +req.params.id, staff = db.prepare('select studio_id from staff where id=?').get(req.actor.actor_id);
    const changed = db.prepare("update job set status='locked',locked_at=?,locked_by=? where id=? and studio_id=?").run(now(), req.actor.actor_id, jobId, staff?.studio_id);
    if (!changed.changes) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    event(jobId, 'job.status', req.actor, { status: 'locked' });
    res.json({ ok: true });
  });
}
