import { visiblePhotoCondition } from './visibility.js';

export function union(db, jobId) {
  const row = db.prepare(`select count(distinct s.photo_id) count from selection s join selector u on u.id=s.selector_id join photo p on p.id=s.photo_id where u.job_id=? and ${visiblePhotoCondition('p')}`).get(jobId);
  const quota = db.prepare("select quantity from job_item where job_id=? and kind='retouch'").get(jobId)?.quantity || 0;
  const job = db.prepare('select overage_unit_price from job where id=?').get(jobId);
  return { count: row.count, quota, overage: Math.max(0, row.count - quota), overageAmount: Math.max(0, row.count - quota) * (job?.overage_unit_price || 20) };
}

export function setSelection(db, { jobId, selectorId, photoId, selected }) {
  const belongs = db.prepare('select 1 from selector where id=? and job_id=?').get(selectorId, jobId)
    && db.prepare(`select 1 from photo p where p.id=? and p.job_id=? and ${visiblePhotoCondition('p')}`).get(photoId, jobId);
  if (!belongs) throw new Error('PHOTO_NOT_IN_JOB');
  const job = db.prepare('select status from job where id=?').get(jobId);
  if (['locked', 'retouching', 'delivered'].includes(job.status)) throw new Error('JOB_LOCKED');
  if (selected) db.prepare('insert or ignore into selection(selector_id,photo_id,created_at) values(?,?,?)').run(selectorId, photoId, new Date().toISOString());
  else {
    db.prepare('delete from selection where selector_id=? and photo_id=?').run(selectorId, photoId);
    db.prepare('delete from slot_assignment where selector_id=? and photo_id=?').run(selectorId, photoId);
  }
}

export function assignSlot(db, { jobId, jobItemId, photoId, selectorId }) {
  const item = db.prepare('select * from job_item where id=? and job_id=? and kind=?').get(jobItemId, jobId, 'print_from_retouch');
  if (!item) throw new Error('INVALID_SLOT');
  if (!db.prepare(`select 1 from photo p where p.id=? and p.job_id=? and ${visiblePhotoCondition('p')}`).get(photoId, jobId)) throw new Error('PHOTO_NOT_IN_JOB');
  if (!db.prepare('select 1 from selection where selector_id=? and photo_id=?').get(selectorId, photoId)) db.prepare('insert into selection(selector_id,photo_id,created_at) values(?,?,?)').run(selectorId, photoId, new Date().toISOString());
  db.prepare('update slot_assignment set is_final=0 where job_item_id=? and slot_index=1').run(jobItemId);
  db.prepare('insert into slot_assignment(job_item_id,slot_index,photo_id,selector_id,is_final,created_at) values(?,?,?,?,1,?)').run(jobItemId, 1, photoId, selectorId, new Date().toISOString());
}

export function removeSlot(db, { jobId, jobItemId, photoId, selectorId }) {
  const item = db.prepare('select id from job_item where id=? and job_id=?').get(jobItemId, jobId);
  if (!item) throw new Error('INVALID_SLOT');
  db.prepare('delete from slot_assignment where job_item_id=? and photo_id=? and selector_id=?').run(jobItemId, photoId, selectorId);
}
