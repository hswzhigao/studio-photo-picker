import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { decodeOriginalName, normalizeDisplayName, sha256File } from './photoManager.js';

export const RETOUCHED_MAX_BYTES = 50 * 1024 * 1024;
export const retouchedRoot = cfg => path.join(cfg.dataDir, 'uploads', 'retouched');
export function retouchedError(code, statusCode = 400) { return Object.assign(new Error(code), { code, statusCode }); }
export function positiveId(value) {
  if (!['string','number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw retouchedError('INVALID_ID');
  return Number(value);
}
export function retouchedIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) throw retouchedError('INVALID_IDS');
  return [...new Set(ids)];
}
export function getRetouched(db, jobId, id, actor) {
  const row = db.prepare('select * from retouched_photo where job_id=? and id=?').get(jobId, positiveId(id));
  if (!row || (actor.actor_type !== 'staff' && row.status !== 'published')) throw retouchedError('NOT_FOUND', 404);
  return row;
}
export function currentRetouched(db, jobId, actor) {
  const rows = db.prepare(`select * from retouched_photo where job_id=? ${actor.actor_type === 'staff' ? '' : "and status='published'"} order by version desc,id desc`).all(jobId);
  const seen = new Set();
  return rows.filter(row => !seen.has(row.asset_id) && seen.add(row.asset_id)).sort((a,b) => a.id-b.id);
}
export function retouchedView(db, row, actor, history = true) {
  const role = actor.actor_type === 'staff' ? 'admin' : 'client';
  const base = `/api/${role}/jobs/${row.job_id}/retouched/${row.id}`;
  const view = Object.fromEntries(['id','asset_id','photo_id','filename','version','status','width','height','size_bytes','sha256','published_at'].map(key => [key,row[key]]));
  const linked = row.photo_id && db.prepare("select id from photo where id=? and job_id=? and hidden=0 and deleted_at is null and import_status='ready'").get(row.photo_id,row.job_id);
  let count = 0;
  if (db.prepare('pragma table_info(photo_comment)').all().some(c => c.name === 'retouched_photo_id')) {
    count = db.prepare(`select count(*) n from photo_comment where retouched_photo_id=? and deleted_at is null ${role==='admin'?'':"and (visibility='all' or audience_selector_id=? or (author_type='customer' and author_id=?))"}`).get(...(role==='admin'?[row.id]:[row.id,actor.actor_id,actor.actor_id])).n;
  }
  Object.assign(view, { thumb_url: `${base}/thumb`, original_url: `${base}/original`, download_url: `${base}/download`, before_url: linked ? `/media/previews/${row.photo_id}.webp` : null, comment_count: count });
  if (history) view.versions = db.prepare(`select * from retouched_photo where job_id=? and asset_id=? ${role==='admin'?'':"and status='published'"} order by version desc`).all(row.job_id,row.asset_id).map(r=>retouchedView(db,r,actor,false));
  return view;
}
export function validatePair(db, jobId, value) {
  if (value === null) return null;
  const id = positiveId(value);
  if (!db.prepare("select id from photo where id=? and job_id=? and hidden=0 and deleted_at is null and import_status='ready'").get(id, jobId)) throw retouchedError('INVALID_PHOTO');
  return id;
}
export async function prepareRetouched(file, cfg) {
  if (!file || !/\.(jpe?g|png)$/i.test(file.originalname)) throw retouchedError('INVALID_UPLOAD');
  if (file.size > RETOUCHED_MAX_BYTES) throw retouchedError('UPLOAD_TOO_LARGE');
  let meta;
  try {
    meta = await sharp(file.path).metadata();
    if (!['jpeg','png'].includes(meta.format) || !meta.width || !meta.height) throw new Error();
  } catch { throw retouchedError('INVALID_UPLOAD'); }
  const root = retouchedRoot(cfg); fs.mkdirSync(root, { recursive: true });
  const stem = crypto.randomUUID();
  const original = path.join(root, `${stem}.${meta.format === 'jpeg'?'jpg':'png'}`);
  const thumb = path.join(root, `${stem}.webp`);
  const temporary = `${thumb}.upload`;
  try {
    // Full decode, not metadata alone, must succeed before any database write.
    await sharp(file.path, { failOn: 'warning' }).rotate().resize({ width: 400, withoutEnlargement: true }).webp({ quality: 84 }).toFile(temporary);
    const hash = await sha256File(file.path);
    fs.renameSync(file.path, original); fs.renameSync(temporary, thumb);
    return { filename: normalizeDisplayName(decodeOriginalName(file.originalname)) || `photo.${meta.format==='jpeg'?'jpg':'png'}`, file_key: original, thumb_key: thumb, width: meta.width, height: meta.height, size_bytes: file.size, sha256: hash };
  } catch (error) {
    for (const f of [original,thumb,temporary]) fs.rmSync(f,{force:true});
    if (!error.code || error.message.includes('Vips') || error.message.includes('Input')) throw retouchedError('INVALID_UPLOAD');
    throw error;
  }
}
