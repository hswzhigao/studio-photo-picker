import fs from 'node:fs';
import path from 'node:path';
import { readImageMetadata, sha256File, normalizeDisplayName, processPhoto } from './photoManager.js';

const EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif']);

export function scanSourceDirectory(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.name.startsWith('.') && EXTS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b, 'zh'));
}

export async function importPhotos({ db, jobId, sourceDir, dataDir, watermarkText, queue, onProgress }) {
  const files = scanSourceDirectory(sourceDir);
  let imported = 0;
  let failed = 0;
  let skipped = 0;
  let processed = 0;
  const ids = [];
  for (const file of files) {
    const filename = path.basename(file);
    try {
      const meta = await readImageMetadata(file);
      if (meta.error) throw Object.assign(new Error('INVALID_UPLOAD'), { code: 'INVALID_UPLOAD' });
      const sha256 = await sha256File(file);
      const duplicate = db.prepare('select id from photo where job_id=? and sha256=? and deleted_at is null').get(jobId, sha256);
      if (duplicate) {
        skipped += 1;
        processed += 1;
        onProgress?.({ processed, imported, failed, skipped });
        continue;
      }
      const size = fs.statSync(file).size;
      const sort = db.prepare('select coalesce(max(sort),-1)+1 sort from photo where job_id=?').get(jobId).sort;
      const now = new Date().toISOString();
      const result = db.prepare('insert into photo(job_id,filename,display_name,original_key,source,sha256,size_bytes,width,height,taken_at,sort,import_status,version,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(jobId, filename, normalizeDisplayName(filename), file, 'import', sha256, size, meta.width, meta.height, meta.takenAt, sort, 'processing', 1, now, now);
      ids.push(Number(result.lastInsertRowid));
      imported += 1;
      if (queue) queue.enqueue(result.lastInsertRowid);
      else await processPhoto(db, { dataDir, watermarkText }, result.lastInsertRowid);
    } catch (error) {
      failed += 1;
    }
    processed += 1;
    onProgress?.({ processed, imported, failed, skipped });
  }
  return { total: files.length, imported, skipped, failed, ids };
}
