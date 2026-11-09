import { visiblePhotoCondition } from './visibility.js';

export const PHOTO_FILTER_TYPES = ['all', 'selected', 'unselected', 'slot', 'commented', 'noted', 'hidden', 'processing'];

export function normalizePhotoFilter(value, selectors = []) {
  const raw = String(value || 'all');
  if (raw.startsWith('selector:')) {
    const id = Number(raw.slice('selector:'.length));
    if (!Number.isInteger(id) || !selectors.some(selector => selector.id === id)) return { type: 'all', selectorId: null, raw: 'all' };
    return { type: 'selector', selectorId: id, raw: `selector:${id}` };
  }
  if (PHOTO_FILTER_TYPES.includes(raw)) return { type: raw, selectorId: null, raw };
  return { type: 'all', selectorId: null, raw: 'all' };
}

export function photoFilterCondition(filter, alias = 'p') {
  const { type, selectorId } = filter;
  const visible = `${alias}.hidden=0 and ${alias}.deleted_at is null and ${alias}.import_status='ready'`;
  if (type === 'selected') return `${visible} and exists(select 1 from selection s where s.photo_id=${alias}.id)`;
  if (type === 'unselected') return `${visible} and not exists(select 1 from selection s where s.photo_id=${alias}.id)`;
  if (type === 'selector') return `${visible} and exists(select 1 from selection s where s.photo_id=${alias}.id and s.selector_id=${Number(selectorId)})`;
  if (type === 'slot') return `${visible} and exists(select 1 from slot_assignment a where a.photo_id=${alias}.id and a.is_final=1)`;
  if (type === 'commented') return `${alias}.deleted_at is null and exists(select 1 from photo_comment c where c.photo_id=${alias}.id and c.deleted_at is null)`;
  if (type === 'noted') return `${alias}.deleted_at is null and exists(select 1 from photo_note n where n.photo_id=${alias}.id)`;
  if (type === 'hidden') return `${alias}.deleted_at is null and ${alias}.hidden=1`;
  if (type === 'processing') return `${alias}.deleted_at is null and ${alias}.import_status<>'ready'`;
  return '1=1';
}

function countWhere(db, jobId, condition) {
  return db.prepare(`select count(*) count from photo p where p.job_id=? and p.deleted_at is null and ${condition}`).get(jobId).count;
}

export function photoFilterCounts(db, jobId, selectors = []) {
  const lastRead = db.prepare("select coalesce(max(last_read_at),'') last_read_at from comment_read where job_id=? and reader_type='staff'").get(jobId).last_read_at;
  const commentedUnread = db.prepare(`select count(distinct p.id) count from photo p join photo_comment c on c.photo_id=p.id
    where p.job_id=? and p.deleted_at is null and c.deleted_at is null and c.created_at>?`).get(jobId, lastRead).count;
  return {
    all: countWhere(db, jobId, '1=1'),
    selected: countWhere(db, jobId, photoFilterCondition({ type: 'selected' })),
    unselected: countWhere(db, jobId, photoFilterCondition({ type: 'unselected' })),
    slot: countWhere(db, jobId, photoFilterCondition({ type: 'slot' })),
    commented: countWhere(db, jobId, photoFilterCondition({ type: 'commented' })),
    commented_unread: commentedUnread,
    noted: countWhere(db, jobId, photoFilterCondition({ type: 'noted' })),
    hidden: countWhere(db, jobId, photoFilterCondition({ type: 'hidden' })),
    processing: countWhere(db, jobId, photoFilterCondition({ type: 'processing' })),
    selectors: selectors.map(selector => ({ id: selector.id, name: selector.name, count: countWhere(db, jobId, photoFilterCondition({ type: 'selector', selectorId: selector.id })) })),
  };
}

export function photoQuotaSummary(db, jobId) {
  const quota = db.prepare("select coalesce(sum(quantity),0) quantity from job_item where job_id=? and kind='retouch'").get(jobId).quantity;
  const selected = db.prepare(`select count(distinct s.photo_id) count from selection s join selector u on u.id=s.selector_id join photo p on p.id=s.photo_id
    where u.job_id=? and ${visiblePhotoCondition('p')}`).get(jobId).count;
  const job = db.prepare('select overage_unit_price from job where id=?').get(jobId);
  const products = db.prepare("select id,name,quantity from job_item where job_id=? and kind='print_from_retouch' order by sort,id").all(jobId).map(item => ({
    ...item,
    assigned: db.prepare(`select count(distinct a.photo_id) count from slot_assignment a join photo p on p.id=a.photo_id
      where a.job_item_id=? and a.is_final=1 and ${visiblePhotoCondition('p')}`).get(item.id).count,
  }));
  const over = Math.max(0, selected - quota);
  return {
    retouch: { quota, selected, over, amount: over * (job?.overage_unit_price || 20) },
    products,
  };
}

export function selectedByForPhotos(db, photoIds) {
  const ids = photoIds.map(Number).filter(id => Number.isInteger(id) && id > 0);
  const map = new Map(ids.map(id => [id, []]));
  if (!ids.length) return map;
  const rows = db.prepare(`select s.photo_id,u.id,u.name from selection s join selector u on u.id=s.selector_id
    where s.photo_id in (${ids.map(() => '?').join(',')}) order by u.id`).all(...ids);
  for (const row of rows) map.get(row.photo_id)?.push({ id: row.id, name: row.name });
  return map;
}

export function slotsForPhotos(db, photoIds) {
  const ids = photoIds.map(Number).filter(id => Number.isInteger(id) && id > 0);
  const map = new Map(ids.map(id => [id, []]));
  if (!ids.length) return map;
  const rows = db.prepare(`select a.photo_id,j.id,j.name from slot_assignment a join job_item j on j.id=a.job_item_id
    where a.photo_id in (${ids.map(() => '?').join(',')}) and a.is_final=1 order by j.sort,j.id`).all(...ids);
  for (const row of rows) map.get(row.photo_id)?.push({ id: row.id, name: row.name });
  return map;
}
