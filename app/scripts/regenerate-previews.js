import path from 'node:path';
import { getDb, initializeDatabase } from '../src/db/connection.js';
import { processPhoto } from '../src/services/photoManager.js';

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), '..', 'data'));
const watermarkText = process.env.WATERMARK_TEXT || '名人婚纱 · 预览';
const db = getDb(dataDir);
initializeDatabase(db);
const photos = db.prepare("select id from photo where deleted_at is null and import_status='ready' order by id").all();
let done = 0, missing = 0, failed = 0;
for (const photo of photos) {
  try {
    const result = await processPhoto(db, { dataDir, watermarkText }, photo.id);
    if (result) done += 1;
    else failed += 1;
  } catch (error) {
    if (/ENOENT|no such file/i.test(String(error.message))) missing += 1;
    else failed += 1;
    console.error(`照片 #${photo.id} 失败：${error.message}`);
  }
}
db.close();
console.log(`预览图重建完成：成功 ${done}，原图缺失 ${missing}，失败 ${failed}。`);
if (failed || missing) process.exitCode = 1;
