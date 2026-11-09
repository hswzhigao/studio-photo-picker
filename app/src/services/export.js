import { visiblePhotoCondition } from './visibility.js';

function csvCell(v) { const s = String(v ?? '').replaceAll('"', '""'); return `"${s}"`; }

export function buildSummary(db, jobId) {
  const job = db.prepare('select * from job where id=?').get(jobId);
  const selectors = db.prepare('select * from selector where job_id=?').all(jobId);
  const photos = db.prepare(`select p.* from photo p where p.job_id=? and ${visiblePhotoCondition('p')} order by p.sort,p.id`).all(jobId);
  const rows = photos.map(p => {
    const picks = db.prepare('select u.name,u.id from selection s join selector u on u.id=s.selector_id where s.photo_id=? and u.job_id=? order by u.id').all(p.id, jobId);
    const slots = db.prepare('select j.name from slot_assignment a join job_item j on j.id=a.job_item_id where a.photo_id=? and a.is_final=1 order by j.sort,j.id').all(p.id);
    return { photo: p, picks, use: ['精修', ...slots.map(x => x.name)], notes: db.prepare('select content from photo_note where photo_id=?').all(p.id).map(x => x.content) };
  });
  const quota = db.prepare("select coalesce(sum(quantity),0) quantity from job_item where job_id=? and kind='retouch'").get(jobId).quantity;
  const mergedCount = new Set(rows.flatMap(x => x.picks.map(y => y.id))).size;
  const over = Math.max(0, mergedCount - quota);
  const amount = over * (job?.overage_unit_price || 20);
  const items = db.prepare('select * from job_item where job_id=? order by sort,id').all(jobId);
  const products = items.filter(item => item.kind === 'print_from_retouch').map(item => {
    const final = db.prepare(`select a.photo_id,a.selector_id,u.name selector_name,p.display_name,p.filename from slot_assignment a
      join selector u on u.id=a.selector_id join photo p on p.id=a.photo_id
      where a.job_item_id=? and a.is_final=1 and ${visiblePhotoCondition('p')} order by a.id desc limit 1`).get(item.id) || null;
    const suggestions = db.prepare(`select a.photo_id,a.selector_id,u.name selector_name,p.display_name,p.filename from slot_assignment a
      join selector u on u.id=a.selector_id join photo p on p.id=a.photo_id
      where a.job_item_id=? and a.is_final=0 and ${visiblePhotoCondition('p')} order by a.id`).all(item.id);
    return { item, final, suggestions };
  });
  const conflicts = db.prepare('select job_item_id,count(*) count from slot_assignment where is_final=1 and job_item_id in (select id from job_item where job_id=?) group by job_item_id having count(*)>1').all(jobId);
  const problems = [
    ...(over ? [{ code: 'OVERAGE', count: over, amount }] : []),
    ...products.filter(product => product.item.quantity > 0 && !product.final).map(product => ({ code: 'PRODUCT_UNASSIGNED', item: product.item })),
    ...conflicts.map(conflict => ({ code: 'SLOT_CONFLICT', job_item_id: conflict.job_item_id, count: conflict.count })),
  ];
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
    over,
    amount,
    mergedCount,
    union: mergedCount,
    items,
    products,
    problems,
  };
}

export function exportCsv(db, jobId, date = new Date()) {
  const s = buildSummary(db, jobId);
  const over = s.over;
  const amount = s.amount;
  const lines = [
    ['订单名', s.job?.title || ''],
    ['导出时间', new Date(date.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19)],
    ['额度', `精修 ${s.quota} 张；已选 ${s.mergedCount} 张；超 ${over} 张 ¥${amount}`],
    ['选片人提交', s.selectors.map(selector => `${selector.name}：${selector.submitted_at || '未提交'}`).join('；')],
    [],
    ['显示名', '原始文件名', ...s.selectors.map(x => x.name), '用途', '客户备注'],
    ...s.photos.filter(x => x.picks.length).map(x => [
      x.photo.display_name || x.photo.filename,
      x.photo.filename,
      ...s.selectors.map(u => x.picks.some(p => p.id === u.id) ? '✓' : ''),
      x.use.join(' · '),
      x.notes.join('；'),
    ]),
  ];
  return '\ufeff' + lines.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
