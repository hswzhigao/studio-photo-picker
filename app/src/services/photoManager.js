import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

export const TRASH_RETENTION_MS = 30 * 86400000;
const IMAGE_FORMATS = new Set(['jpeg', 'png', 'heif']);

export function normalizeDisplayName(value) {
  return String(value ?? '')
    .replace(/[/\\\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);
}

export function decodeOriginalName(name) {
  const raw = String(name || '');
  if (!raw || /[^\u0000-\u00ff]/.test(raw)) return raw;
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  return decoded.includes('\ufffd') ? raw : decoded;
}

export function extensionForFormat(format) {
  if (format === 'jpeg') return '.jpg';
  if (format === 'png') return '.png';
  if (format === 'heif') return '.heic';
  return '';
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function exifTakenAt(exif) {
  if (!exif) return null;
  const text = Buffer.isBuffer(exif) ? exif.toString('latin1') : String(exif);
  const match = text.match(/(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` : null;
}

export async function readImageMetadata(file) {
  try {
    const meta = await sharp(file).metadata();
    if (!IMAGE_FORMATS.has(meta.format)) return { error: 'INVALID_UPLOAD' };
    return { format: meta.format, width: meta.width || null, height: meta.height || null, takenAt: exifTakenAt(meta.exif) };
  } catch {
    return { error: 'INVALID_UPLOAD' };
  }
}

function watermarkSvg(width, height, text) {
  const w = Math.max(1, Math.min(width || 1, 1600));
  const h = Math.max(1, Math.min(height || 1, 80));
  const escaped = String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  return Buffer.from(`<svg width="${w}" height="${h}"><text x="${Math.min(20, w - 1)}" y="${Math.min(50, h - 1)}" fill="white" font-size="${Math.max(1, Math.min(26, h))}" opacity=".72">${escaped}</text></svg>`);
}

export function ensurePhotoDirs(dataDir) {
  for (const name of ['thumbnails', 'previews', 'uploads', 'tmp', 'trash']) fs.mkdirSync(path.join(dataDir, name), { recursive: true });
}

export async function processPhoto(db, cfg, photoId) {
  const photo = db.prepare('select * from photo where id=?').get(photoId);
  if (!photo || photo.deleted_at) return null;
  const meta = await readImageMetadata(photo.original_key);
  if (meta.error) throw Object.assign(new Error('INVALID_UPLOAD'), { code: 'INVALID_UPLOAD' });
  fs.mkdirSync(path.join(cfg.dataDir, 'thumbnails'), { recursive: true });
  fs.mkdirSync(path.join(cfg.dataDir, 'previews'), { recursive: true });
  const thumb = path.join(cfg.dataDir, 'thumbnails', `${photo.id}.webp`);
  const preview = path.join(cfg.dataDir, 'previews', `${photo.id}.webp`);
  await sharp(photo.original_key).rotate().resize({ width: 400, withoutEnlargement: true }).webp({ quality: 84 }).toFile(thumb);
  const overlay = watermarkSvg(meta.width, meta.height, cfg.watermarkText || '名人婚纱 · 预览');
  await sharp(photo.original_key).rotate().resize({ width: 1600, withoutEnlargement: true }).composite([{ input: overlay, gravity: 'southeast' }]).webp({ quality: 88 }).toFile(preview);
  db.prepare('update photo set thumb_key=?,preview_key=?,width=?,height=?,taken_at=coalesce(taken_at,?),import_status=?,import_error=null,updated_at=? where id=?')
    .run(thumb, preview, meta.width, meta.height, meta.takenAt, 'ready', new Date().toISOString(), photo.id);
  return db.prepare('select * from photo where id=?').get(photo.id);
}

export function createPhotoQueue({ db, cfg, concurrency = 2, schedule = setImmediate }) {
  const pending = [];
  let running = 0;
  let stopped = false;

  async function run(id) {
    try {
      await processPhoto(db, cfg, id);
    } catch (error) {
      db.prepare('update photo set import_status=?,import_error=?,updated_at=? where id=?').run('failed', String(error.code || 'PROCESS_FAILED').slice(0, 80), new Date().toISOString(), id);
    } finally {
      running = Math.max(0, running - 1);
      pump();
    }
  }

  function pump() {
    if (stopped) return;
    while (running < concurrency && pending.length) {
      const id = pending.shift();
      if (!id) continue;
      let row;
      try { row = db.prepare("select id from photo where id=? and import_status='processing' and deleted_at is null").get(id); } catch { return; }
      if (!row) continue;
      running += 1;
      schedule(() => run(id));
    }
  }

  function enqueue(id) {
    const photoId = Number(id);
    if (!Number.isInteger(photoId) || photoId <= 0 || stopped) return;
    if (pending.includes(photoId)) return;
    pending.push(photoId);
    pump();
  }

  function resume() {
    let rows;
    try { rows = db.prepare("select id from photo where import_status='processing' and deleted_at is null order by id").all(); } catch { return; }
    for (const row of rows) enqueue(row.id);
  }

  async function waitForIdle(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while ((running > 0 || pending.length) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  }

  async function waitForIds(ids, timeoutMs = 15000) {
    const wanted = ids.map(Number).filter(id => Number.isInteger(id) && id > 0);
    if (!wanted.length) return;
    const deadline = Date.now() + timeoutMs;
    const placeholders = wanted.map(() => '?').join(',');
    while (Date.now() < deadline) {
      const row = db.prepare(`select count(*) count from photo where id in (${placeholders}) and import_status='processing' and deleted_at is null`).get(...wanted);
      if (!row.count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  function stats(jobId) {
    const row = db.prepare(`select
      sum(case when deleted_at is null then 1 else 0 end) total,
      sum(case when deleted_at is null and hidden=1 then 1 else 0 end) hidden,
      sum(case when deleted_at is null and import_status='processing' then 1 else 0 end) processing,
      sum(case when deleted_at is null and import_status='failed' then 1 else 0 end) failed,
      sum(case when deleted_at is null and import_status='ready' and hidden=0 then 1 else 0 end) ready,
      sum(case when deleted_at is not null then 1 else 0 end) trash
      from photo where job_id=?`).get(jobId);
    return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, Number(value || 0)]));
  }

  return { enqueue, resume, waitForIdle, waitForIds, stats, stop: () => { stopped = true; pending.length = 0; } };
}

function pathInside(file, root) {
  try {
    const resolved = fs.realpathSync(file);
    const base = fs.realpathSync(root);
    const relative = path.relative(base, resolved);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

export function moveOriginalToUploads(tmpFile, dataDir, jobId, extension) {
  const dir = path.join(dataDir, 'uploads', String(jobId));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${crypto.randomUUID()}${extension}`);
  fs.renameSync(tmpFile, target);
  return target;
}

export function moveOriginalToTrash(file, dataDir, jobId, photoId, version) {
  if (!file || !pathInside(file, dataDir)) return null;
  const dir = path.join(dataDir, 'trash', String(jobId));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${photoId}-v${version}${path.extname(file).toLowerCase()}`);
  fs.renameSync(file, target);
  return target;
}

export function photoImpact(db, photoId) {
  const selectors = db.prepare('select distinct u.id,u.name from selection s join selector u on u.id=s.selector_id where s.photo_id=? order by u.id').all(photoId);
  const commentCount = db.prepare('select count(*) count from photo_comment where photo_id=? and deleted_at is null').get(photoId).count;
  const slotItems = db.prepare('select distinct j.id,j.name from slot_assignment a join job_item j on j.id=a.job_item_id where a.photo_id=? and a.is_final=1 order by j.id').all(photoId);
  return { selectors, comment_count: commentCount, slot_items: slotItems, has_impact: Boolean(selectors.length || commentCount || slotItems.length) };
}

export function softDeletePhoto(db, { photo, staffId }) {
  const impact = photoImpact(db, photo.id);
  const deletedAt = new Date().toISOString();
  const name = photo.display_name || photo.filename;
  const notify = db.prepare('insert into notification(job_id,selector_id,kind,content,sent_at) values(?,?,?,?,?)');
  const apply = db.transaction(() => {
    db.prepare('update photo set deleted_at=?,deleted_by=?,updated_at=? where id=?').run(deletedAt, staffId, deletedAt, photo.id);
    db.prepare('update slot_assignment set is_final=0,demoted_by_delete=1 where photo_id=? and is_final=1').run(photo.id);
    for (const selector of impact.selectors) notify.run(photo.job_id, selector.id, 'photo.deleted', `影楼移除了照片 ${name}`, deletedAt);
  });
  apply();
  return impact;
}

export function restorePhoto(db, { photo }) {
  const restoredAt = new Date().toISOString();
  const apply = db.transaction(() => {
    db.prepare('update photo set deleted_at=null,deleted_by=null,updated_at=? where id=?').run(restoredAt, photo.id);
    const demoted = db.prepare('select * from slot_assignment where photo_id=? and demoted_by_delete=1').all(photo.id);
    for (const assignment of demoted) {
      const occupied = db.prepare('select 1 from slot_assignment where job_item_id=? and is_final=1 and id<>?').get(assignment.job_item_id, assignment.id);
      if (!occupied) db.prepare('update slot_assignment set is_final=1 where id=?').run(assignment.id);
      db.prepare('update slot_assignment set demoted_by_delete=0 where id=?').run(assignment.id);
    }
  });
  apply();
  return restoredAt;
}

export function purgeExpiredTrash(db, cfg, { nowMs = Date.now(), retentionMs = TRASH_RETENTION_MS } = {}) {
  const cutoff = new Date(nowMs - retentionMs).toISOString();
  const rows = db.prepare('select * from photo where deleted_at is not null and deleted_at<=?').all(cutoff);
  let purged = 0;
  for (const photo of rows) {
    if (photo.source === 'upload' && photo.original_key && pathInside(photo.original_key, cfg.dataDir)) {
      try { fs.rmSync(photo.original_key, { force: true }); } catch {}
    }
    for (const file of [
      path.join(cfg.dataDir, 'thumbnails', `${photo.id}.webp`),
      path.join(cfg.dataDir, 'previews', `${photo.id}.webp`),
    ]) {
      if (pathInside(file, cfg.dataDir)) {
        try { fs.rmSync(file, { force: true }); } catch {}
      }
    }
    db.transaction(() => {
      db.prepare('delete from photo_comment where photo_id=?').run(photo.id);
      db.prepare('delete from selection where photo_id=?').run(photo.id);
      db.prepare('delete from slot_assignment where photo_id=?').run(photo.id);
      db.prepare('delete from photo_note where photo_id=?').run(photo.id);
      db.prepare('delete from photo where id=?').run(photo.id);
    })();
    purged += 1;
  }
  const trashRoot = path.join(cfg.dataDir, 'trash');
  if (fs.existsSync(trashRoot)) {
    for (const jobEntry of fs.readdirSync(trashRoot, { withFileTypes: true })) {
      if (!jobEntry.isDirectory()) continue;
      const jobDir = path.join(trashRoot, jobEntry.name);
      for (const fileEntry of fs.readdirSync(jobDir, { withFileTypes: true })) {
        if (!fileEntry.isFile()) continue;
        const file = path.join(jobDir, fileEntry.name);
        try {
          if (fs.statSync(file).mtimeMs <= nowMs - retentionMs) fs.rmSync(file, { force: true });
        } catch {}
      }
    }
  }
  return purged;
}

export async function backfillPhotoMetadata(db, cfg) {
  const rows = db.prepare('select id,original_key,size_bytes from photo where sha256 is null order by id').all();
  let updated = 0;
  for (const photo of rows) {
    try {
      if (!fs.existsSync(photo.original_key)) continue;
      const sha256 = await sha256File(photo.original_key);
      const size = fs.statSync(photo.original_key).size;
      db.prepare('update photo set sha256=?,size_bytes=?,updated_at=? where id=?').run(sha256, size, new Date().toISOString(), photo.id);
      updated += 1;
    } catch {}
  }
  return updated;
}

export function photoView(photo) {
  const version = Number(photo.version || 1);
  const name = photo.display_name || photo.filename;
  const { original_key, thumb_key, preview_key, ...safe } = photo;
  return {
    ...safe,
    display_name: name,
    original_filename: photo.filename,
    thumb_url: `/media/thumbs/${photo.id}.webp?v=${version}`,
    preview_url: `/media/previews/${photo.id}.webp?v=${version}`,
    trash_remaining_days: photo.deleted_at ? Math.max(0, Math.ceil((Date.parse(photo.deleted_at) + TRASH_RETENTION_MS - Date.now()) / 86400000)) : null,
  };
}
