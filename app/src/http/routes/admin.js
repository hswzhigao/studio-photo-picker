import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { union } from '../../services/selection.js';
import { generateReadablePassword, suppliedPassword } from '../../services/credentials.js';
import { backupDatabase, backupStats, pruneBackups } from '../../services/backup.js';
import { photoImpact, softDeletePhoto, restorePhoto, photoView, normalizeDisplayName, decodeOriginalName, readImageMetadata, sha256File, extensionForFormat, moveOriginalToUploads, moveOriginalToTrash, processPhoto } from '../../services/photoManager.js';
import { normalizePhotoFilter, photoFilterCondition, photoFilterCounts, photoQuotaSummary, selectedByForPhotos, slotsForPhotos } from '../../services/photoFilters.js';
import { buildAdminExport, adminExportView, resolveExportPhotos, sanitizeOrderName, beijingDateStamp, nextExportName } from '../../services/adminExport.js';

export function registerAdmin(app, ctx) {
  const {
    db, cfg, now, event, requireActor, jsonError, issueSession, exportCsv, loginGuard,
    importPhotos, scanSourceDirectory, changePassword, staffStudio, ownedJob,
    adminOnly, err, authenticate, buildSummary, photoUpload, photoQueue, trackTask,
    safeFile, privateHeaders, downloadHeaders,
  } = ctx;

  const lockedStatuses = ['locked', 'retouching', 'delivered'];
  const photoInJob = (jobId, photoId, includeDeleted = false) => db.prepare(`select * from photo where id=? and job_id=?${includeDeleted ? '' : ' and deleted_at is null'}`).get(photoId, jobId);
  const isPhotoLocked = (job, photoId) => lockedStatuses.includes(job.status) && Boolean(db.prepare('select 1 from selection where photo_id=?').get(photoId));
  const removeTemp = file => { if (file?.path) { try { fs.rmSync(file.path, { force: true }); } catch {} } };
  const impactMessage = impact => {
    const parts = [];
    if (impact.selectors.length) parts.push(`${impact.selectors.map(s => s.name).join('、')} 选了这张`);
    if (impact.comment_count) parts.push(`${impact.comment_count} 条评论`);
    if (impact.slot_items.length) parts.push(`被指定为 ${impact.slot_items.map(i => i.name).join('、')}`);
    return parts.join('；') || '这张照片还没有人选择或评论';
  };
  const photoSelectSql = `select p.*,
    coalesce(sel.selected_count,0) selected_count,
    coalesce(slot.slot_count,0) slot_count,
    coalesce(slot.slot_names,'') slot_names,
    coalesce(cmt.comment_count,0) comment_count,
    coalesce(note.note_count,0) note_count,
    (select count(*) from photo_comment c where c.photo_id=p.id and c.deleted_at is null
      and c.created_at > coalesce((select max(last_read_at) from comment_read where job_id=p.job_id and reader_type='staff'),'')
    ) unread_comment_count
    from photo p
    left join (select photo_id,count(*) selected_count from selection group by photo_id) sel on sel.photo_id=p.id
    left join (select a.photo_id,count(*) slot_count,group_concat(j.name,'、') slot_names from slot_assignment a join job_item j on j.id=a.job_item_id where a.is_final=1 group by a.photo_id) slot on slot.photo_id=p.id
    left join (select photo_id,count(*) comment_count from photo_comment where deleted_at is null group by photo_id) cmt on cmt.photo_id=p.id
    left join (select photo_id,count(*) note_count from photo_note group by photo_id) note on note.photo_id=p.id`;
  const photoCounts = jobId => {
    const row = db.prepare(`select count(*) total,
      coalesce(sum(case when deleted_at is null and hidden=1 then 1 else 0 end),0) hidden,
      coalesce(sum(case when deleted_at is null and import_status='processing' then 1 else 0 end),0) processing,
      coalesce(sum(case when deleted_at is null and import_status='failed' then 1 else 0 end),0) failed,
      coalesce(sum(case when deleted_at is not null then 1 else 0 end),0) trash
      from photo where job_id=?`).get(jobId);
    return row;
  };

  app.post('/api/admin/login', (req, res) => {
    if (!loginGuard(req, res)) return;
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
      res.status(201).json({ ok: true, password, customer: { id, name, phone, url: cfg.publicUrl || undefined } });
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
    res.json({ ok: true, password, url: cfg.publicUrl || undefined });
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
    res.json({ ok: true, password, url: cfg.publicUrl || undefined });
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
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const trash = String(req.query.trash || '') === '1';
    const selectors = db.prepare('select id,name from selector where job_id=? order by id').all(job.id);
    const filter = normalizePhotoFilter(req.query.filter, selectors);
    const conditions = ['p.job_id=?', trash ? 'p.deleted_at is not null' : 'p.deleted_at is null'];
    const params = [job.id];
    if (!trash) conditions.push(photoFilterCondition(filter));
    if (req.query.status) { conditions.push('p.import_status=?'); params.push(String(req.query.status)); }
    if (req.query.q) { conditions.push('(coalesce(p.display_name,p.filename) like ? or p.filename like ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const where = conditions.join(' and ');
    if (String(req.query.ids_only || '') === '1') {
      const ids = db.prepare(`select p.id from photo p where ${where} order by ${trash ? 'p.deleted_at desc,p.id' : 'p.sort,p.id'}`).all(...params).map(row => row.id);
      return res.json({ ids, total: ids.length, filter: filter.raw, filter_counts: photoFilterCounts(db, job.id, selectors) });
    }
    const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 120));
    const page = Math.max(1, Number(req.query.page) || 1);
    const total = db.prepare(`select count(*) count from photo p where ${where}`).get(...params).count;
    const rows = db.prepare(`${photoSelectSql} where ${where} order by ${trash ? 'p.deleted_at desc,p.id' : 'p.sort,p.id'} limit ? offset ?`).all(...params, pageSize, (page - 1) * pageSize);
    const selectedBy = selectedByForPhotos(db, rows.map(photo => photo.id));
    const slots = slotsForPhotos(db, rows.map(photo => photo.id));
    const photos = rows.map(photo => photoView({ ...photo, selected_by: selectedBy.get(photo.id) || [], slots: slots.get(photo.id) || [] }));
    res.json({
      photos,
      counts: photoCounts(job.id),
      filter: filter.raw,
      filter_counts: photoFilterCounts(db, job.id, selectors),
      quota: photoQuotaSummary(db, job.id),
      pagination: { page, page_size: pageSize, total, has_more: page * pageSize < total },
      job_status: job.status,
    });
  });
  app.get('/api/admin/jobs/:id/photo-queue', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    res.json({ queue: photoQueue.stats(job.id) });
  });
  app.post('/api/admin/jobs/:id/photos', requireActor('staff'), photoUpload.single('photo'), async (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) { removeTemp(req.file); return jsonError(res, 404, 'NOT_FOUND', '任务不存在'); }
    if (!req.file) return jsonError(res, 400, 'INVALID_UPLOAD', '请选择图片');
    try {
      const meta = await readImageMetadata(req.file.path);
      if (meta.error) { removeTemp(req.file); return jsonError(res, 400, 'INVALID_UPLOAD', '只接受有效的 jpg/jpeg/png/heic 图片；HEIC 无法解码时请先转为 JPG'); }
      const sha256 = await sha256File(req.file.path);
      if (String(req.query.allow_duplicate || '') !== '1') {
        const duplicate = db.prepare('select id from photo where job_id=? and sha256=? and deleted_at is null').get(job.id, sha256);
        if (duplicate) { removeTemp(req.file); return res.status(409).json({ error: { code: 'DUPLICATE_PHOTO', message: '相同照片已存在，已跳过', photo_id: duplicate.id } }); }
      }
      const extension = extensionForFormat(meta.format);
      const originalPath = moveOriginalToUploads(req.file.path, cfg.dataDir, job.id, extension);
      const displayName = normalizeDisplayName(decodeOriginalName(req.file.originalname)) || `photo${extension}`;
      const sort = db.prepare('select coalesce(max(sort),-1)+1 sort from photo where job_id=?').get(job.id).sort;
      const nowIso = now();
      const result = db.prepare('insert into photo(job_id,filename,display_name,original_key,source,sha256,size_bytes,width,height,taken_at,sort,import_status,version,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(job.id, displayName, displayName, originalPath, 'upload', sha256, req.file.size, meta.width, meta.height, meta.takenAt, sort, 'processing', 1, nowIso, nowIso);
      const photoId = Number(result.lastInsertRowid);
      event(job.id, 'photo.uploaded', req.actor, { photo_id: photoId, display_name: displayName });
      photoQueue.enqueue(photoId);
      res.status(201).json({ photo: photoView(db.prepare('select * from photo where id=?').get(photoId)) });
    } catch (error) {
      removeTemp(req.file);
      console.error(error);
      return jsonError(res, 500, 'UPLOAD_FAILED', '上传保存失败');
    }
  });
  app.patch('/api/admin/jobs/:id/photos/:photoId', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const photo = photoInJob(job.id, +req.params.photoId);
    if (!photo) return jsonError(res, 404, 'NOT_FOUND', '照片不存在');
    const updates = [];
    const values = [];
    if (req.body.display_name !== undefined) {
      const name = normalizeDisplayName(req.body.display_name);
      if (!name) return jsonError(res, 400, 'INVALID_NAME', '显示名称不能为空');
      updates.push('display_name=?'); values.push(name);
    }
    if (req.body.hidden !== undefined) { updates.push('hidden=?'); values.push(req.body.hidden ? 1 : 0); }
    if (!updates.length) return jsonError(res, 400, 'INVALID_UPDATE', '没有可修改的字段');
    updates.push('updated_at=?'); values.push(now(), photo.id);
    db.prepare(`update photo set ${updates.join(',')} where id=?`).run(...values);
    event(job.id, 'photo.updated', req.actor, { photo_id: photo.id, display_name: req.body.display_name !== undefined ? normalizeDisplayName(req.body.display_name) : undefined, hidden: req.body.hidden !== undefined ? Boolean(req.body.hidden) : undefined });
    res.json({ ok: true, photo: photoView(db.prepare('select * from photo where id=?').get(photo.id)) });
  });
  app.post('/api/admin/jobs/:id/photos/reorder', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const active = db.prepare('select * from photo where job_id=? and deleted_at is null order by sort,id').all(job.id);
    let ordered;
    if (Array.isArray(req.body.ids)) {
      const ids = req.body.ids.map(Number);
      if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !Number.isInteger(id) || !active.some(p => p.id === id))) return jsonError(res, 400, 'INVALID_ORDER', '排序列表无效');
      ordered = [...ids.map(id => active.find(p => p.id === id)), ...active.filter(p => !ids.includes(p.id))];
    } else if (['filename', 'taken_at', 'uploaded_at'].includes(req.body.by)) {
      ordered = [...active];
      if (req.body.by === 'filename') ordered.sort((a, b) => String(a.display_name || a.filename).localeCompare(String(b.display_name || b.filename), 'zh-CN'));
      if (req.body.by === 'taken_at') ordered.sort((a, b) => String(a.taken_at || a.created_at || '').localeCompare(String(b.taken_at || b.created_at || '')));
      if (req.body.by === 'uploaded_at') ordered.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    } else return jsonError(res, 400, 'INVALID_ORDER', '排序参数无效');
    db.transaction(() => { ordered.forEach((photo, index) => db.prepare('update photo set sort=?,updated_at=? where id=?').run(index, now(), photo.id)); })();
    event(job.id, 'photo.reordered', req.actor, { order: ordered.map(p => p.id) });
    res.json({ photos: db.prepare(`${photoSelectSql} where p.job_id=? and p.deleted_at is null order by p.sort,p.id`).all(job.id).map(photoView) });
  });
  app.put('/api/admin/jobs/:id/photos/:photoId/file', requireActor('staff'), photoUpload.single('photo'), async (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) { removeTemp(req.file); return jsonError(res, 404, 'NOT_FOUND', '任务不存在'); }
    const photo = photoInJob(job.id, +req.params.photoId);
    if (!photo) { removeTemp(req.file); return jsonError(res, 404, 'NOT_FOUND', '照片不存在'); }
    if (!req.file) return jsonError(res, 400, 'INVALID_UPLOAD', '请选择图片');
    if (isPhotoLocked(job, photo.id)) { removeTemp(req.file); return jsonError(res, 409, 'JOB_LOCKED', '客户已提交，不能替换已被选中的照片'); }
    try {
      const meta = await readImageMetadata(req.file.path);
      if (meta.error) { removeTemp(req.file); return jsonError(res, 400, 'INVALID_UPLOAD', '只接受有效的 jpg/jpeg/png/heic 图片；HEIC 无法解码时请先转为 JPG'); }
      const sha256 = await sha256File(req.file.path);
      const duplicate = db.prepare('select id from photo where job_id=? and sha256=? and id<>? and deleted_at is null').get(job.id, sha256, photo.id);
      if (duplicate) { removeTemp(req.file); return res.status(409).json({ error: { code: 'DUPLICATE_PHOTO', message: '相同照片已存在，已跳过', photo_id: duplicate.id } }); }
      if (photo.source === 'upload') moveOriginalToTrash(photo.original_key, cfg.dataDir, job.id, photo.id, photo.version || 1);
      const extension = extensionForFormat(meta.format);
      const originalPath = moveOriginalToUploads(req.file.path, cfg.dataDir, job.id, extension);
      const newName = normalizeDisplayName(decodeOriginalName(req.file.originalname)) || photo.filename;
      db.prepare('update photo set filename=?,display_name=?,original_key=?,source=?,sha256=?,size_bytes=?,width=?,height=?,taken_at=?,version=version+1,import_status=?,import_error=null,updated_at=? where id=?')
        .run(newName, photo.display_name || photo.filename, originalPath, 'upload', sha256, req.file.size, meta.width, meta.height, meta.takenAt, 'processing', now(), photo.id);
      try { await processPhoto(db, cfg, photo.id); } catch {}
      event(job.id, 'photo.replaced', req.actor, { photo_id: photo.id, version: (photo.version || 1) + 1 });
      res.json({ ok: true, photo: photoView(db.prepare('select * from photo where id=?').get(photo.id)) });
    } catch (error) {
      removeTemp(req.file);
      console.error(error);
      return jsonError(res, 500, 'UPLOAD_FAILED', '替换失败');
    }
  });
  app.delete('/api/admin/jobs/:id/photos/:photoId', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const photo = photoInJob(job.id, +req.params.photoId);
    if (!photo) return jsonError(res, 404, 'NOT_FOUND', '照片不存在');
    if (isPhotoLocked(job, photo.id)) return jsonError(res, 409, 'JOB_LOCKED', '客户已提交，照片已被选中，需先退回修改');
    const impact = photoImpact(db, photo.id);
    if (impact.has_impact && !req.body?.confirm) return res.status(409).json({ error: { code: 'CONFIRM_REQUIRED', message: impactMessage(impact), impact } });
    softDeletePhoto(db, { photo, staffId: req.actor.actor_id });
    event(job.id, 'photo.deleted', req.actor, { photo_id: photo.id, display_name: photo.display_name || photo.filename, impact });
    res.json({ ok: true, photo: photoView(db.prepare('select * from photo where id=?').get(photo.id)), impact });
  });
  app.post('/api/admin/jobs/:id/photos/:photoId/restore', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const photo = photoInJob(job.id, +req.params.photoId, true);
    if (!photo || !photo.deleted_at) return jsonError(res, 404, 'NOT_FOUND', '回收站中找不到这张照片');
    restorePhoto(db, { photo });
    event(job.id, 'photo.restored', req.actor, { photo_id: photo.id, display_name: photo.display_name || photo.filename });
    res.json({ ok: true, photo: photoView(db.prepare('select * from photo where id=?').get(photo.id)) });
  });
  app.post('/api/admin/jobs/:id/photos/batch', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const action = String(req.body.action || '');
    if (!['hide', 'show', 'delete', 'restore'].includes(action)) return jsonError(res, 400, 'INVALID_ACTION', '批量操作无效');
    const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(Number))].filter(id => Number.isInteger(id) && id > 0) : [];
    if (!ids.length) return jsonError(res, 400, 'INVALID_IDS', '请选择照片');
    const photos = db.prepare(`select * from photo where job_id=? and id in (${ids.map(() => '?').join(',')})${action === 'restore' ? '' : ' and deleted_at is null'}`).all(job.id, ...ids);
    if (photos.length !== ids.length) return jsonError(res, 404, 'NOT_FOUND', '部分照片不存在');
    if (action === 'delete') {
      for (const photo of photos) if (isPhotoLocked(job, photo.id)) return jsonError(res, 409, 'JOB_LOCKED', `照片 ${photo.display_name || photo.filename} 已被选中，需先退回修改`);
      if (!req.body.confirm) {
        const impacts = photos.map(photo => ({ photo_id: photo.id, display_name: photo.display_name || photo.filename, ...photoImpact(db, photo.id) }));
        if (impacts.some(impact => impact.has_impact)) return res.status(409).json({ error: { code: 'CONFIRM_REQUIRED', message: impacts.filter(i => i.has_impact).map(i => `${i.display_name}：${impactMessage(i)}`).join('；'), impact: impacts } });
      }
    }
    db.transaction(() => {
      for (const photo of photos) {
        if (action === 'hide' || action === 'show') {
          db.prepare('update photo set hidden=?,updated_at=? where id=?').run(action === 'hide' ? 1 : 0, now(), photo.id);
          event(job.id, 'photo.updated', req.actor, { photo_id: photo.id, hidden: action === 'hide' });
        } else if (action === 'delete') {
          softDeletePhoto(db, { photo, staffId: req.actor.actor_id });
          event(job.id, 'photo.deleted', req.actor, { photo_id: photo.id, display_name: photo.display_name || photo.filename });
        } else {
          restorePhoto(db, { photo });
          event(job.id, 'photo.restored', req.actor, { photo_id: photo.id, display_name: photo.display_name || photo.filename });
        }
      }
    })();
    res.json({ ok: true, affected: photos.length });
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
    const selectors = new Map(db.prepare('select id,name from selector where job_id=?').all(+req.params.id).map(row => [row.id, row.name]));
    const staff = new Map(db.prepare('select id,name from staff').all().map(row => [row.id, row.name]));
    const comments = db.prepare('select * from photo_comment where job_id=? order by photo_id,created_at,id').all(+req.params.id).map(comment => ({
      ...comment,
      author_name: comment.author_type === 'staff' ? (staff.get(comment.author_id) || '影楼') : (selectors.get(comment.author_id) || '选片人'),
    }));
    res.json({ comments });
  });
  app.post('/api/admin/jobs/:id/comments/read', requireActor('staff'), (req, res) => {
    if (!ownedJob(req.params.id, req.actor)) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    db.prepare('insert into comment_read(reader_type,reader_id,job_id,last_read_at) values(?,?,?,?) on conflict(reader_type,reader_id,job_id) do update set last_read_at=excluded.last_read_at').run('staff', req.actor.actor_id, +req.params.id, now());
    res.json({ ok: true });
  });

  app.get('/api/admin/source-dirs', requireActor('staff'), (req, res) => {
    const root = path.resolve(cfg.photoSourceDir);
    let directories = [];
    let rootImageCount = 0;
    if (fs.existsSync(root)) {
      directories = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => ({ name: entry.name, image_count: scanSourceDirectory(path.join(root, entry.name)).length }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      rootImageCount = scanSourceDirectory(root).length;
    }
    res.json({ root, root_image_count: rootImageCount, directories });
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
    const id = db.prepare('insert into import_task(job_id,source,status,created_at) values(?,?,?,?)').run(+req.params.id, relative, 'pending', now()).lastInsertRowid;
    const taskId = Number(id);
    setImmediate(async () => {
      try {
        db.prepare("update import_task set status='processing',total=? where id=?").run(scanSourceDirectory(realSource).length, taskId);
        const result = await importPhotos({ db, jobId: +req.params.id, sourceDir: realSource, dataDir: cfg.dataDir, watermarkText: cfg.watermarkText, queue: photoQueue, onProgress: ({ processed, failed, skipped }) => db.prepare('update import_task set processed=?,failed=?,skipped=? where id=?').run(processed, failed, skipped, taskId) });
        await photoQueue.waitForIds(result.ids);
        db.prepare("update import_task set status='completed',total=?,processed=?,failed=?,skipped=?,finished_at=? where id=?").run(result.total, result.total, result.failed, result.skipped, now(), taskId);
      } catch {
        db.prepare("update import_task set status='failed',errors=?,finished_at=? where id=?").run('IMPORT_FAILED', now(), taskId);
      }
    });
    res.status(202).json({ import_task: { id: taskId, status: 'pending', source: relative } });
  });
  app.get('/api/admin/jobs/:id/imports/:taskId', requireActor('staff'), (req, res) => {
    if (!ownedJob(req.params.id, req.actor)) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const task = db.prepare('select id,job_id,status,total,processed,failed,skipped,errors from import_task where id=? and job_id=?').get(+req.params.taskId, +req.params.id);
    return task ? res.json({ import_task: task }) : jsonError(res, 404, 'NOT_FOUND', '导入任务不存在');
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
  app.get('/api/admin/jobs/:id/photos/:photoId/notes', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const photo = photoInJob(job.id, +req.params.photoId);
    if (!photo) return jsonError(res, 404, 'NOT_FOUND', '照片不存在');
    const notes = db.prepare(`select n.*,u.name selector_name,s.name staff_name from photo_note n
      left join selector u on u.id=n.selector_id left join staff s on s.id=n.staff_id
      where n.photo_id=? order by n.updated_at,n.id`).all(photo.id);
    res.json({ notes });
  });
  app.get('/api/admin/jobs/:id/photos/:photoId/original', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const photo = photoInJob(job.id, +req.params.photoId);
    if (!photo) return jsonError(res, 404, 'NOT_FOUND', '照片不存在');
    const file = safeFile(photo.original_key, [cfg.dataDir, cfg.photoSourceDir]);
    if (!file) return jsonError(res, 404, 'ORIGINAL_NOT_FOUND', '原图文件不存在');
    privateHeaders(res);
    res.download(file, photo.filename);
  });
  app.delete('/api/admin/jobs/:id/photos/:photoId/comments/:commentId', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const comment = db.prepare('select * from photo_comment where id=? and job_id=? and photo_id=? and deleted_at is null').get(+req.params.commentId, job.id, +req.params.photoId);
    if (!comment) return jsonError(res, 404, 'NOT_FOUND', '评论不存在');
    db.prepare('update photo_comment set deleted_at=? where id=?').run(now(), comment.id);
    event(job.id, 'comment.deleted', req.actor, { comment_id: comment.id, photo_id: comment.photo_id, visibility: comment.visibility, audience_selector_id: comment.audience_selector_id });
    res.json({ ok: true });
  });
  app.get('/api/admin/jobs/:id/exports/estimate', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const photos = resolveExportPhotos(db, job.id, { scope: String(req.query.scope || 'selected'), filter: req.query.filter, ids: String(req.query.ids || '').split(',').filter(Boolean) });
    const bytes = photos.reduce((sum, photo) => sum + Number(photo.size_bytes || 0), 0);
    res.json({ count: photos.length, estimated_bytes: bytes, warning: bytes > 5 * 1024 * 1024 * 1024 ? '文件较大，下载可能需要较长时间' : null });
  });
  app.post('/api/admin/jobs/:id/exports', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const scope = String(req.body.scope || 'selected');
    if (!['selected', 'filter', 'ids', 'all'].includes(scope)) return jsonError(res, 400, 'INVALID_EXPORT_SCOPE', '导出范围无效');
    const photos = resolveExportPhotos(db, job.id, { scope, filter: req.body.filter, ids: req.body.ids });
    if (!photos.length) return jsonError(res, 400, 'NO_PHOTOS', '没有可导出的照片');
    const estimated = photos.reduce((sum, photo) => sum + Number(photo.size_bytes || 0), 0);
    const date = new Date();
    const { name, file } = nextExportName(db, cfg.dataDir, job, date);
    const expires = new Date(date.getTime() + 7 * 86400000).toISOString();
    const id = db.prepare(`insert into download_package(job_id,kind,status,file_key,expires_at,selector_id,scope,photo_ids_hash,progress,total,error,created_at,export_name,missing,created_by,meta)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id, 'admin', 'pending', file, expires, null, scope, null, 0, photos.length, null, now(), name, 0, req.actor.actor_id, null).lastInsertRowid;
    const exportId = Number(id);
    trackTask(buildAdminExport({
      db, dataDir: cfg.dataDir, job, exportId, photos,
      groupByUse: req.body.group_by_use !== false,
      includeCsv: req.body.include_csv !== false,
      date,
    }).catch(error => {
      try { db.prepare("update download_package set status='failed',error=? where id=?").run(String(error.code || 'EXPORT_FAILED'), exportId); } catch {}
    }));
    db.prepare('insert into audit_log(job_id,actor_type,actor_id,action,payload,created_at) values(?,?,?,?,?,?)').run(job.id, 'staff', req.actor.actor_id, 'export.admin', JSON.stringify({ export_id: exportId, scope, filter: req.body.filter || null, ids: req.body.ids || null, count: photos.length, file_name: name, estimated_bytes: estimated }), now());
    res.status(202).json({
      export: adminExportView(db.prepare('select * from download_package where id=?').get(exportId)),
      estimated_bytes: estimated,
      warning: estimated > 5 * 1024 * 1024 * 1024 ? '文件较大，下载可能需要较长时间' : null,
    });
  });
  app.get('/api/admin/jobs/:id/exports', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const exports = db.prepare("select * from download_package where job_id=? and kind='admin' order by id desc limit 30").all(job.id).map(adminExportView);
    res.json({ exports });
  });
  app.get('/api/admin/jobs/:id/exports/:exportId', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const row = db.prepare("select * from download_package where id=? and job_id=? and kind='admin'").get(+req.params.exportId, job.id);
    return row ? res.json({ export: adminExportView(row) }) : jsonError(res, 404, 'NOT_FOUND', '导出任务不存在');
  });
  app.get('/api/admin/jobs/:id/exports/:exportId/file', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const row = db.prepare("select * from download_package where id=? and job_id=? and kind='admin' and status='ready'").get(+req.params.exportId, job.id);
    if (!row || row.expires_at <= now()) return jsonError(res, 404, 'DOWNLOAD_NOT_FOUND', '导出文件不存在或已过期');
    const file = safeFile(row.file_key, [cfg.dataDir]);
    if (!file) return jsonError(res, 404, 'DOWNLOAD_NOT_FOUND', '导出文件不存在');
    downloadHeaders(res, row.export_name || `${sanitizeOrderName(job.title)}_${beijingDateStamp(new Date())}.zip`);
    res.sendFile(file);
  });
  app.get('/api/admin/jobs/:id/export.csv', requireActor('staff'), (req, res) => {
    const job = ownedJob(req.params.id, req.actor);
    if (!job) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    const name = `${sanitizeOrderName(job.title)}_${beijingDateStamp(new Date())}_修图清单.csv`;
    downloadHeaders(res, name);
    res.set('Content-Type', 'text/csv; charset=utf-8').send(exportCsv(db, +req.params.id));
  });
  app.post('/api/admin/jobs/:id/lock', requireActor('staff'), (req, res) => {
    const jobId = +req.params.id, staff = db.prepare('select studio_id from staff where id=?').get(req.actor.actor_id);
    const changed = db.prepare("update job set status='locked',locked_at=?,locked_by=? where id=? and studio_id=?").run(now(), req.actor.actor_id, jobId, staff?.studio_id);
    if (!changed.changes) return jsonError(res, 404, 'NOT_FOUND', '任务不存在');
    event(jobId, 'job.status', req.actor, { status: 'locked' });
    res.json({ ok: true });
  });
}
