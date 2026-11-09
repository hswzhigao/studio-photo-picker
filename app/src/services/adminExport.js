import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { visiblePhotoCondition } from './visibility.js';
import { normalizePhotoFilter, photoFilterCondition, selectedByForPhotos, slotsForPhotos } from './photoFilters.js';

export function beijingDateStamp(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10).replaceAll('-', '');
}

export function sanitizeOrderName(name) {
  return String(name || '订单').replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || '订单';
}

function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }

export function resolveExportPhotos(db, jobId, { scope = 'selected', filter = 'all', ids = [] } = {}) {
  const selectors = db.prepare('select id,name from selector where job_id=? order by id').all(jobId);
  const normalized = normalizePhotoFilter(filter, selectors);
  const conditions = ['p.job_id=?', visiblePhotoCondition('p')];
  const params = [jobId];
  if (scope === 'selected') conditions.push('exists(select 1 from selection s where s.photo_id=p.id)');
  else if (scope === 'filter') conditions.push(photoFilterCondition(normalized));
  else if (scope === 'ids') {
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
    if (!wanted.length) return [];
    conditions.push(`p.id in (${wanted.map(() => '?').join(',')})`);
    params.push(...wanted);
  } else if (scope !== 'all') throw Object.assign(new Error('INVALID_EXPORT_SCOPE'), { code: 'INVALID_EXPORT_SCOPE' });
  return db.prepare(`select p.* from photo p where ${conditions.join(' and ')} order by p.sort,p.id`).all(...params);
}

export function exportCsvForPhotos(db, jobId, photos, options = {}) {
  const job = db.prepare('select * from job where id=?').get(jobId);
  const selectors = db.prepare('select * from selector where job_id=? order by id').all(jobId);
  const quota = db.prepare("select coalesce(sum(quantity),0) quantity from job_item where job_id=? and kind='retouch'").get(jobId).quantity;
  const selectedCount = db.prepare(`select count(distinct s.photo_id) count from selection s join selector u on u.id=s.selector_id join photo p on p.id=s.photo_id where u.job_id=? and ${visiblePhotoCondition('p')}`).get(jobId).count;
  const over = Math.max(0, selectedCount - quota);
  const amount = over * (job?.overage_unit_price || 20);
  const date = options.date || new Date();
  const lines = [
    ['订单名', job?.title || ''],
    ['导出时间', new Date(date.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19)],
    ['额度', `精修 ${quota} 张；已选 ${selectedCount} 张；超 ${over} 张 ¥${amount}`],
    ['选片人提交', selectors.map(selector => `${selector.name}：${selector.submitted_at || '未提交'}`).join('；')],
    [],
    ['显示名', '原始文件名', '选择人', '用途', '客户备注'],
  ];
  const selectedBy = selectedByForPhotos(db, photos.map(photo => photo.id));
  const slots = slotsForPhotos(db, photos.map(photo => photo.id));
  for (const photo of photos) {
    const notes = db.prepare('select n.content,u.name from photo_note n left join selector u on u.id=n.selector_id where n.photo_id=?').all(photo.id);
    lines.push([
      photo.display_name || photo.filename,
      photo.filename,
      (selectedBy.get(photo.id) || []).map(person => person.name).join('、'),
      (slots.get(photo.id) || []).map(slot => slot.name).join('、') || '精修',
      notes.map(note => `${note.name || '员工'}：${note.content}`).join('；'),
    ]);
  }
  return '\ufeff' + lines.map(row => row.map(csvCell).join(',')).join('\n') + '\n';
}

function uniqueArchiveName(folderState, originalName) {
  const ext = path.extname(originalName);
  const stem = path.basename(originalName, ext);
  let candidate = originalName;
  let n = 2;
  while (folderState.has(candidate)) candidate = `${stem}_${n++}${ext}`;
  folderState.add(candidate);
  return candidate;
}

export function nextExportName(db, dataDir, job, date) {
  const base = `${sanitizeOrderName(job.title)}_${beijingDateStamp(date)}`;
  const dir = path.join(dataDir, 'exports', String(job.id));
  fs.mkdirSync(dir, { recursive: true });
  const used = new Set(db.prepare("select export_name from download_package where job_id=? and kind='admin' and export_name is not null").all(job.id).map(row => row.export_name));
  let name = `${base}.zip`;
  let n = 2;
  while (used.has(name) || fs.existsSync(path.join(dir, name))) name = `${base}_${n++}.zip`;
  return { name, file: path.join(dir, name) };
}

export function adminExportView(row) {
  const { file_key, ...rest } = row;
  let meta = null;
  try { meta = row.meta ? JSON.parse(row.meta) : null; } catch {}
  return {
    ...rest,
    meta,
    file_url: row.status === 'ready' ? `/api/admin/jobs/${row.job_id}/exports/${row.id}/file` : null,
  };
}

export async function buildAdminExport({ db, dataDir, job, exportId, photos, groupByUse = true, includeCsv = true, date = new Date() }) {
  const row = db.prepare('select * from download_package where id=?').get(exportId);
  if (!row) throw new Error('EXPORT_NOT_FOUND');
  const file = row.file_key;
  const output = fs.createWriteStream(file);
  const finished = new Promise(resolve => { output.once('close', resolve); output.once('error', resolve); });
  const archive = archiver('zip', { store: true });
  const selectedBy = selectedByForPhotos(db, photos.map(photo => photo.id));
  const slots = slotsForPhotos(db, photos.map(photo => photo.id));
  const folderState = new Map();
  const missing = [];
  let bytesWritten = 0;
  let processed = 0;
  const update = (patch = {}) => {
    db.prepare('update download_package set progress=?,total=?,missing=?,meta=?,error=? where id=?').run(
      processed, photos.length, missing.length,
      JSON.stringify({ bytes_written: bytesWritten, missing: missing.length }),
      patch.error || null, exportId,
    );
  };
  archive.on('error', error => {
    try { db.prepare("update download_package set status='failed',error=? where id=?").run(String(error.code || 'EXPORT_FAILED'), exportId); } catch {}
    output.destroy();
  });
  output.on('error', () => {
    try { db.prepare("update download_package set status='failed',error='EXPORT_FAILED' where id=?").run(exportId); } catch {}
  });
  output.on('close', () => {
    try {
      db.prepare("update download_package set status='ready',progress=?,total=?,missing=?,meta=?,error=null where id=?").run(processed, photos.length, missing.length, JSON.stringify({ bytes_written: bytesWritten, missing: missing.length }), exportId);
    } catch {}
  });
  archive.pipe(output);
  const folder = name => {
    if (!folderState.has(name)) folderState.set(name, new Set());
    return folderState.get(name);
  };
  for (const photo of photos) {
    const original = photo.original_key;
    let exists = false;
    let size = 0;
    try { const stat = fs.statSync(original); exists = stat.isFile(); size = stat.size; } catch {}
    const slotsForPhoto = slots.get(photo.id) || [];
    const selected = (selectedBy.get(photo.id) || []).length > 0;
    if (!exists) {
      missing.push(`${photo.display_name || photo.filename}\t${photo.filename}`);
    } else {
      const folders = [];
      if (groupByUse) {
        if (selected) folders.push('精修');
        for (const slot of slotsForPhoto) folders.push(slot.name);
        if (!folders.length) folders.push('其他');
      } else folders.push('');
      for (const name of new Set(folders)) {
        const state = folder(name || '.');
        const target = uniqueArchiveName(state, photo.filename);
        archive.file(original, { name: name ? `${name}/${target}` : target });
        bytesWritten += size;
      }
    }
    processed += 1;
    update();
  }
  if (includeCsv) {
    archive.append(exportCsvForPhotos(db, job.id, photos, { date }), { name: '修图清单.csv' });
  }
  if (missing.length) archive.append(missing.join('\n') + '\n', { name: '缺失文件.txt' });
  await archive.finalize();
  await finished;
  return { file, missing: missing.length, bytes: bytesWritten };
}
