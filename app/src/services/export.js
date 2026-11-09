import { visiblePhotoCondition } from './visibility.js';

function csvCell(v) { const s = String(v ?? '').replaceAll('"', '""'); return `"${s}"`; }

export function buildSummary(db, jobId) {
  const job = db.prepare('select * from job where id=?').get(jobId);
  const selectors = db.prepare('select * from selector where job_id=?').all(jobId);
  const photos = db.prepare(`select p.* from photo p where p.job_id=? and ${visiblePhotoCondition('p')} order by p.sort,p.id`).all(jobId);
  const rows = photos.map(p => {
    const picks = db.prepare('select u.name,u.id from selection s join selector u on u.id=s.selector_id where s.photo_id=? and u.job_id=?').all(p.id, jobId);
    const slots = db.prepare('select j.name from slot_assignment a join job_item j on j.id=a.job_item_id where a.photo_id=? and a.is_final=1').all(p.id);
    return { photo: p, picks, use: ['精修', ...slots.map(x => x.name)], notes: db.prepare('select content from photo_note where photo_id=?').all(p.id).map(x => x.content) };
  });
  const quota = db.prepare("select quantity from job_item where job_id=? and kind='retouch'").get(jobId)?.quantity || 0;
  const mergedCount = new Set(rows.flatMap(x => x.picks.map(y => y.id))).size;
  return {
    job,
    selectors: selectors.map(s => ({ ...s, selectionCount: db.prepare(`select count(*) count from selection s join photo p on p.id=s.photo_id where s.selector_id=? and ${visiblePhotoCondition('p')}`).get(s.id).count })),
    photos: rows,
    rows: rows.filter(x => x.picks.length).map(x => ({
      id: x.photo.id,
      filename: x.photo.display_name || x.photo.filename,
      original_filename: x.photo.filename,
      thumb_url: `/media/thumbs/${x.photo.id}.webp?v=${x.photo.version || 1}`,
      selectedBy: x.picks.map(p => p.id),
      use: x.use.join(' · '),
      note: x.notes.join('；'),
    })),
    quota,
    union: mergedCount,
    mergedCount,
  };
}

export function exportCsv(db, jobId) {
  const s = buildSummary(db, jobId);
  const head = ['显示名', '原始文件名', ...s.selectors.map(x => x.name), '用途', '客户备注'];
  const lines = [head, ...s.photos.filter(x => x.picks.length).map(x => [
    x.photo.display_name || x.photo.filename,
    x.photo.filename,
    ...s.selectors.map(u => x.picks.some(p => p.id === u.id) ? '✓' : ''),
    x.use.join(' · '),
    x.notes.join('；'),
  ])];
  return '\ufeff' + lines.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
